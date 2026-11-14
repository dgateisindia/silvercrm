import type {Response} from 'express';
import {getDbPool} from '../../../core/database/pool';
import {getTenantContext} from '../../../core/tenant/tenantContext';
import {requirePermission} from '../../../core/permissions/policies';
import {AppError} from '../../../core/errors/AppError';
import {id} from '../../sales/schemas/sales.schema';
import {conversionBody,negotiationBody,pagination} from '../schemas/conversion.schema';
import {type Db,conversionState,convertLead,listNegotiations,addNegotiation} from '../repositories/conversion.repository';

export interface ConversionDependencies{readonly connectionFactory?:()=>Promise<Db>}
export function createConversionService(deps:ConversionDependencies={}){
 const factory=deps.connectionFactory??(()=>getDbPool().getConnection());
 function tenant(res:Response,permission:'leads.read'|'leads.update'|'deals.read'|'deals.update',write=false){
  const t=getTenantContext(res);requirePermission(t,permission);
  if(write&&(t.accessMode!=='FULL'||t.role==='OWNER'))throw AppError.forbidden();
  return t;
 }
 function requestId(res:Response){const v:unknown=res.locals.requestId;return typeof v==='string'&&v.length<=100?v:null;}
 async function run<T>(write:boolean,work:(db:Db)=>Promise<T>):Promise<T>{
  const db=await factory();let started=false,committing=false,discard=false;
  try{
   if(write){await db.beginTransaction();started=true;}
   const result=await work(db);
   if(write){committing=true;await db.commit();committing=false;started=false;}
   return result;
  }catch(e){
   if(committing)discard=true;
   else if(started)try{await db.rollback();}catch{discard=true;}
   if(e!==null && typeof e==='object' && 'code' in e && e.code==='ER_DUP_ENTRY')throw AppError.conflict();
   throw e;
  }finally{if(discard)db.destroy();else db.release();}
 }
 const state=(res:Response,raw:unknown)=>{const t=tenant(res,'leads.read');return run(false,db=>conversionState(db,t,id(raw)));};
 const convert=(res:Response,raw:unknown,body:unknown)=>{const t=tenant(res,'leads.update',true);const leadId=id(raw),v=conversionBody(body);return run(true,db=>convertLead(db,t,leadId,v,requestId(res)));};
 const negotiationList=(res:Response,raw:unknown,rawLimit:unknown)=>{const t=tenant(res,'deals.read');return run(false,db=>listNegotiations(db,t,id(raw),pagination(rawLimit)));};
 const negotiationCreate=(res:Response,raw:unknown,body:unknown)=>{const t=tenant(res,'deals.update',true),dealId=id(raw),v=negotiationBody(body);return run(true,db=>addNegotiation(db,t,dealId,v,requestId(res)));};
 return Object.freeze({state,convert,negotiationList,negotiationCreate});
}