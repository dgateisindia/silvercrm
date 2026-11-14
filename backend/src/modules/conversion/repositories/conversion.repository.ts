import type {PoolConnection,RowDataPacket,ResultSetHeader} from 'mysql2/promise';
import {AppError} from '../../../core/errors/AppError';
import type {TenantContext} from '../../../core/tenant/tenantContext';
import {scopedLead} from '../../leads/repositories/lead_workflows.common';
import {visibleDeal} from '../../sales/repositories/sales.repository';
import {dbId} from '../../sales/schemas/sales.schema';
import {duplicateContactExists} from '../../customers/repositories/customer.repository';
import type {conversionBody,negotiationBody} from '../schemas/conversion.schema';

export type Db=Pick<PoolConnection,'execute'|'beginTransaction'|'commit'|'rollback'|'release'|'destroy'>;
interface R extends RowDataPacket{
 id:string|number|bigint; owner_user_id?:string|number|bigint|null;
 contact_id?:string|number|bigint|null;account_id?:string|number|bigint|null;
 lead_id?:string|number|bigint|null; pipeline_id?:string|number|bigint|null;
 stage_type?:string;active?:number;currency?:string; revision?:string;
 email?:string|null;phone?:string|null;name?:string;title?:string;
}
async function audit(db:Db,t:TenantContext,action:string,entity:string,entityId:string,meta:Record<string,unknown>,rid:string|null){
 await db.execute(`INSERT INTO audit_logs(company_id,actor_user_id,action,entity_type,entity_id,outcome,request_id,details_json,occurred_at) VALUES(?,?,?,?,?,'success',?,?,UTC_TIMESTAMP(3))`,[t.companyId,t.actorUserId,action,entity,entityId,rid,JSON.stringify(meta)]);
}
async function event(db:Db,t:TenantContext,entity:string,id:string,type:string,summary:string){
 await db.execute(`INSERT INTO activity_events(company_id,entity_type,entity_id,actor_user_id,event_type,occurred_at,public_summary) VALUES(?,?,?,?,?,UTC_TIMESTAMP(3),?)`,[t.companyId,entity,id,t.actorUserId,type,summary]);
}
async function companyLock(db:Db,t:TenantContext){
 const [found]=await db.execute<RowDataPacket[]>(`SELECT id FROM companies WHERE id=? LIMIT 1 FOR UPDATE`,[t.companyId]);
 if(!found.length)throw AppError.forbidden();
}
function nullableId(raw:unknown):string|null{return raw===null||raw===undefined?null:dbId(raw);}
async function conversionLead(db:Db,t:TenantContext,leadId:string,lock:boolean){
 await scopedLead(db,t,leadId,lock);
 const [rows]=await db.execute<R[]>(`SELECT id,contact_id,account_id,owner_user_id,title,DATE_FORMAT(updated_at,'%Y-%m-%dT%H:%i:%s.%f') AS revision FROM leads WHERE company_id=? AND id=? LIMIT 1 ${lock?'FOR UPDATE':''}`,[t.companyId,leadId]);
 const r=rows[0];if(!r||!r.owner_user_id)throw AppError.notFound();
 return {id:leadId,contactId:nullableId(r.contact_id),accountId:nullableId(r.account_id),ownerId:dbId(r.owner_user_id),title:r.title!,revision:r.revision!};
}
export async function conversionState(db:Db,t:TenantContext,leadId:string){
 const lead=await conversionLead(db,t,leadId,false);
 const [deals]=await db.execute<R[]>(`SELECT id FROM deals WHERE company_id=? AND lead_id=? ORDER BY id DESC LIMIT 1`,[t.companyId,leadId]);
 return {leadId,revision:lead.revision,contactId:lead.contactId,accountId:lead.accountId,alreadyLinked:lead.contactId!==null||lead.accountId!==null,dealId:deals[0]?dbId(deals[0].id):null};
}
export async function convertLead(db:Db,t:TenantContext,leadId:string,v:ReturnType<typeof conversionBody>,rid:string|null){
 // Take the same company lock used by customer creation/import to serialize duplicate checks.
 await companyLock(db,t);
 const lead=await conversionLead(db,t,leadId,true);
 if(lead.revision!==v.expectedRevision)throw AppError.conflict();
 // Existing lead associations are handled by ordinary customer/deal workflows, not overwritten here.
 if(lead.contactId!==null||lead.accountId!==null)throw AppError.conflict();
 const [currentDeals]=await db.execute<R[]>(`SELECT id FROM deals WHERE company_id=? AND lead_id=? LIMIT 1 FOR UPDATE`,[t.companyId,leadId]);
 if(currentDeals.length)throw AppError.conflict();
 let accountId:string|null=null;
 if(v.account?.mode==='existing'){
   const [acc]=await db.execute<R[]>(`SELECT id,owner_user_id FROM accounts WHERE company_id=? AND id=? AND status='active' LIMIT 1 FOR UPDATE`,[t.companyId,v.account.accountId]);
   if(!acc[0]||nullableId(acc[0].owner_user_id)!==lead.ownerId)throw AppError.notFound();
   accountId=dbId(acc[0].id);
 }else if(v.account?.mode==='new'){
   const [dupes]=await db.execute<R[]>(`SELECT id FROM accounts WHERE company_id=? AND (LOWER(TRIM(name))=? OR (? IS NOT NULL AND LOWER(TRIM(email))=?)) LIMIT 1`,[t.companyId,v.account.name.toLowerCase(),v.account.email,v.account.email]);
   if(dupes.length)throw AppError.conflict();
   const [created]=await db.execute<ResultSetHeader>(`INSERT INTO accounts(company_id,name,email,phone,owner_user_id,status) VALUES(?,?,?,?,?,'active')`,[t.companyId,v.account.name,v.account.email,v.account.phone,lead.ownerId]);
   accountId=dbId(created.insertId);
 }
 let contactId:string;
 if(v.contact.mode==='existing'){
  const [contacts]=await db.execute<R[]>(`SELECT id,owner_user_id,account_id FROM contacts WHERE company_id=? AND id=? LIMIT 1 FOR UPDATE`,[t.companyId,v.contact.contactId]);
  const c=contacts[0];if(!c||nullableId(c.owner_user_id)!==lead.ownerId)throw AppError.notFound();
  contactId=dbId(c.id);
  const existingAccount=nullableId(c.account_id);
  if(existingAccount && accountId && existingAccount!==accountId)throw AppError.conflict();
  if(existingAccount && !accountId)accountId=existingAccount;
  if(!existingAccount && accountId){
    await db.execute(`UPDATE contacts SET account_id=?,updated_at=GREATEST(DATE_ADD(updated_at,INTERVAL 1000 MICROSECOND),UTC_TIMESTAMP(3)) WHERE company_id=? AND id=?`,[accountId,t.companyId,contactId]);
  }
 }else{
  if(await duplicateContactExists(db,t,v.contact.email,v.contact.phone,null))throw AppError.conflict();
  const [created]=await db.execute<ResultSetHeader>(`INSERT INTO contacts(company_id,account_id,first_name,last_name,email,phone,owner_user_id,marketing_opt_in) VALUES(?,?,?,?,?,?,?,0)`,[t.companyId,accountId,v.contact.firstName,v.contact.lastName,v.contact.email,v.contact.phone,lead.ownerId]);
  contactId=dbId(created.insertId);
 }
 let dealId:string|null=null;
 if(v.deal){
   const [stages]=await db.execute<R[]>(`SELECT p.id,p.active,s.stage_type FROM pipelines p JOIN pipeline_stages s ON s.company_id=p.company_id AND s.pipeline_id=p.id WHERE p.company_id=? AND p.id=? AND s.id=? LIMIT 1 FOR UPDATE`,[t.companyId,v.deal.pipelineId,v.deal.stageId]);
   if(!stages[0] || !Boolean(stages[0].active) || stages[0].stage_type!=='open')throw AppError.badRequest();
   const [company]=await db.execute<R[]>(`SELECT currency FROM companies WHERE id=? LIMIT 1`,[t.companyId]);
   const currency=company[0]?.currency;
   if(typeof currency!=='string'|| !/^[A-Z]{3}$/.test(currency))throw AppError.forbidden();
   const [created]=await db.execute<ResultSetHeader>(`INSERT INTO deals(company_id,lead_id,account_id,contact_id,pipeline_id,stage_id,owner_user_id,title,expected_amount,currency,expected_close_date) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[t.companyId,leadId,accountId,contactId,v.deal.pipelineId,v.deal.stageId,lead.ownerId,lead.title,v.deal.amount,currency,v.deal.expectedCloseDate]);
   dealId=dbId(created.insertId);
 }
 const [changed]=await db.execute<ResultSetHeader>(`UPDATE leads SET contact_id=?,account_id=?,updated_at=GREATEST(DATE_ADD(updated_at,INTERVAL 1000 MICROSECOND),UTC_TIMESTAMP(3)) WHERE company_id=? AND id=? AND contact_id IS NULL AND account_id IS NULL`,[contactId,accountId,t.companyId,leadId]);
 if(changed.affectedRows!==1)throw AppError.conflict();
 await event(db,t,'lead',leadId,'lead.converted','Lead linked to customer contact');
 await event(db,t,'contact',contactId,'lead.linked','Contact linked to a sales lead');
 if(dealId)await event(db,t,'deal',dealId,'deal.created_from_lead','Deal created from qualified lead');
 await audit(db,t,'lead.converted','lead',leadId,{contactId,accountId,dealId,ownerId:lead.ownerId},rid);
 return {leadId,contactId,accountId,dealId,ownerUserId:lead.ownerId};
}
export async function listNegotiations(db:Db,t:TenantContext,dealId:string,n:number){
 await visibleDeal(db,t,dealId);
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT id,quotation_id,entered_by_id,note,proposed_amount,occurred_at FROM crm_negotiation_events WHERE company_id=? AND deal_id=? ORDER BY id DESC LIMIT ?`,[t.companyId,dealId,n]);
 return rows.map(x=>({id:dbId(x.id),quotationId:nullableId(x.quotation_id),enteredById:dbId(x.entered_by_id),note:x.note,proposedAmount:x.proposed_amount===null?null:String(x.proposed_amount),occurredAt:x.occurred_at}));
}
export async function addNegotiation(db:Db,t:TenantContext,dealId:string,v:ReturnType<typeof negotiationBody>,rid:string|null){
 const deal=await visibleDeal(db,t,dealId,true);
 if(deal.stageType!=='open')throw AppError.conflict();
 if(v.quotationId){
  const [quotes]=await db.execute<R[]>(`SELECT id FROM crm_quotations WHERE company_id=? AND id=? AND deal_id=? LIMIT 1`,[t.companyId,v.quotationId,dealId]);
  if(!quotes.length)throw AppError.notFound();
 }
 const [created]=await db.execute<ResultSetHeader>(`INSERT INTO crm_negotiation_events(company_id,deal_id,quotation_id,entered_by_id,note,proposed_amount,occurred_at) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP(3))`,[t.companyId,dealId,v.quotationId,t.actorUserId,v.note,v.proposedAmount]);
 const negotiationId=dbId(created.insertId);
 // Sensitive note content is never mirrored into public activity summaries or audit metadata.
 await event(db,t,'deal',dealId,'negotiation.recorded','Negotiation entry recorded');
 await audit(db,t,'negotiation.recorded','deal',dealId,{negotiationId,quotationId:v.quotationId,hasProposal:v.proposedAmount!==null},rid);
 return {id:negotiationId,dealId,quotationId:v.quotationId,proposedAmount:v.proposedAmount,recordedById:t.actorUserId};
}