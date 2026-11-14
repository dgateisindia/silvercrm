import type {Response} from 'express';
import {getDbPool} from '../../core/database/pool';
import {getTenantContext} from '../../core/tenant/tenantContext';
import {requirePermission} from '../../core/permissions/policies';
import {AppError} from '../../core/errors/AppError';
import {parseBulkRequest,parseJobId} from './bulk_import.schema';
import {parseBulkRows} from './bulk_import.parser';
import {type Db,previewBulk,queueBulk,bulkStatus,candidate,processChunk,markFailure} from './bulk_import.repository';

export interface BulkImportDependencies {readonly connectionFactory?:()=>Promise<Db>;}
export function createBulkImportService(deps:BulkImportDependencies={}){
 const factory=deps.connectionFactory??(()=>getDbPool().getConnection());
 async function read<T>(work:(db:Db)=>Promise<T>):Promise<T>{const db=await factory();try{return await work(db);}finally{db.release();}}
 async function tx<T>(work:(db:Db)=>Promise<T>):Promise<T>{
  const db=await factory();let started=false,committing=false,destroy=false;
  try{await db.beginTransaction();started=true;const result=await work(db);committing=true;await db.commit();committing=false;started=false;return result;}
  catch(e){if(committing)destroy=true;else if(started){try{await db.rollback();}catch{destroy=true;}}
   if(e&&typeof e==='object'&&'code' in e&&e.code==='ER_DUP_ENTRY')throw AppError.conflict();throw e;
  }finally{if(destroy)db.destroy();else db.release();}
 }
 function write(res:Response){const tenant=getTenantContext(res);requirePermission(tenant,'leads.update');
  if(tenant.role==='OWNER'||tenant.accessMode!=='FULL')throw AppError.forbidden();return tenant;}
 function view(res:Response){const tenant=getTenantContext(res);requirePermission(tenant,'leads.read');return tenant;}
 return Object.freeze({
  preview:async(res:Response,body:unknown)=>{const t=write(res),input=parseBulkRequest(body,false),rows=await parseBulkRows(input);
   return read(db=>previewBulk(db,t,rows,input));},
  queue:async(res:Response,body:unknown)=>{const t=write(res),input=parseBulkRequest(body,true),rows=await parseBulkRows(input);
   return tx(db=>queueBulk(db,t,rows,input));},
  status:(res:Response,jobId:unknown)=>{const t=view(res);return read(db=>bulkStatus(db,t,parseJobId(jobId)));},
  // Called only by explicit standalone worker, never inside the HTTP server startup.
  tick:async(maxChunks=10)=>{
   if(!Number.isSafeInteger(maxChunks)||maxChunks<1||maxChunks>100)throw AppError.badRequest();
   const results={processed:0,completed:0,retries:0,failed:0};
   for(let i=0;i<maxChunks;i++){
    const next=await read(candidate);if(!next)break;
    try{const status=await tx(db=>processChunk(db,next));
     if(status==='completed')results.completed++;
     else if(status==='processed')results.processed++;
    }catch{
     const state=await tx(db=>markFailure(db,next));
     if(state==='retry')results.retries++;
     if(state==='failed')results.failed++;
    }
   }
   return results;
  },
 });
}