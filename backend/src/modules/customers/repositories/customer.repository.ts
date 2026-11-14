import type {PoolConnection,RowDataPacket,ResultSetHeader} from 'mysql2/promise';
import {createHash} from 'node:crypto';
import {AppError} from '../../../core/errors/AppError';
import type {TenantContext} from '../../../core/tenant/tenantContext';
import {dbId} from '../../sales/schemas/sales.schema';
import type {accountBody,contactBody,accountPatch,contactPatch,activityBody,duplicatesQuery} from '../schemas/customer.schema';

export type Db=Pick<PoolConnection,'execute'|'beginTransaction'|'commit'|'rollback'|'release'|'destroy'>;
interface Rec extends RowDataPacket {
 id:string|number|bigint;owner_user_id:string|number|bigint|null;
 revision?:string; account_id?:string|number|bigint|null;
 first_name?:string;last_name?:string|null;email?:string|null;phone?:string|null;
 name?:string;website?:string|null;marketing_opt_in?:number;
}
const MAX_MATCHES=100;
function scope(t:TenantContext,alias:string){
 if(t.role==='OWNER')return {sql:'1=1',args:[] as string[]};
 if(t.role==='EMPLOYEE')return {sql:`${alias}.owner_user_id=?`,args:[t.actorUserId]};
 return {sql:`(${alias}.owner_user_id=? OR EXISTS(SELECT 1 FROM team_members tm JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id WHERE tm.company_id=${alias}.company_id AND tm.user_id=${alias}.owner_user_id AND tm.left_at IS NULL AND tm.joined_at<=UTC_TIMESTAMP(3) AND te.manager_user_id=? AND te.status='active'))`,args:[t.actorUserId,t.actorUserId]};
}
async function managerCanSee(db:Db,t:TenantContext,raw:string|number|bigint|null){
 if(t.role==='OWNER')return true;
 if(raw===null)return false;
 const owner=dbId(raw);
 if(owner===t.actorUserId)return true;
 if(t.role==='EMPLOYEE')return false;
 const [rows]=await db.execute<Rec[]>(`SELECT tm.id FROM team_members tm JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id WHERE tm.company_id=? AND tm.user_id=? AND tm.left_at IS NULL AND tm.joined_at<=UTC_TIMESTAMP(3) AND te.manager_user_id=? AND te.status='active' LIMIT 1`,[t.companyId,owner,t.actorUserId]);
 return rows.length>0;
}
export async function visible(db:Db,t:TenantContext,table:'accounts'|'contacts',entityId:string,lock=false){
 const [rows]=await db.execute<Rec[]>(`SELECT *,DATE_FORMAT(updated_at,'%Y-%m-%dT%H:%i:%s.%f') AS revision FROM ${table} WHERE company_id=? AND id=? LIMIT 1 ${lock?'FOR UPDATE':''}`,[t.companyId,entityId]);
 const rec=rows[0];if(!rec || !await managerCanSee(db,t,rec.owner_user_id))throw AppError.notFound();
 return rec;
}
export async function companyLock(db:Db,t:TenantContext){
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT id FROM companies WHERE id=? LIMIT 1 FOR UPDATE`,[t.companyId]);
 if(!rows.length)throw AppError.forbidden();
}
async function audit(db:Db,t:TenantContext,action:string,type:string,entityId:string,rid:string|null,meta:Record<string,unknown>={}){
 await db.execute(`INSERT INTO audit_logs(company_id,actor_user_id,action,entity_type,entity_id,outcome,request_id,details_json,occurred_at) VALUES(?,?,?,?,?,'success',?,?,UTC_TIMESTAMP(3))`,[t.companyId,t.actorUserId,action,type,entityId,rid,JSON.stringify(meta)]);
}
export async function appendEvent(db:Db,t:TenantContext,type:'contact'|'account',entityId:string,event:string,summary:string){
 await db.execute(`INSERT INTO activity_events(company_id,entity_type,entity_id,actor_user_id,event_type,occurred_at,public_summary) VALUES(?,?,?,?,?,UTC_TIMESTAMP(3),?)`,[t.companyId,type,entityId,t.actorUserId,event,summary]);
}
async function noDuplicateAccount(db:Db,t:TenantContext,name:string,email:string|null,except:string|null){
 const [rows]=await db.execute<Rec[]>(`SELECT id FROM accounts WHERE company_id=? AND (? IS NULL OR id<>?) AND (LOWER(TRIM(name))=? OR (? IS NOT NULL AND LOWER(TRIM(email))=?)) LIMIT 1`,[t.companyId,except,except,name.toLowerCase(),email,email]);
 if(rows.length)throw AppError.conflict();
}
export async function duplicateContactExists(db:Db,t:TenantContext,email:string|null,phone:string|null,except:string|null){
 const [rows]=await db.execute<Rec[]>(`SELECT id FROM contacts WHERE company_id=? AND (? IS NULL OR id<>?) AND ((? IS NOT NULL AND LOWER(TRIM(email))=?) OR (? IS NOT NULL AND phone=?)) LIMIT 1`,[t.companyId,except,except,email,email,phone,phone]);
 return rows.length>0;
}
export async function noDuplicateContact(db:Db,t:TenantContext,email:string|null,phone:string|null,except:string|null){
 if(await duplicateContactExists(db,t,email,phone,except))throw AppError.conflict();
}
async function requireAccountLink(db:Db,t:TenantContext,accountId:string|null){if(accountId!==null)await visible(db,t,'accounts',accountId);}
export async function listAccounts(db:Db,t:TenantContext,n:number){
 const s=scope(t,'a');const [rows]=await db.execute<Rec[]>(`SELECT a.id,a.name,a.email,a.phone,a.website,a.owner_user_id,DATE_FORMAT(a.updated_at,'%Y-%m-%dT%H:%i:%s.%f') AS revision FROM accounts a WHERE a.company_id=? AND ${s.sql} ORDER BY a.id DESC LIMIT ?`,[t.companyId,...s.args,n]);
 return rows.map(r=>({id:dbId(r.id),name:r.name,email:r.email,phone:r.phone,website:r.website,ownerUserId:r.owner_user_id===null?null:dbId(r.owner_user_id),revision:r.revision}));
}
export async function getAccount(db:Db,t:TenantContext,accountId:string){
 const r=await visible(db,t,'accounts',accountId);return {id:accountId,name:r.name,email:r.email,phone:r.phone,website:r.website,ownerUserId:r.owner_user_id===null?null:dbId(r.owner_user_id),revision:r.revision};
}
export async function createAccount(db:Db,t:TenantContext,v:ReturnType<typeof accountBody>,rid:string|null){
 await companyLock(db,t);await noDuplicateAccount(db,t,v.name,v.email,null);
 const [made]=await db.execute<ResultSetHeader>(`INSERT INTO accounts(company_id,name,email,phone,website,owner_user_id) VALUES(?,?,?,?,?,?)`,[t.companyId,v.name,v.email,v.phone,v.website,t.actorUserId]);
 const entityId=dbId(made.insertId);await appendEvent(db,t,'account',entityId,'account.created','Account record created');await audit(db,t,'account.created','account',entityId,rid);
 return {id:entityId,name:v.name,ownerUserId:t.actorUserId};
}
export async function updateAccount(db:Db,t:TenantContext,accountId:string,v:ReturnType<typeof accountPatch>,rid:string|null){
 await companyLock(db,t);const old=await visible(db,t,'accounts',accountId,true);if(old.revision!==v.expectedRevision)throw AppError.conflict();
 const nextName=v.changes.name===undefined?old.name!:v.changes.name;
 const nextEmail=v.changes.email===undefined?old.email??null:v.changes.email;
 await noDuplicateAccount(db,t,nextName!,nextEmail,accountId);
 const columns:Record<string,string>={name:'name',email:'email',phone:'phone',website:'website'};
 const entries=Object.entries(v.changes);
 const sets=entries.map(([k])=>`${columns[k]}=?`).join(',');
 await db.execute(`UPDATE accounts SET ${sets},updated_at=GREATEST(DATE_ADD(updated_at,INTERVAL 1000 MICROSECOND),UTC_TIMESTAMP(3)) WHERE company_id=? AND id=?`,[...entries.map(([,x])=>x),t.companyId,accountId]);
 await appendEvent(db,t,'account',accountId,'account.updated','Account details updated');await audit(db,t,'account.updated','account',accountId,rid,{fields:entries.map(([k])=>k)});
 return {id:accountId,updatedFields:entries.map(([k])=>k)};
}
export async function listContacts(db:Db,t:TenantContext,n:number){
 const s=scope(t,'c');const [rows]=await db.execute<Rec[]>(`SELECT c.id,c.first_name,c.last_name,c.email,c.phone,c.account_id,c.owner_user_id,c.marketing_opt_in,DATE_FORMAT(c.updated_at,'%Y-%m-%dT%H:%i:%s.%f') AS revision FROM contacts c WHERE c.company_id=? AND ${s.sql} ORDER BY c.id DESC LIMIT ?`,[t.companyId,...s.args,n]);
 return rows.map(mapContact);
}
function mapContact(r:Rec){return {id:dbId(r.id),firstName:r.first_name,lastName:r.last_name,email:r.email,phone:r.phone,accountId:r.account_id==null?null:dbId(r.account_id),ownerUserId:r.owner_user_id==null?null:dbId(r.owner_user_id),marketingOptIn:Boolean(r.marketing_opt_in),revision:r.revision};}
export async function getContact(db:Db,t:TenantContext,contactId:string){return mapContact(await visible(db,t,'contacts',contactId));}
export async function createContact(db:Db,t:TenantContext,v:ReturnType<typeof contactBody>,rid:string|null){
 await companyLock(db,t);await requireAccountLink(db,t,v.accountId);await noDuplicateContact(db,t,v.email,v.phone,null);
 const [result]=await db.execute<ResultSetHeader>(`INSERT INTO contacts(company_id,account_id,first_name,last_name,email,phone,owner_user_id,marketing_opt_in) VALUES(?,?,?,?,?,?,?,?)`,[t.companyId,v.accountId,v.firstName,v.lastName,v.email,v.phone,t.actorUserId,v.marketingOptIn?1:0]);
 const contactId=dbId(result.insertId);await appendEvent(db,t,'contact',contactId,'contact.created','Contact record created');await audit(db,t,'contact.created','contact',contactId,rid,{hasAccount:v.accountId!==null});
 return {id:contactId,ownerUserId:t.actorUserId,accountId:v.accountId};
}
export async function updateContact(db:Db,t:TenantContext,contactId:string,v:ReturnType<typeof contactPatch>,rid:string|null){
 await companyLock(db,t);const old=await visible(db,t,'contacts',contactId,true);if(old.revision!==v.expectedRevision)throw AppError.conflict();
 const e=v.changes.email===undefined?old.email??null:v.changes.email as string|null;
 const p=v.changes.phone===undefined?old.phone??null:v.changes.phone as string|null;
 if(!e&&!p)throw AppError.badRequest();
 const acc=v.changes.accountId===undefined?old.account_id===null||old.account_id===undefined?null:dbId(old.account_id):v.changes.accountId as string|null;
 await requireAccountLink(db,t,acc);await noDuplicateContact(db,t,e,p,contactId);
 const columns:Record<string,string>={firstName:'first_name',lastName:'last_name',email:'email',phone:'phone',accountId:'account_id',marketingOptIn:'marketing_opt_in'};
 const entries=Object.entries(v.changes);
 const sets=entries.map(([k])=>`${columns[k]}=?`).join(',');
 await db.execute(`UPDATE contacts SET ${sets},updated_at=GREATEST(DATE_ADD(updated_at,INTERVAL 1000 MICROSECOND),UTC_TIMESTAMP(3)) WHERE company_id=? AND id=?`,[...entries.map(([k,x])=>k==='marketingOptIn'?(x?1:0):x as string|null),t.companyId,contactId]);
 await appendEvent(db,t,'contact',contactId,'contact.updated','Contact details updated');await audit(db,t,'contact.updated','contact',contactId,rid,{fields:entries.map(([k])=>k)});
 return {id:contactId,updatedFields:entries.map(([k])=>k)};
}
export async function accountContacts(db:Db,t:TenantContext,accountId:string,n:number){
 await visible(db,t,'accounts',accountId);const s=scope(t,'c');const [rows]=await db.execute<Rec[]>(`SELECT c.id,c.first_name,c.last_name,c.email,c.phone,c.account_id,c.owner_user_id,c.marketing_opt_in,DATE_FORMAT(c.updated_at,'%Y-%m-%dT%H:%i:%s.%f') AS revision FROM contacts c WHERE c.company_id=? AND c.account_id=? AND ${s.sql} ORDER BY c.id DESC LIMIT ?`,[t.companyId,accountId,...s.args,n]);return rows.map(mapContact);
}
export async function contactDuplicates(db:Db,t:TenantContext,q:ReturnType<typeof duplicatesQuery>){
 const s=scope(t,'c');const [rows]=await db.execute<Rec[]>(`SELECT c.id,c.first_name,c.last_name,c.owner_user_id FROM contacts c WHERE c.company_id=? AND ${s.sql} AND ((? IS NOT NULL AND LOWER(TRIM(c.email))=?) OR (? IS NOT NULL AND c.phone=?)) ORDER BY c.id DESC LIMIT ?`,[t.companyId,...s.args,q.email,q.email,q.phone,q.phone,Math.min(q.limit,MAX_MATCHES)]);
 return rows.map(r=>({id:dbId(r.id),firstName:r.first_name,lastName:r.last_name,ownerUserId:r.owner_user_id===null?null:dbId(r.owner_user_id!)}));
}
export async function contactActivity(db:Db,t:TenantContext,contactId:string,v:ReturnType<typeof activityBody>,rid:string|null){
 await visible(db,t,'contacts',contactId,true);
 const [res]=await db.execute<ResultSetHeader>(`INSERT INTO activity_events(company_id,entity_type,entity_id,actor_user_id,event_type,occurred_at,public_summary) VALUES(?,'contact',?,?,?,UTC_TIMESTAMP(3),?)`,[t.companyId,contactId,t.actorUserId,`contact.${v.type}`,v.summary]);
 const eventId=dbId(res.insertId);await audit(db,t,`contact.activity_${v.type}`,'contact',contactId,rid,{activityEventId:eventId});
 return {id:eventId,contactId,type:v.type};
}
export async function timeline(db:Db,t:TenantContext,contactId:string,n:number){
 await visible(db,t,'contacts',contactId);
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT id,event_type,actor_user_id,public_summary,DATE_FORMAT(occurred_at,'%Y-%m-%dT%H:%i:%s.%f') AS occurred_at FROM activity_events WHERE company_id=? AND entity_type='contact' AND entity_id=? ORDER BY occurred_at DESC,id DESC LIMIT ?`,[t.companyId,contactId,n]);
 return rows.map(r=>({id:dbId(r.id),type:r.event_type,actorUserId:r.actor_user_id==null?null:dbId(r.actor_user_id),summary:r.public_summary,occurredAt:r.occurred_at}));
}
export async function readImport(db:Db,t:TenantContext,importId:string){
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT id,entity_type,status,total_rows,successful_rows,failed_rows,duplicate_strategy,validation_only,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%f') AS created_at FROM import_jobs WHERE company_id=? AND id=? AND requested_by_id=? LIMIT 1`,[t.companyId,importId,t.actorUserId]);if(!rows.length)throw AppError.notFound();const x=rows[0]!;return{id:dbId(x.id),entityType:x.entity_type,status:x.status,totalRows:Number(x.total_rows),successfulRows:Number(x.successful_rows),failedRows:Number(x.failed_rows),strategy:x.duplicate_strategy,validationOnly:Boolean(x.validation_only),createdAt:x.created_at};
}
export async function writeImportJob(db:Db,t:TenantContext,hash:string,strategy:string,mapping:Record<string,string>,key:string,total:number,success:number,failed:number,rid:string|null){
 const [res]=await db.execute<ResultSetHeader>(`INSERT INTO import_jobs(company_id,entity_type,requested_by_id,source_file_key,status,total_rows,import_format,duplicate_strategy,validation_only,column_mapping_json,idempotency_key,successful_rows,failed_rows,completed_at) VALUES(?,'contact',?,?,'completed',?,'CSV',?,0,?,?,?,?,UTC_TIMESTAMP(3))`,[t.companyId,t.actorUserId,`inline:sha256:${hash}`,total,strategy,JSON.stringify(mapping),key,success,failed]);
 const importId=dbId(res.insertId);await audit(db,t,'contact.import_completed','import_job',importId,rid,{totalRows:total,createdRows:success,skippedRows:failed});return importId;
}
export function sha256(csv:string){return createHash('sha256').update(csv,'utf8').digest('hex');}