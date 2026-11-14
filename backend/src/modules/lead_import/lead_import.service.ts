import type {Response} from 'express';
import type {PoolConnection} from 'mysql2/promise';
import {getDbPool} from '../../core/database/pool';
import {getTenantContext} from '../../core/tenant/tenantContext';
import {requirePermission} from '../../core/permissions/policies';
import {AppError} from '../../core/errors/AppError';
import {id,parseImport} from './lead_import.schema';
import {readJob,runImport,type Db} from './lead_import.repository';
export interface LeadImportDependencies{readonly connectionFactory?:()=>Promise<Db>}
export function createLeadImportService(deps:LeadImportDependencies={}){
 const factory=deps.connectionFactory??(()=>getDbPool().getConnection() as Promise<PoolConnection>);
 const access=(res:Response,write:boolean)=>{
  const tenant=getTenantContext(res);requirePermission(tenant,write?'leads.update':'leads.read');
  if(write&&(tenant.accessMode!=='FULL'||tenant.role==='OWNER'))throw AppError.forbidden();
  return tenant;
 };
 const read=async<T>(fn:(db:Db)=>Promise<T>)=>{const db=await factory();try{return await fn(db);}finally{db.release();}};
 const tx=async<T>(fn:(db:Db)=>Promise<T>)=>{const db=await factory();let started=false,committing=false,destroy=false;
  try{await db.beginTransaction();started=true;const result=await fn(db);committing=true;await db.commit();committing=false;started=false;return result;}
  catch(error){if(committing)destroy=true;else if(started){try{await db.rollback();}catch{destroy=true;}}
   if(error&&typeof error==='object'&&'code' in error&&error.code==='ER_DUP_ENTRY')throw AppError.conflict();throw error;
  }finally{if(destroy)db.destroy();else db.release();}
 };
 return Object.freeze({
  preview:(res:Response,raw:unknown)=>{const t=access(res,true);const parsed=parseImport(raw,false);return read(db=>runImport(db,t,parsed,false));},
  commit:(res:Response,raw:unknown)=>{const t=access(res,true);const parsed=parseImport(raw,true);return tx(db=>runImport(db,t,parsed,true));},
  status:(res:Response,jobId:unknown)=>{const t=access(res,false);return read(db=>readJob(db,t,id(jobId)));},
 });
}