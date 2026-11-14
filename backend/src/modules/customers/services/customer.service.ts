import type {Response} from 'express';
import {getDbPool} from '../../../core/database/pool';
import {AppError} from '../../../core/errors/AppError';
import {getTenantContext} from '../../../core/tenant/tenantContext';
import {requirePermission} from '../../../core/permissions/policies';
import {id,limit,accountBody,contactBody,accountPatch,contactPatch,activityBody,duplicatesQuery,importBody} from '../schemas/customer.schema';
import type {Db} from '../repositories/customer.repository';
import {listAccounts,getAccount,createAccount,updateAccount,listContacts,getContact,createContact,updateContact,accountContacts,contactDuplicates,contactActivity,timeline,readImport,companyLock} from '../repositories/customer.repository';
import {runImport,ensureImportKeyUnused} from '../repositories/customer.import';

export interface CustomerDependencies{readonly connectionFactory?:()=>Promise<Db>}
export function createCustomerService(deps:CustomerDependencies={}){
 const factory=deps.connectionFactory??(()=>getDbPool().getConnection());
 function auth(res:Response,write=false){
  const t=getTenantContext(res);requirePermission(t,write?'leads.update':'leads.read');
  if(write&&(t.role==='OWNER'||t.accessMode!=='FULL'))throw AppError.forbidden();
  return t;
 }
 function rid(res:Response){const v:unknown=res.locals.requestId;return typeof v==='string'&&v.length<=100?v:null;}
 async function run<T>(write:boolean,work:(db:Db)=>Promise<T>):Promise<T>{
  const db=await factory();let begun=false,committing=false,destroy=false;
  try{
   if(write){await db.beginTransaction();begun=true;}
   const result=await work(db);
   if(write){committing=true;await db.commit();committing=false;begun=false;}
   return result;
  }catch(error){
   if(committing)destroy=true;
   else if(begun){try{await db.rollback();}catch{destroy=true;}}
   if(error!==null&&typeof error==='object'&&'code' in error && error.code==='ER_DUP_ENTRY')throw AppError.conflict();
   throw error;
  }finally{if(destroy)db.destroy();else db.release();}
 }
 const accounts=(res:Response,n:unknown)=>{const t=auth(res);return run(false,db=>listAccounts(db,t,limit(n)));};
 const account=(res:Response,accountId:unknown)=>{const t=auth(res);return run(false,db=>getAccount(db,t,id(accountId)));};
 const accountCreate=(res:Response,body:unknown)=>{const t=auth(res,true),v=accountBody(body);return run(true,db=>createAccount(db,t,v,rid(res)));};
 const accountUpdate=(res:Response,accountId:unknown,body:unknown)=>{const t=auth(res,true),v=accountPatch(body);return run(true,db=>updateAccount(db,t,id(accountId),v,rid(res)));};
 const contacts=(res:Response,n:unknown)=>{const t=auth(res);return run(false,db=>listContacts(db,t,limit(n)));};
 const contact=(res:Response,contactId:unknown)=>{const t=auth(res);return run(false,db=>getContact(db,t,id(contactId)));};
 const contactCreate=(res:Response,body:unknown)=>{const t=auth(res,true),v=contactBody(body);return run(true,db=>createContact(db,t,v,rid(res)));};
 const contactUpdate=(res:Response,contactId:unknown,body:unknown)=>{const t=auth(res,true),v=contactPatch(body);return run(true,db=>updateContact(db,t,id(contactId),v,rid(res)));};
 const fromAccount=(res:Response,accountId:unknown,n:unknown)=>{const t=auth(res);return run(false,db=>accountContacts(db,t,id(accountId),limit(n)));};
 const duplicatePreview=(res:Response,q:Record<string,unknown>)=>{const t=auth(res);const values=duplicatesQuery(q);return run(false,db=>contactDuplicates(db,t,values));};
 const activityCreate=(res:Response,contactId:unknown,body:unknown)=>{const t=auth(res,true),v=activityBody(body);return run(true,db=>contactActivity(db,t,id(contactId),v,rid(res)));};
 const history=(res:Response,contactId:unknown,n:unknown)=>{const t=auth(res);return run(false,db=>timeline(db,t,id(contactId),limit(n)));};
 const importPreview=(res:Response,body:unknown)=>{const t=auth(res,true),v=importBody(body,false);return run(false,db=>runImport(db,t,v,rid(res),false));};
 const importCommit=(res:Response,body:unknown)=>{const t=auth(res,true),v=importBody(body,true);return run(true,async db=>{
  // The company-wide lock is taken before checking an idempotency key and writing.
  await companyLock(db,t);
  await ensureImportKeyUnused(db,t,v.idempotencyKey!);
  return runImport(db,t,v,rid(res),true);
 });};
 const importGet=(res:Response,importId:unknown)=>{const t=auth(res);return run(false,db=>readImport(db,t,id(importId)));};
 return Object.freeze({accounts,account,accountCreate,accountUpdate,contacts,contact,contactCreate,contactUpdate,fromAccount,duplicatePreview,activityCreate,history,importPreview,importCommit,importGet});
}