import type { RowDataPacket,ResultSetHeader } from 'mysql2/promise';
import { AppError } from '../../../core/errors/AppError';
import type { TenantContext } from '../../../core/tenant/tenantContext';
import {dbId,scaled,decimal} from '../../sales/schemas/sales.schema';
import type {Db} from '../../finance/repositories/finance.repository';
import type {targetBody,adjustmentBody} from '../schemas/operations.schema';
interface Member extends RowDataPacket {id:string|number|bigint;}
interface TRow extends RowDataPacket {id:string|number|bigint;user_id:string|number|bigint|null;target_amount:string;currency:string;starts_on:string;ends_on:string;}
interface Val extends RowDataPacket {delta:string;}
async function audit(db:Db,t:TenantContext,action:string,id:string,data:Record<string,unknown>,rid:string|null){await db.execute(`INSERT INTO audit_logs(company_id,actor_user_id,action,entity_type,entity_id,outcome,request_id,details_json,occurred_at) VALUES(?,? ,?,'target',?,'success',?,?,UTC_TIMESTAMP(3))`,[t.companyId,t.actorUserId,action,id,rid,JSON.stringify(data)]);}
async function member(db:Db,t:TenantContext,userId:string){
 const [rows]=await db.execute<Member[]>(`SELECT u.id FROM users u JOIN team_members m ON m.company_id=u.company_id AND m.user_id=u.id JOIN teams a ON a.company_id=m.company_id AND a.id=m.team_id WHERE u.company_id=? AND u.id=? AND u.role='employee' AND u.status='active' AND m.left_at IS NULL AND m.joined_at<=UTC_TIMESTAMP(3) AND a.manager_user_id=? AND a.status='active' LIMIT 1 FOR UPDATE`,[t.companyId,userId,t.actorUserId]);
 if(!rows[0])throw AppError.notFound();
}
export async function createTarget(db:Db,t:TenantContext,body:ReturnType<typeof targetBody>,rid:string|null){
 await member(db,t,body.userId);
 const [overlap]=await db.execute<TRow[]>(`SELECT id FROM crm_target_periods WHERE company_id=? AND user_id=? AND starts_on<=STR_TO_DATE(?,'%Y-%m-%d') AND ends_on>=STR_TO_DATE(?,'%Y-%m-%d') LIMIT 1 FOR UPDATE`,[t.companyId,body.userId,body.endsOn,body.startsOn]);if(overlap.length)throw AppError.conflict();
 const [made]=await db.execute<ResultSetHeader>(`INSERT INTO crm_target_periods(company_id,user_id,starts_on,ends_on,target_amount,currency) VALUES(?,?,STR_TO_DATE(?,'%Y-%m-%d'),STR_TO_DATE(?,'%Y-%m-%d'),?,'INR')`,[t.companyId,body.userId,body.startsOn,body.endsOn,body.amount]);
 const targetId=dbId(made.insertId);await audit(db,t,'target.created',targetId,{userId:body.userId,amount:body.amount},rid);return{id:targetId,userId:body.userId,amount:body.amount,startsOn:body.startsOn,endsOn:body.endsOn};
}
export async function targetDetail(db:Db,t:TenantContext,targetId:string,lock:boolean){
 const [rows]=await db.execute<TRow[]>(`SELECT id,user_id,CAST(target_amount AS CHAR) AS target_amount,currency,DATE_FORMAT(starts_on,'%Y-%m-%d') AS starts_on,DATE_FORMAT(ends_on,'%Y-%m-%d') AS ends_on FROM crm_target_periods WHERE company_id=? AND id=? LIMIT 1 ${lock?'FOR UPDATE':''}`,[t.companyId,targetId]);const row=rows[0];if(!row||dbId(row.id)!==targetId||!row.user_id)throw AppError.notFound();
 if(t.role==='EMPLOYEE'){if(dbId(row.user_id)!==t.actorUserId)throw AppError.notFound();}else if(t.role==='MANAGER'){await member(db,t,dbId(row.user_id));}
 const [deltas]=await db.execute<Val[]>(`SELECT CAST(delta_amount AS CHAR) AS delta FROM crm_target_adjustments WHERE company_id=? AND target_period_id=? LIMIT 1001`,[t.companyId,targetId]);if(deltas.length>1000)throw AppError.conflict();
 const signed=(value:string)=>value.startsWith('-')?-scaled(value.slice(1),2):scaled(value,2);
 const original=scaled(String(row.target_amount),2), adjusted=deltas.reduce((n,v)=>n+signed(String(v.delta)),original);
 if(adjusted<0n)throw AppError.conflict();
 return {id:targetId,userId:dbId(row.user_id),startsOn:row.starts_on,endsOn:row.ends_on,currency:row.currency,original:decimal(original,2),effective:decimal(adjusted,2),adjustmentCount:deltas.length};
}
export async function adjustTarget(db:Db,t:TenantContext,targetId:string,body:ReturnType<typeof adjustmentBody>,rid:string|null){
 const previous=await targetDetail(db,t,targetId,true);if(previous.effective!==body.expectedEffective)throw AppError.conflict();
 const delta=body.delta.startsWith('-')?-scaled(body.delta.slice(1),2):scaled(body.delta,2);
 const next=scaled(previous.effective,2)+delta;if(next<0n||next>999999999999999999n)throw AppError.badRequest();
 await db.execute(`INSERT INTO crm_target_adjustments(company_id,target_period_id,delta_amount,reason,approved_by_id) VALUES(?,?,?,?,?)`,[t.companyId,targetId,body.delta,body.reason,t.actorUserId]);
 await audit(db,t,'target.adjusted',targetId,{delta:body.delta,effective:decimal(next,2)},rid);
 return {...previous,effective:decimal(next,2),adjustmentCount:previous.adjustmentCount+1};
}
export async function listTargets(db:Db,t:TenantContext){
 const [rows]=await db.execute<TRow[]>(`SELECT id,user_id,CAST(target_amount AS CHAR) AS target_amount,currency,DATE_FORMAT(starts_on,'%Y-%m-%d') AS starts_on,DATE_FORMAT(ends_on,'%Y-%m-%d') AS ends_on FROM crm_target_periods WHERE company_id=? ORDER BY id DESC LIMIT 250`,[t.companyId]);
 const visible=[];for(const r of rows){const userId=r.user_id?dbId(r.user_id):null;if(!userId)continue;if(t.role==='EMPLOYEE'&&userId!==t.actorUserId)continue;
  if(t.role==='MANAGER'){const [members]=await db.execute<Member[]>(`SELECT tm.id FROM team_members tm JOIN teams a ON a.company_id=tm.company_id AND a.id=tm.team_id WHERE tm.company_id=? AND tm.user_id=? AND tm.left_at IS NULL AND a.manager_user_id=? AND a.status='active' LIMIT 1`,[t.companyId,userId,t.actorUserId]);if(!members[0])continue;}
  visible.push({id:dbId(r.id),userId,amount:String(r.target_amount),startsOn:r.starts_on,endsOn:r.ends_on,currency:r.currency});
 }return {items:visible,limit:250};
}