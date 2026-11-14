import type {PoolConnection,ResultSetHeader,RowDataPacket} from 'mysql2/promise';
import type {TenantContext} from '../../core/tenant/tenantContext';
import {AppError} from '../../core/errors/AppError';
import {createHash} from 'node:crypto';
import {id,type LeadImportPayload} from './lead_import.schema';
import {parseLeadCsv,type LeadCsvRow} from './lead_import.csv';

export type Db=Pick<PoolConnection,'execute'|'beginTransaction'|'commit'|'rollback'|'release'|'destroy'>;
interface Staff extends RowDataPacket{id:string|number|bigint;role:string;status:string;}
interface Contact extends RowDataPacket{id:string|number|bigint;owner_user_id:string|number|bigint|null;}
interface Choice extends RowDataPacket{field_key:string;option_key:string;is_active:number|string|boolean;}
interface Job extends RowDataPacket{id:string|number|bigint;source_file_key:string;duplicate_strategy:string;requested_by_id:string|number|bigint;total_rows:number;successful_rows:number;failed_rows:number;status:string;}
export interface ImportResult{validationOnly:boolean;totalRows:number;wouldCreate:number;duplicates:number;wouldReject:boolean;rows:Array<{row:number;outcome:'create'|'duplicate'}>;id?:string;replayed?:boolean;}

