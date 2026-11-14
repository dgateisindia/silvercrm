import {createHash} from 'node:crypto';
import type {PoolConnection,RowDataPacket,ResultSetHeader} from 'mysql2/promise';
import type {TenantContext} from '../../core/tenant/tenantContext';
import {AppError} from '../../core/errors/AppError';
import {id} from '../lead_import/lead_import.schema';
import type {BulkRequest} from './bulk_import.schema';
import type {BulkLeadRow} from './bulk_import.parser';

export type Db=Pick<PoolConnection,'execute'|'beginTransaction'|'commit'|'rollback'|'release'|'destroy'>;
interface Person extends RowDataPacket {id:string|number|bigint;role:string;status:string;}
interface Contact extends RowDataPacket {id:string|number|bigint;owner_user_id:string|number|bigint|null;}
interface Choice extends RowDataPacket {field_key:string;option_key:string;is_active:number|string|boolean;}
interface Job extends RowDataPacket {id:string|number|bigint;company_id:string|number|bigint;source_file_key:string;requested_by_id:string|number|bigint;status:string;total_rows:number;successful_rows:number;failed_rows:number;}
interface ChunkJob extends RowDataPacket {id:string|number|bigint;company_id:string|number|bigint;state:string;attempts:number;payload_json:unknown;}
interface ChunkData {importJobId:string;ownerUserId:string;actorUserId:string;rows:BulkLeadRow[];}
const JOB_TYPE='lead.bulk_import.chunk';
const BATCH=50;

