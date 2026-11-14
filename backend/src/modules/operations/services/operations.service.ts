import type {Response} from 'express';
import {getDbPool} from '../../../core/database/pool';
import {getTenantContext} from '../../../core/tenant/tenantContext';
import {requirePermission} from '../../../core/permissions/policies';
import {AppError} from '../../../core/errors/AppError';
import {id} from '../../sales/schemas/sales.schema';
import type {Db} from '../../finance/repositories/finance.repository';
import {creditBody,refundBody,scheduleBody,targetBody,adjustmentBody,reportDates,reportFormat} from '../schemas/operations.schema';
import {issueCredit,requestRefund,addSchedules,dueSchedules} from '../repositories/operations.finance.repository';
import {createTarget,targetDetail,adjustTarget,listTargets} from '../repositories/operations.targets.repository';
import {financeReport,financeCsv,dueTasks,notifications,readNotification} from '../repositories/operations.reports.repository';
export interface OperationsDependencies{readonly connectionFactory?:()=>Promise<Db>}
export function createOperationsService(deps:OperationsDependencies={}){
 const factory=deps.connectionFactory??(()=>getDbPool().getConnection());
 function auth(res:Response,scope:'finance'|'target'|'reminder',write:boolean){const t=getTenantContext(res);requirePermission(t,scope==='reminder'?'leads.read':write?'deals.update':'deals.read');if(write&&t.accessMode!=='FULL')throw AppError.forbidden();if(scope==='finance'&&!(t.role==='MANAGER'||(!write&&t.role==='OWNER')))throw AppError.forbidden();if(scope==='target'&&write&&t.role!=='MANAGER')throw AppError.forbidden();return t;}
 function rid(res:Response){const v:unknown=res.locals.requestId;return typeof v==='string'&&v.length<=100?v:null;}
 async function run<T>(write:boolean,fn:(db:Db)=>Promise<T>){const db=await factory();let begun=false,committing=false,destroy=false;try{if(write){await db.beginTransaction();begun=true;}const out=await fn(db);if(write){committing=true;await db.commit();committing=false;begun=false;}return out;}catch(e){if(committing)destroy=true;else if(begun)try{await db.rollback();}catch{destroy=true;}if(e&&typeof e==='object'&&'code' in e&&e.code==='ER_DUP_ENTRY')throw AppError.conflict();throw e;}finally{if(destroy)db.destroy();else db.release();}}
 const credit=(res:Response,invoiceId:unknown,raw:unknown)=>{const t=auth(res,'finance',true);const b=creditBody(raw);return run(true,db=>issueCredit(db,t,id(invoiceId),b,rid(res)));};
 const refund=(res:Response,paymentId:unknown,raw:unknown)=>{const t=auth(res,'finance',true);const b=refundBody(raw);return run(true,db=>requestRefund(db,t,id(paymentId),b,rid(res)));};
 const schedule=(res:Response,invoiceId:unknown,raw:unknown)=>{const t=auth(res,'finance',true);const b=scheduleBody(raw);return run(true,db=>addSchedules(db,t,id(invoiceId),b,rid(res)));};
 const scheduleList=(res:Response,invoiceId:unknown)=>{const t=auth(res,'finance',false);return run(false,db=>dueSchedules(db,t,id(invoiceId)));};
 const newTarget=(res:Response,raw:unknown)=>{const t=auth(res,'target',true);return run(true,db=>createTarget(db,t,targetBody(raw),rid(res)));};
 const target=(res:Response,targetId:unknown)=>{const t=auth(res,'target',false);return run(false,db=>targetDetail(db,t,id(targetId),false));};
 const adjust=(res:Response,targetId:unknown,raw:unknown)=>{const t=auth(res,'target',true);return run(true,db=>adjustTarget(db,t,id(targetId),adjustmentBody(raw),rid(res)));};
 const targets=(res:Response)=>{const t=auth(res,'target',false);return run(false,db=>listTargets(db,t));};
 const report=(res:Response,from:unknown,to:unknown,format:unknown)=>{const t=auth(res,'finance',false);const dates=reportDates(from,to);const output=reportFormat(format);return run(false,async db=>{const data=await financeReport(db,t,dates);return output==='csv'?{format:'csv' as const,csv:financeCsv(data)}:{format:'json' as const,data};});};
 const reminders=(res:Response)=>{const t=auth(res,'reminder',false);return run(false,db=>dueTasks(db,t));};
 const notices=(res:Response)=>{const t=auth(res,'reminder',false);return run(false,db=>notifications(db,t));};
 const markRead=(res:Response,noticeId:unknown)=>{const t=auth(res,'reminder',false);return run(true,db=>readNotification(db,t,id(noticeId)));};
 return Object.freeze({credit,refund,schedule,scheduleList,newTarget,target,adjust,targets,report,reminders,notices,markRead});
}