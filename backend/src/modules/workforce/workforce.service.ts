import type {Response} from 'express';
import {getDbPool} from '../../core/database/pool';
import {getTenantContext} from '../../core/tenant/tenantContext';
import {requirePermission} from '../../core/permissions/policies';
import {AppError} from '../../core/errors/AppError';
import {id,eventInput,absenceInput,coverageInput,rangeQuery} from './workforce.schema';
import {type Db,createEvent,cancelEvent,listEvents,createAbsence,cancelAbsence,listAbsences,scheduleCoverage,listCoverage,nextDueCoverage,processCoverage} from './workforce.repository';

export interface WorkforceDependencies { readonly connectionFactory?:()=>Promise<Db>; readonly beforeWrite?:(event:string)=>Promise<void>|void; }
export function createWorkforceService(deps:WorkforceDependencies={}){
 const factory=deps.connectionFactory??(()=>getDbPool().getConnection());
 async function tx<T>(work:(db:Db)=>Promise<T>):Promise<T>{
  const db=await factory();let begun=false,committing=false,destroy=false;
  try{
   await db.beginTransaction();begun=true;
   const out=await work(db);
   committing=true;await db.commit();committing=false;begun=false;
   return out;
  }catch(e){
   if(committing)destroy=true;
   else if(begun){try{await db.rollback();}catch{destroy=true;}}
   if(e&&typeof e==='object'&&'code' in e&&e.code==='ER_DUP_ENTRY')throw AppError.conflict();
   throw e;
  }finally{if(destroy)db.destroy();else db.release();}
 }
 async function read<T>(work:(db:Db)=>Promise<T>):Promise<T>{const db=await factory();try{return await work(db);}finally{db.release();}}
 function writable(res:Response,managerOnly=false){
  const t=getTenantContext(res);requirePermission(t,'leads.update');
  if(t.accessMode!=='FULL'||t.role==='OWNER'||(managerOnly&&t.role!=='MANAGER'))throw AppError.forbidden();
  return t;
 }
 function readable(res:Response){const t=getTenantContext(res);requirePermission(t,'leads.read');return t;}
 return Object.freeze({
  eventCreate:(res:Response,body:unknown)=>{const t=writable(res);const x=eventInput(body);return tx(async db=>{const r=await createEvent(db,t,x);await deps.beforeWrite?.('calendar.create');return r;});},
  eventCancel:(res:Response,raw:unknown)=>{const t=writable(res);const k=id(raw);return tx(async db=>{const r=await cancelEvent(db,t,k);await deps.beforeWrite?.('calendar.cancel');return r;});},
  events:(res:Response,q:Record<string,unknown>)=>{const t=readable(res);const x=rangeQuery(q);return read(db=>listEvents(db,t,x));},
  absenceCreate:(res:Response,body:unknown)=>{const t=writable(res);const x=absenceInput(body);return tx(async db=>{const r=await createAbsence(db,t,x);await deps.beforeWrite?.('absence.create');return r;});},
  absenceCancel:(res:Response,raw:unknown)=>{const t=writable(res);const k=id(raw);return tx(async db=>{const r=await cancelAbsence(db,t,k);await deps.beforeWrite?.('absence.cancel');return r;});},
  absences:(res:Response,q:Record<string,unknown>)=>{const t=readable(res);const x=rangeQuery(q);return read(db=>listAbsences(db,t,x));},
  coverageCreate:(res:Response,body:unknown)=>{const t=writable(res,true);const x=coverageInput(body);return tx(async db=>{const r=await scheduleCoverage(db,t,x);await deps.beforeWrite?.('coverage.create');return r;});},
  coverages:(res:Response,q:Record<string,unknown>)=>{const t=readable(res);if(Object.keys(q).some(k=>k!=='limit'))throw AppError.badRequest();
   const x=rangeQuery(q);return read(db=>listCoverage(db,t,x.limit));},
  tick:async(maxJobs=50)=>{
   if(!Number.isSafeInteger(maxJobs)||maxJobs<1||maxJobs>250)throw AppError.badRequest();
   const out={activated:0,restored:0,skipped:0,superseded:0};
   for(let i=0;i<maxJobs;i++){
    const item=await read(db=>nextDueCoverage(db));if(!item)break;
    const status=await tx(async db=>{const r=await processCoverage(db,item.companyId,item.coverageId);await deps.beforeWrite?.('coverage.tick');return r;});
    if(status==='none')continue;
    out[status]++;
   }
   return out;
  },
 });
}