async function activeActor(db:Db,t:TenantContext){
 const [people]=await db.execute<Staff[]>(`SELECT id,role,status FROM users WHERE company_id=? AND id=? LIMIT 1`,[t.companyId,t.actorUserId]);
 const actor=people[0];if(!actor||actor.status!=='active'||actor.role!==t.role.toLowerCase())throw AppError.forbidden();
}
async function authorizedOwner(db:Db,t:TenantContext,wanted:string){
 if(t.role==='EMPLOYEE'){
  if(wanted!==t.actorUserId)throw AppError.forbidden();return;
 }
 if(t.role!=='MANAGER')throw AppError.forbidden();
 if(wanted===t.actorUserId)return;
 const [members]=await db.execute<RowDataPacket[]>(`SELECT tm.id FROM team_members tm
 JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id
 JOIN users u ON u.company_id=tm.company_id AND u.id=tm.user_id
 WHERE tm.company_id=? AND tm.user_id=? AND tm.left_at IS NULL
 AND tm.joined_at<=UTC_TIMESTAMP(3) AND te.manager_user_id=? AND te.status='active'
 AND u.role='employee' AND u.status='active' LIMIT 1`,[t.companyId,wanted,t.actorUserId]);
 if(!members.length)throw AppError.notFound();
}
async function choices(db:Db,t:TenantContext){
 const [rows]=await db.execute<Choice[]>(`SELECT field_key,option_key,is_active FROM picklist_options
 WHERE company_id=? AND entity_type='lead' AND field_key IN ('status','priority')`,[t.companyId]);
 const configured=new Map<string,Set<string>>();
 for(const row of rows){let set=configured.get(row.field_key);if(!set){set=new Set();configured.set(row.field_key,set);} if(row.is_active===1||row.is_active===true||row.is_active==='1')set.add(row.option_key);}
 return {configured,hasAny:(field:string)=>rows.some(r=>r.field_key===field)};
}
async function accessibleContact(db:Db,t:TenantContext,contactId:string,ownerId:string,commit:boolean){
 const [contacts]=await db.execute<Contact[]>(`SELECT id,owner_user_id FROM contacts WHERE company_id=? AND id=? LIMIT 1 ${commit?'FOR UPDATE':''}`,[t.companyId,contactId]);
 const contact=contacts[0];
 // Account/contact ownership must not change silently during import.
 if(!contact||String(contact.owner_user_id??'')!==ownerId)throw AppError.notFound();
}
async function existsLead(db:Db,t:TenantContext,row:LeadCsvRow){
 const [leads]=await db.execute<RowDataPacket[]>(`SELECT id FROM leads WHERE company_id=? AND contact_id=?
 AND LOWER(TRIM(title))=LOWER(?) LIMIT 1`,[t.companyId,row.contactId,row.title]);
 return leads.length>0;
}
export function fingerprint(x:LeadImportPayload,owner:string){
 return createHash('sha256').update(JSON.stringify({csv:x.csv,mapping:x.mapping,duplicateStrategy:x.duplicateStrategy,owner})).digest('hex');
}
async function audit(db:Db,t:TenantContext,jobId:string,created:number,duplicates:number){
 await db.execute(`INSERT INTO audit_logs(company_id,actor_user_id,action,entity_type,entity_id,outcome,request_id,details_json,occurred_at)
 VALUES(?,?,'lead.import.completed','import_job',?,'success',NULL,?,UTC_TIMESTAMP(3))`,
 [t.companyId,t.actorUserId,jobId,JSON.stringify({created,skippedDuplicates:duplicates,entityType:'lead'})]);
}
export async function runImport(db:Db,t:TenantContext,x:LeadImportPayload,commit:boolean):Promise<ImportResult>{
 await activeActor(db,t);
 const owner=x.ownerUserId??t.actorUserId;
 await authorizedOwner(db,t,owner);
 const parsed=parseLeadCsv(x.csv,x.mapping);
 const digest=fingerprint(x,owner);
 if(commit){
  // Company row serialization prevents a second import from racing the first one.
  const [companies]=await db.execute<RowDataPacket[]>(`SELECT id FROM companies WHERE id=? AND status='active' FOR UPDATE`,[t.companyId]);
  if(!companies.length)throw AppError.forbidden();
  // Repeat checks after the company lock to close the authorization/commit race.
  await activeActor(db,t);
  await authorizedOwner(db,t,owner);
  const [jobs]=await db.execute<Job[]>(`SELECT id,source_file_key,duplicate_strategy,requested_by_id,total_rows,successful_rows,failed_rows,status
  FROM import_jobs WHERE company_id=? AND idempotency_key=? LIMIT 1 FOR UPDATE`,[t.companyId,x.idempotencyKey]);
  if(jobs[0]){
   const job=jobs[0];if(job.source_file_key!==digest||job.duplicate_strategy!==x.duplicateStrategy||String(job.requested_by_id)!==t.actorUserId||job.status!=='completed')throw AppError.conflict();
   return {id:id(job.id),validationOnly:false,totalRows:Number(job.total_rows),wouldCreate:Number(job.successful_rows),duplicates:Number(job.failed_rows),wouldReject:false,rows:[],replayed:true};
  }
 }
 const allowed=await choices(db,t);
 const seen=new Set<string>();let created=0,duplicates=0;
 const results:ImportResult['rows']=[];
 for(const row of parsed){
  for(const field of ['status','priority'] as const){
   if(allowed.hasAny(field) && !allowed.configured.get(field)?.has(row[field]))throw AppError.badRequest();
  }
  await accessibleContact(db,t,row.contactId,owner,commit);
  const key=`${row.contactId}\u0000${row.title.toLocaleLowerCase('en-US')}`;
  const dupe=seen.has(key)||await existsLead(db,t,row);
  seen.add(key);
  if(dupe){duplicates++;results.push({row:row.row,outcome:'duplicate'});continue;}
  results.push({row:row.row,outcome:'create'});created++;
 }
 const wouldReject=x.duplicateStrategy==='REJECT'&&duplicates>0;
 if(!commit)return {validationOnly:true,totalRows:parsed.length,wouldCreate:created,duplicates,wouldReject,rows:results};
 if(wouldReject)throw AppError.conflict();
 for(let i=0;i<parsed.length;i++){
  const row=parsed[i]!;
  if(results[i]!.outcome==='duplicate')continue;
  await db.execute(`INSERT INTO leads(company_id,contact_id,title,status,priority,source_key,description,created_by_user_id,owner_user_id)
   VALUES(?,?,?,?,?,?,?,?,?)`,[t.companyId,row.contactId,row.title,row.status,row.priority,row.sourceKey,row.description,t.actorUserId,owner]);
 }
 const [record]=await db.execute<ResultSetHeader>(`INSERT INTO import_jobs
 (company_id,entity_type,requested_by_id,source_file_key,status,total_rows,import_format,duplicate_strategy,validation_only,column_mapping_json,idempotency_key,successful_rows,failed_rows,completed_at)
 VALUES(?,'lead',?,?,'completed',?,'CSV',?,0,?,?,?, ?,UTC_TIMESTAMP(3))`,
 [t.companyId,t.actorUserId,digest,parsed.length,x.duplicateStrategy,JSON.stringify(x.mapping),x.idempotencyKey,created,duplicates]);
 const jobId=id(record.insertId);
 await audit(db,t,jobId,created,duplicates);
 return {id:jobId,validationOnly:false,totalRows:parsed.length,wouldCreate:created,duplicates,wouldReject:false,rows:results,replayed:false};
}
export async function readJob(db:Db,t:TenantContext,jobId:string){
 await activeActor(db,t);
 const [rows]=await db.execute<Job[]>(`SELECT id,requested_by_id,source_file_key,duplicate_strategy,total_rows,successful_rows,failed_rows,status
 FROM import_jobs WHERE company_id=? AND id=? AND entity_type='lead' LIMIT 1`,[t.companyId,jobId]);
 const job=rows[0];if(!job)throw AppError.notFound();
 if(t.role!=='OWNER'&&String(job.requested_by_id)!==t.actorUserId){
  if(t.role!=='MANAGER')throw AppError.notFound();
  const [teams]=await db.execute<RowDataPacket[]>(`SELECT tm.id FROM team_members tm JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id
   WHERE tm.company_id=? AND tm.user_id=? AND tm.left_at IS NULL AND tm.joined_at<=UTC_TIMESTAMP(3)
   AND te.manager_user_id=? AND te.status='active' LIMIT 1`,[t.companyId,String(job.requested_by_id),t.actorUserId]);
  if(!teams.length)throw AppError.notFound();
 }
 return {id:id(job.id),totalRows:Number(job.total_rows),created:Number(job.successful_rows),skippedDuplicates:Number(job.failed_rows),status:job.status,duplicateStrategy:job.duplicate_strategy};
}