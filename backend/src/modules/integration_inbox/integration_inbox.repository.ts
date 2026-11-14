import type {PoolConnection,RowDataPacket,ResultSetHeader} from 'mysql2/promise';
import type {TenantContext} from '../../core/tenant/tenantContext';
import {AppError} from '../../core/errors/AppError';
import {id} from './integration_inbox.schema';

export type Db=Pick<PoolConnection,'execute'|'beginTransaction'|'commit'|'rollback'|'release'|'destroy'>;
interface Connection extends RowDataPacket{id:string|number|bigint;status:string;credential_secret_ref:string|null;}
interface Webhook extends RowDataPacket{id:string|number|bigint;payload_hash:string;status:string;}
export async function audit(db:Db,companyId:string,actorId:string|null,action:string,entityType:string,entityId:string,metadata:object){
 await db.execute(`INSERT INTO audit_logs(company_id,actor_user_id,action,entity_type,entity_id,outcome,request_id,details_json,occurred_at)
 VALUES(?,?,?,?,?,'success',NULL,?,UTC_TIMESTAMP(3))`,[companyId,actorId,action,entityType,entityId,JSON.stringify(metadata)]);
}
async function currentActor(db:Db,t:TenantContext){
 const [users]=await db.execute<RowDataPacket[]>(`SELECT role,status FROM users WHERE company_id=? AND id=? LIMIT 1`,[t.companyId,t.actorUserId]);
 if(!users[0]||users[0].status!=='active'||users[0].role!=='owner'||t.role!=='OWNER')throw AppError.forbidden();
}
export async function listConnections(db:Db,t:TenantContext,q:{limit:number}){
 await currentActor(db,t);
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT id,provider_key AS providerKey,display_name AS displayName,status,
 DATE_FORMAT(updated_at,'%Y-%m-%dT%H:%i:%s.%f') AS revision
 FROM integration_connections WHERE company_id=? ORDER BY id DESC LIMIT ?`,[t.companyId,q.limit]);
 return {items:rows.map(row=>({...row,id:id(row.id)}))};
}
export async function createConnection(db:Db,t:TenantContext,x:{providerKey:string;displayName:string}){
 await currentActor(db,t);
 const [result]=await db.execute<ResultSetHeader>(`INSERT INTO integration_connections(company_id,provider_key,display_name,status,configured_by_id)
 VALUES(?,?,?,'disabled',?)`,[t.companyId,x.providerKey,x.displayName,t.actorUserId]);
 const connectionId=id(result.insertId);
 await audit(db,t.companyId,t.actorUserId,'integration.connection.registered','integration_connection',connectionId,{providerKey:x.providerKey,status:'disabled'});
 return {connectionId,providerKey:x.providerKey,status:'disabled',credentialsConfigured:false};
}
export async function listWebhooks(db:Db,t:TenantContext,q:{limit:number;providerKey:string|null}){
 await currentActor(db,t);
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT id,provider_key AS providerKey,event_id AS eventId,status,
 DATE_FORMAT(received_at,'%Y-%m-%dT%H:%i:%s.%f') AS receivedAt
 FROM crm_webhook_events WHERE company_id=? AND (? IS NULL OR provider_key=?) ORDER BY id DESC LIMIT ?`,
 [t.companyId,q.providerKey,q.providerKey,q.limit]);
 return {items:rows.map(row=>({...row,id:id(row.id)}))};
}
export async function listInboundJobs(db:Db,t:TenantContext,q:{limit:number}){
 await currentActor(db,t);
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT id,state,attempts,DATE_FORMAT(run_after,'%Y-%m-%dT%H:%i:%s.%f') AS runAfter
 FROM crm_background_jobs WHERE company_id=? AND job_type='integration.webhook.received' ORDER BY id DESC LIMIT ?`,[t.companyId,q.limit]);
 return {items:rows.map(row=>({...row,id:id(row.id)}))};
}
// Caller MUST be a trusted transport adapter that already mapped the provider to its company.
// The secret never comes from the client request or a persisted webhook body.
export async function insertVerifiedReceipt(db:Db,x:{companyId:string;providerKey:string;eventId:string;payloadHash:string}){
 const [connections]=await db.execute<Connection[]>(`SELECT id,status,credential_secret_ref FROM integration_connections
 WHERE company_id=? AND provider_key=? LIMIT 1 FOR UPDATE`,[x.companyId,x.providerKey]);
 const connection=connections[0];
 if(!connection||connection.status!=='active'||!connection.credential_secret_ref)throw AppError.forbidden();
 const [existing]=await db.execute<Webhook[]>(`SELECT id,payload_hash,status FROM crm_webhook_events
 WHERE company_id=? AND provider_key=? AND event_id=? LIMIT 1 FOR UPDATE`,[x.companyId,x.providerKey,x.eventId]);
 const previous=existing[0];
 if(previous){
  if(previous.payload_hash!==x.payloadHash)throw AppError.conflict();
  return {eventRecordId:id(previous.id),alreadyReceived:true,jobQueued:false};
 }
 const [result]=await db.execute<ResultSetHeader>(`INSERT INTO crm_webhook_events
 (company_id,provider_key,event_id,payload_hash,status,received_at)
 VALUES(?,?,?,?,'received',UTC_TIMESTAMP(3))`,[x.companyId,x.providerKey,x.eventId,x.payloadHash]);
 const eventRecordId=id(result.insertId);
 // No raw payload or provider credentials are written to the queue.
 await db.execute(`INSERT INTO crm_background_jobs(company_id,job_type,idempotency_key,payload_json,state,run_after)
 VALUES(?,'integration.webhook.received',?,?,'pending',UTC_TIMESTAMP(3))`,
 [x.companyId,`receipt:${eventRecordId}`,JSON.stringify({eventRecordId,providerKey:x.providerKey})]);
 await audit(db,x.companyId,null,'integration.webhook.received','crm_webhook_event',eventRecordId,{providerKey:x.providerKey});
 return {eventRecordId,alreadyReceived:false,jobQueued:true};
}