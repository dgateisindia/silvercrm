import type {Response} from "express";
import {getDbPool} from "../../../core/database/pool";
import {getTenantContext} from "../../../core/tenant/tenantContext";
import {requirePermission} from "../../../core/permissions/policies";
import {AppError} from "../../../core/errors/AppError";
import {recordId,transferRequestInput,decisionInput,followupInput} from "../schemas/lead_workflows.schema";
import {Db} from "../repositories/lead_workflows.common";
import {requestTransfer,decideTransfer,pendingTransfers} from "../repositories/lead_transfer_approval.repository";
import {addFollowup,listFollowups,completeFollowup} from "../repositories/lead_followups.repository";
import {leadTimeline,potentialDuplicates,statusCounts} from "../repositories/lead_insights.repository";

export interface WorkflowDependencies { readonly connectionFactory?: () => Promise<Db> }
export function createLeadWorkflowsService(deps:WorkflowDependencies={}) {
 const factory=deps.connectionFactory??(()=>getDbPool().getConnection());
 const context=(res:Response,permission:"leads.read"|"leads.update",write=false)=>{
  const tenant=getTenantContext(res);
  requirePermission(tenant,permission);
  if(write && (tenant.role==="OWNER"||tenant.accessMode!=="FULL")) throw AppError.forbidden();
  return tenant;
 };
 const requestId=(res:Response)=>{
  const raw:unknown=res.locals.requestId;
  return typeof raw==="string"&&raw.length<=100&&raw.length>0?raw:null;
 };
 async function run<T>(write:boolean,work:(db:Db)=>Promise<T>):Promise<T> {
  const db=await factory();let begun=false,committing=false,bad=false;
  try {
   if(write){await db.beginTransaction();begun=true;}
   const result=await work(db);
   if(write){committing=true;await db.commit();committing=false;begun=false;}
   return result;
  } catch(error) {
   if(committing) bad=true;
   else if(begun) try{await db.rollback();}catch{bad=true;}
   if(error!==null&&typeof error==="object"&&"code" in error&&error.code==="ER_DUP_ENTRY") throw AppError.conflict();
   throw error;
  } finally { if(bad) db.destroy(); else db.release(); }
 }
 async function request(res:Response,leadId:unknown,body:unknown) {
  const tenant=context(res,"leads.update",true);
  if(tenant.role!=="EMPLOYEE") throw AppError.forbidden();
  const data=transferRequestInput(body);
  return run(true,db=>requestTransfer(db,tenant,recordId(leadId),data.toUserId,data.reason,requestId(res)));
 }
 async function decision(res:Response,requestIdInput:unknown,body:unknown) {
  const tenant=context(res,"leads.update",true);
  if(tenant.role!=="MANAGER") throw AppError.forbidden();
  const data=decisionInput(body);
  return run(true,db=>decideTransfer(db,tenant,recordId(requestIdInput),data.decision,data.notes,requestId(res)));
 }
 async function pending(res:Response,limit:number) {
  const tenant=context(res,"leads.read");
  if(tenant.role!=="MANAGER") throw AppError.forbidden();
  return run(false,db=>pendingTransfers(db,tenant,limit));
 }
 async function createFollowup(res:Response,leadId:unknown,body:unknown) {
  const tenant=context(res,"leads.update",true);
  const data=followupInput(body);
  return run(true,db=>addFollowup(db,tenant,recordId(leadId),data,requestId(res)));
 }
 async function followups(res:Response,leadId:unknown,limit:number) {
  const tenant=context(res,"leads.read");
  return run(false,db=>listFollowups(db,tenant,recordId(leadId),limit));
 }
 async function finishFollowup(res:Response,leadId:unknown,taskId:unknown) {
  const tenant=context(res,"leads.update",true);
  return run(true,db=>completeFollowup(db,tenant,recordId(leadId),recordId(taskId),requestId(res)));
 }
 async function timeline(res:Response,leadId:unknown,limit:number){const tenant=context(res,"leads.read");return run(false,db=>leadTimeline(db,tenant,recordId(leadId),limit));}
 async function duplicates(res:Response,leadId:unknown,limit:number){const tenant=context(res,"leads.read");return run(false,db=>potentialDuplicates(db,tenant,recordId(leadId),limit));}
 async function status(res:Response){const tenant=context(res,"leads.read");return run(false,db=>statusCounts(db,tenant));}
 return Object.freeze({request,decision,pending,createFollowup,followups,finishFollowup,timeline,duplicates,status});
}