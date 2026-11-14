import type {Response} from 'express';
import {getDbPool} from '../../core/database/pool';
import {getTenantContext} from '../../core/tenant/tenantContext';
import {requirePermission} from '../../core/permissions/policies';
import {AppError} from '../../core/errors/AppError';
import {identifier,jobLimit,type ReminderPayload} from './automation.types';
import {type Db,companies,scanCompany,nextJob,deliver,markFailure,listJobs} from './automation.repository';

export interface AutomationDependencies{
 readonly connectionFactory?:()=>Promise<Db>;
 readonly beforeDelivery?:(payload:ReminderPayload)=>Promise<void>|void;
}
export interface AutomationResult {readonly scanned:number;readonly queued:number;readonly delivered:number;readonly skipped:number;readonly retried:number;readonly failed:number;}
export function createAutomationService(deps:AutomationDependencies={}){
 const factory=deps.connectionFactory??(()=>getDbPool().getConnection());
 async function transaction<T>(work:(db:Db)=>Promise<T>):Promise<T>{
  const db=await factory();let begun=false,committing=false,destroy=false;
  try{
   await db.beginTransaction();begun=true;
   const result=await work(db);
   committing=true;await db.commit();committing=false;begun=false;
   return result;
  }catch(error){
   if(committing)destroy=true;
   else if(begun){try{await db.rollback();}catch{destroy=true;}}
   throw error;
  }finally{if(destroy)db.destroy();else db.release();}
 }
 async function read<T>(work:(db:Db)=>Promise<T>):Promise<T>{
  const db=await factory();try{return await work(db);}finally{db.release();}
 }
 async function tick(maxJobs=50):Promise<AutomationResult>{
  if(!Number.isSafeInteger(maxJobs)||maxJobs<1||maxJobs>500)throw AppError.badRequest();
  const companyIds=await read(companies);
  const result={scanned:0,queued:0,delivered:0,skipped:0,retried:0,failed:0};
  for(const companyId of companyIds){
   const s=await transaction(db=>scanCompany(db,companyId));
   result.scanned+=s.examined;result.queued+=s.queued;
  }
  for(let i=0;i<maxJobs;i++){
   let failedJob:{id:string;companyId:string}|null=null;
   let outcome:'none'|'delivered'|'skipped'='none';
   try{
    outcome=await transaction(async db=>{
     const job=await nextJob(db);
     if(!job)return 'none';
     failedJob={id:identifier(job.id),companyId:identifier(job.company_id)};
     return deliver(db,job,deps.beforeDelivery);
    });
   }catch(error){
    if(failedJob){
     const failed=failedJob as {id:string;companyId:string};
     const status=await transaction(db=>markFailure(db,failed.id,failed.companyId));
     if(status==='retry')result.retried++;
     if(status==='failed')result.failed++;
    }else throw error;
    // The actual exception is intentionally not persisted in customer-facing records.
    continue;
   }
   if(outcome==='none')break;
   if(outcome==='delivered')result.delivered++;
   if(outcome==='skipped')result.skipped++;
  }
  return result;
 }
 function jobs(res:Response,rawLimit:unknown){
  const t=getTenantContext(res);requirePermission(t,'leads.read');
  return read(db=>listJobs(db,t,jobLimit(rawLimit)));
 }
 return Object.freeze({tick,jobs});
}