async function actor(db:Db,companyId:string,actorId:string,role:string){
 const [rows]=await db.execute<Person[]>(`SELECT id,role,status FROM users WHERE company_id=? AND id=? LIMIT 1`,[companyId,actorId]);
 if(!rows[0]||rows[0].status!=='active'||rows[0].role!==role.toLowerCase())throw AppError.forbidden();
}
async function eligibleOwner(db:Db,companyId:string,actorId:string,role:string,ownerId:string){
 if(role==='OWNER')throw AppError.forbidden();
 if(role==='EMPLOYEE'&&ownerId!==actorId)throw AppError.forbidden();
 if(role==='MANAGER'&&ownerId!==actorId){
  const [team]=await db.execute<RowDataPacket[]>(`SELECT tm.id FROM team_members tm
   JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id
   JOIN users u ON u.company_id=tm.company_id AND u.id=tm.user_id
   WHERE tm.company_id=? AND tm.user_id=? AND tm.left_at IS NULL
   AND tm.joined_at<=UTC_TIMESTAMP(3) AND te.status='active' AND te.manager_user_id=?
   AND u.role='employee' AND u.status='active' LIMIT 1`,[companyId,ownerId,actorId]);
  if(!team.length)throw AppError.notFound();
 }
 const [owners]=await db.execute<Person[]>(`SELECT id,role,status FROM users WHERE company_id=? AND id=? LIMIT 1`,[companyId,ownerId]);
 if(!owners[0]||owners[0].status!=='active'||owners[0].role==='owner')throw AppError.notFound();
}
async function choices(db:Db,companyId:string){
 const [rows]=await db.execute<Choice[]>(`SELECT field_key,option_key,is_active FROM picklist_options
 WHERE company_id=? AND entity_type='lead' AND field_key IN ('status','priority')`,[companyId]);
 const allowed=new Map<string,Set<string>>();const configured=new Set<string>();
 for(const r of rows){configured.add(r.field_key);if(!allowed.has(r.field_key))allowed.set(r.field_key,new Set());
  if(r.is_active===1||r.is_active===true||r.is_active==='1')allowed.get(r.field_key)!.add(r.option_key);}
 return {allowed,configured};
}
async function inspectRows(db:Db,companyId:string,ownerId:string,rows:BulkLeadRow[],strictDuplicates:boolean){
 const opts=await choices(db,companyId);
 const seen=new Set<string>();let duplicates=0;
 for(const row of rows){
  for(const field of ['status','priority'] as const){if(opts.configured.has(field)&&!opts.allowed.get(field)?.has(row[field]))throw AppError.badRequest();}
  const [contacts]=await db.execute<Contact[]>(`SELECT id,owner_user_id FROM contacts WHERE company_id=? AND id=? LIMIT 1`,[companyId,row.contactId]);
  if(!contacts[0]||String(contacts[0].owner_user_id??'')!==ownerId)throw AppError.notFound();
  const key=`${row.contactId}\u0000${row.title.toLowerCase()}`;
  const [found]=await db.execute<RowDataPacket[]>(`SELECT id FROM leads WHERE company_id=? AND contact_id=?
  AND LOWER(TRIM(title))=LOWER(?) LIMIT 1`,[companyId,row.contactId,row.title]);
  if(seen.has(key)||found.length)duplicates++;
  seen.add(key);
 }
 if(strictDuplicates&&duplicates)throw AppError.conflict();
 return {duplicates,wouldCreate:rows.length-duplicates};
}
function fingerprint(x:BulkRequest,ownerId:string){
 return createHash('sha256').update(JSON.stringify({format:x.format,source:x.format==='CSV'?x.csv:x.xlsxBase64,mapping:x.mapping,ownerId,strategy:x.duplicateStrategy})).digest('hex');
}
async function audit(db:Db,companyId:string,actorId:string,action:string,jobId:string,details:object){
 await db.execute(`INSERT INTO audit_logs(company_id,actor_user_id,action,entity_type,entity_id,outcome,request_id,details_json,occurred_at)
 VALUES(?,?,?,'import_job',?,'success',NULL,?,UTC_TIMESTAMP(3))`,[companyId,actorId,action,jobId,JSON.stringify(details)]);
}
export async function previewBulk(db:Db,t:TenantContext,rows:BulkLeadRow[],x:BulkRequest){
 await actor(db,t.companyId,t.actorUserId,t.role);
 const ownerId=x.ownerUserId??t.actorUserId;
 await eligibleOwner(db,t.companyId,t.actorUserId,t.role,ownerId);
 const review=await inspectRows(db,t.companyId,ownerId,rows,false);
 return {validationOnly:true,format:x.format,totalRows:rows.length,duplicatesAtPreview:review.duplicates,wouldCreate:review.wouldCreate,maximumRows:500,duplicateStrategy:'SKIP' as const};
}
export async function queueBulk(db:Db,t:TenantContext,rows:BulkLeadRow[],x:BulkRequest){
 const ownerId=x.ownerUserId??t.actorUserId;
 const [company]=await db.execute<RowDataPacket[]>(`SELECT id FROM companies WHERE id=? AND status='active' AND platform_access_mode='FULL' FOR UPDATE`,[t.companyId]);
 if(!company.length)throw AppError.forbidden();
 await actor(db,t.companyId,t.actorUserId,t.role);
 await eligibleOwner(db,t.companyId,t.actorUserId,t.role,ownerId);
 const hash=fingerprint(x,ownerId);
 const [old]=await db.execute<Job[]>(`SELECT id,company_id,source_file_key,requested_by_id,status,total_rows,successful_rows,failed_rows FROM import_jobs
 WHERE company_id=? AND idempotency_key=? LIMIT 1 FOR UPDATE`,[t.companyId,x.idempotencyKey]);
 if(old[0]){
  if(old[0].source_file_key!==hash||String(old[0].requested_by_id)!==t.actorUserId)throw AppError.conflict();
  return {id:id(old[0].id),status:old[0].status,totalRows:Number(old[0].total_rows),replayed:true,duplicateStrategy:'SKIP' as const};
 }
 await inspectRows(db,t.companyId,ownerId,rows,false);
 const [added]=await db.execute<ResultSetHeader>(`INSERT INTO import_jobs
 (company_id,entity_type,requested_by_id,source_file_key,status,total_rows,import_format,duplicate_strategy,validation_only,column_mapping_json,idempotency_key,successful_rows,failed_rows)
 VALUES(?,'lead',?,?,'queued',?,?,'SKIP',0,?,?,0,0)`,
 [t.companyId,t.actorUserId,hash,rows.length,x.format,JSON.stringify(x.mapping),x.idempotencyKey]);
 const importId=id(added.insertId);
 for(let start=0;start<rows.length;start+=BATCH){
  const segment=rows.slice(start,start+BATCH);
  const placeholders=segment.map(()=>'(? , ? , ? , \'pending\')').join(',');
  const params=segment.flatMap(r=>[t.companyId,importId,r.row]);
  await db.execute(`INSERT INTO crm_import_rows(company_id,import_job_id,row_no,state) VALUES ${placeholders}`,params);
  const payload:ChunkData={importJobId:importId,ownerUserId:ownerId,actorUserId:t.actorUserId,rows:segment};
  await db.execute(`INSERT INTO crm_background_jobs(company_id,job_type,idempotency_key,payload_json,state,attempts,run_after)
   VALUES(?,?,?,?, 'pending',0,UTC_TIMESTAMP(3))`,
  [t.companyId,JOB_TYPE,`lead-import:${importId}:${start/BATCH}`,JSON.stringify(payload)]);
 }
 await audit(db,t.companyId,t.actorUserId,'lead.bulk_import.queued',importId,{format:x.format,totalRows:rows.length,chunks:Math.ceil(rows.length/BATCH)});
 return {id:importId,status:'queued',totalRows:rows.length,replayed:false,duplicateStrategy:'SKIP' as const};
}
export async function bulkStatus(db:Db,t:TenantContext,jobId:string){
 await actor(db,t.companyId,t.actorUserId,t.role);
 const [jobs]=await db.execute<Job[]>(`SELECT id,company_id,source_file_key,requested_by_id,status,total_rows,successful_rows,failed_rows
 FROM import_jobs WHERE company_id=? AND id=? AND entity_type='lead' LIMIT 1`,[t.companyId,jobId]);
 const job=jobs[0];if(!job)throw AppError.notFound();
 if(t.role!=='OWNER'&&String(job.requested_by_id)!==t.actorUserId){
  if(t.role!=='MANAGER')throw AppError.notFound();
  const [team]=await db.execute<RowDataPacket[]>(`SELECT tm.id FROM team_members tm
  JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id
  WHERE tm.company_id=? AND tm.user_id=? AND tm.left_at IS NULL AND tm.joined_at<=UTC_TIMESTAMP(3)
  AND te.status='active' AND te.manager_user_id=? LIMIT 1`,[t.companyId,String(job.requested_by_id),t.actorUserId]);
  if(!team.length)throw AppError.notFound();
 }
 const [states]=await db.execute<RowDataPacket[]>(`SELECT state,COUNT(*) AS total FROM crm_import_rows
 WHERE company_id=? AND import_job_id=? GROUP BY state`,[t.companyId,jobId]);
 return {id:jobId,status:job.status,totalRows:Number(job.total_rows),created:Number(job.successful_rows),skippedOrFailed:Number(job.failed_rows),processed:Number(job.successful_rows)+Number(job.failed_rows),rowStates:states.map(x=>({state:x.state,count:Number(x.total)}))};
}
export async function candidate(db:Db):Promise<{id:string;companyId:string}|null>{
 const [jobs]=await db.execute<ChunkJob[]>(`SELECT id,company_id FROM crm_background_jobs
 WHERE job_type=? AND state='pending' AND run_after<=UTC_TIMESTAMP(3) ORDER BY id LIMIT 1`,[JOB_TYPE]);
 return jobs[0]?{id:id(jobs[0].id),companyId:id(jobs[0].company_id)}:null;
}
function payloadJson(raw:unknown):ChunkData{
 let obj:unknown=raw;
 if(typeof raw==='string'){try{obj=JSON.parse(raw);}catch{throw Error('INVALID_STORED_JOB_PAYLOAD');}}
 if(!obj||typeof obj!=='object'||Array.isArray(obj))throw Error('INVALID_STORED_JOB_PAYLOAD');
 const value=obj as Partial<ChunkData>;
 if(typeof value.importJobId!=='string'||typeof value.ownerUserId!=='string'||typeof value.actorUserId!=='string'||!Array.isArray(value.rows)||value.rows.length<1||value.rows.length>BATCH)throw Error('INVALID_STORED_JOB_PAYLOAD');
 return value as ChunkData;
}
export async function processChunk(db:Db,which:{id:string;companyId:string}){
 const [company]=await db.execute<RowDataPacket[]>(`SELECT id FROM companies WHERE id=? AND status='active' AND platform_access_mode='FULL' FOR UPDATE`,[which.companyId]);
 if(!company.length)throw AppError.forbidden();
 const [jobs]=await db.execute<ChunkJob[]>(`SELECT id,company_id,state,attempts,payload_json FROM crm_background_jobs
 WHERE id=? AND company_id=? AND job_type=? LIMIT 1 FOR UPDATE`,[which.id,which.companyId,JOB_TYPE]);
 const job=jobs[0];if(!job||job.state!=='pending')return 'none' as const;
 const x=payloadJson(job.payload_json);
 const [imports]=await db.execute<Job[]>(`SELECT id,company_id,source_file_key,requested_by_id,status,total_rows,successful_rows,failed_rows
 FROM import_jobs WHERE id=? AND company_id=? AND entity_type='lead' LIMIT 1 FOR UPDATE`,[x.importJobId,which.companyId]);
 const imp=imports[0];if(!imp||!['queued','processing'].includes(imp.status)||String(imp.requested_by_id)!==x.actorUserId)throw Error('INVALID_IMPORT_JOB_STATE');
 const [staff]=await db.execute<Person[]>(`SELECT id,role,status FROM users WHERE id=? AND company_id=? LIMIT 1`,[x.actorUserId,which.companyId]);
 const person=staff[0];if(!person||person.status!=='active'||person.role==='owner')throw AppError.forbidden();
 await eligibleOwner(db,which.companyId,x.actorUserId,person.role.toUpperCase(),x.ownerUserId);
 const opts=await choices(db,which.companyId);
 let created=0,skipped=0;
 for(const row of x.rows){
  const [states]=await db.execute<RowDataPacket[]>(`SELECT state FROM crm_import_rows WHERE company_id=? AND import_job_id=? AND row_no=? LIMIT 1 FOR UPDATE`,[which.companyId,x.importJobId,row.row]);
  if(!states[0]||states[0].state!=='pending')throw Error('INVALID_IMPORT_ROW_STATE');
  for(const field of ['status','priority'] as const){if(opts.configured.has(field)&&!opts.allowed.get(field)?.has(row[field]))throw AppError.badRequest();}
  const [contacts]=await db.execute<Contact[]>(`SELECT id,owner_user_id FROM contacts WHERE company_id=? AND id=? LIMIT 1 FOR UPDATE`,[which.companyId,row.contactId]);
  if(!contacts[0]||String(contacts[0].owner_user_id??'')!==x.ownerUserId)throw AppError.notFound();
  const [dupes]=await db.execute<RowDataPacket[]>(`SELECT id FROM leads WHERE company_id=? AND contact_id=?
  AND LOWER(TRIM(title))=LOWER(?) LIMIT 1`,[which.companyId,row.contactId,row.title]);
  if(dupes.length){skipped++;
   await db.execute(`UPDATE crm_import_rows SET state='skipped' WHERE company_id=? AND import_job_id=? AND row_no=?`,[which.companyId,x.importJobId,row.row]);
  }else{
   await db.execute(`INSERT INTO leads(company_id,contact_id,title,status,priority,source_key,description,created_by_user_id,owner_user_id)
    VALUES(?,?,?,?,?,?,?,?,?)`,[which.companyId,row.contactId,row.title,row.status,row.priority,row.sourceKey,row.description,x.actorUserId,x.ownerUserId]);
   created++;
   await db.execute(`UPDATE crm_import_rows SET state='completed' WHERE company_id=? AND import_job_id=? AND row_no=?`,[which.companyId,x.importJobId,row.row]);
  }
 }
 const totalCreated=Number(imp.successful_rows)+created,totalFailed=Number(imp.failed_rows)+skipped;
 if(totalCreated+totalFailed>Number(imp.total_rows))throw Error('IMPORT_COUNT_OVERFLOW');
 const finished=totalCreated+totalFailed===Number(imp.total_rows);
 await db.execute(`UPDATE import_jobs SET successful_rows=?,failed_rows=?,status=?,completed_at=IF(?,UTC_TIMESTAMP(3),NULL)
 WHERE company_id=? AND id=?`,[totalCreated,totalFailed,finished?'completed':'processing',finished?1:0,which.companyId,x.importJobId]);
 // Clear sensitive rows after a successful chunk; only aggregate status persists.
 await db.execute(`UPDATE crm_background_jobs SET state='completed',attempts=attempts+1,payload_json=JSON_OBJECT()
 WHERE company_id=? AND id=?`,[which.companyId,which.id]);
 if(finished)await audit(db,which.companyId,x.actorUserId,'lead.bulk_import.completed',x.importJobId,{created:totalCreated,skipped:totalFailed,totalRows:Number(imp.total_rows)});
 return finished?'completed':'processed' as const;
}
export async function markFailure(db:Db,which:{id:string;companyId:string}){
 const [company]=await db.execute<RowDataPacket[]>(`SELECT id FROM companies WHERE id=? FOR UPDATE`,[which.companyId]);
 if(!company.length)return 'gone';
 const [jobs]=await db.execute<ChunkJob[]>(`SELECT id,company_id,state,attempts,payload_json FROM crm_background_jobs
 WHERE id=? AND company_id=? AND job_type=? LIMIT 1 FOR UPDATE`,[which.id,which.companyId,JOB_TYPE]);
 const j=jobs[0];if(!j||j.state!=='pending')return 'none';
 const attempts=Number(j.attempts)+1;
 if(attempts<5){
  await db.execute(`UPDATE crm_background_jobs SET attempts=?,run_after=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? SECOND)
  WHERE id=? AND company_id=?`,[attempts,Math.min(300,2**attempts),which.id,which.companyId]);
  return 'retry';
 }
 const p=payloadJson(j.payload_json);
 const [imports]=await db.execute<Job[]>(`SELECT id,company_id,source_file_key,requested_by_id,status,total_rows,successful_rows,failed_rows
 FROM import_jobs WHERE company_id=? AND id=? LIMIT 1 FOR UPDATE`,[which.companyId,p.importJobId]);
 const imp=imports[0];
 if(imp&&['queued','processing'].includes(imp.status)){
  const remaining=Number(imp.total_rows)-Number(imp.successful_rows)-Number(imp.failed_rows);
  await db.execute(`UPDATE import_jobs SET status='failed',failed_rows=failed_rows+?,completed_at=UTC_TIMESTAMP(3) WHERE company_id=? AND id=?`,[remaining,which.companyId,p.importJobId]);
  await db.execute(`UPDATE crm_import_rows SET state='failed' WHERE company_id=? AND import_job_id=? AND state='pending'`,[which.companyId,p.importJobId]);
  // Cancel all remaining chunk jobs and scrub queued row contents on terminal failure.
  await db.execute(`UPDATE crm_background_jobs SET state='failed',payload_json=JSON_OBJECT(),attempts=IF(id=?,5,attempts)
  WHERE company_id=? AND job_type=? AND state='pending' AND idempotency_key LIKE ?`,[which.id,which.companyId,JOB_TYPE,`lead-import:${p.importJobId}:%`]);
  await audit(db,which.companyId,p.actorUserId,'lead.bulk_import.failed',p.importJobId,{processed:Number(imp.successful_rows)+Number(imp.failed_rows),remaining});
 }else{
  await db.execute(`UPDATE crm_background_jobs SET state='failed',attempts=5,payload_json=JSON_OBJECT() WHERE id=? AND company_id=?`,[which.id,which.companyId]);
 }
 return 'failed';
}