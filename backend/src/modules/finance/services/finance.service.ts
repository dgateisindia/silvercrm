import type { Response } from "express";
import { getDbPool } from "../../../core/database/pool";
import { getTenantContext } from "../../../core/tenant/tenantContext";
import { requirePermission } from "../../../core/permissions/policies";
import { AppError } from "../../../core/errors/AppError";
import { identifier, revisionBody, approvalBody, issueBody, paymentBody } from "../schemas/finance.schema";
import { Db, quoteRevisions, reviseQuote, approveQuote, createInvoice, invoiceBalance, issueInvoice, receivePayment } from "../repositories/finance.repository";

export interface FinanceDependencies {readonly connectionFactory?:()=>Promise<Db>}
export function createFinanceService(deps:FinanceDependencies={}) {
 const factory=deps.connectionFactory??(()=>getDbPool().getConnection());
 function user(res:Response,write:boolean,managerOnly:boolean) {
  const t=getTenantContext(res);requirePermission(t,write?"deals.update":"deals.read");
  if(write&&(t.accessMode!=="FULL"||t.role==="OWNER"))throw AppError.forbidden();
  if(managerOnly&&t.role!=="MANAGER"&&!(t.role==="OWNER"&&!write))throw AppError.forbidden();
  return t;
 }
 function requestId(res:Response) {const x:unknown=res.locals.requestId;return typeof x==="string"&&x.length<=100?x:null;}
 async function run<T>(write:boolean,fn:(db:Db)=>Promise<T>):Promise<T>{
  const db=await factory();let begun=false,committing=false,destroy=false;
  try {if(write){await db.beginTransaction();begun=true;}
   const result=await fn(db);
   if(write){committing=true;await db.commit();begun=false;committing=false;}
   return result;
  } catch(error) {
   if(committing)destroy=true;else if(begun)try{await db.rollback();}catch{destroy=true;}
   if(error&&typeof error==="object"&&"code" in error&&error.code==="ER_DUP_ENTRY")throw AppError.conflict();
   throw error;
  } finally {if(destroy)db.destroy();else db.release();}
 }
 const history=(res:Response,quoteId:unknown)=>{const t=user(res,false,false);return run(false,db=>quoteRevisions(db,t,identifier(quoteId)));};
 const revision=(res:Response,quoteId:unknown,body:unknown)=>{const t=user(res,true,false);const data=revisionBody(body);return run(true,db=>reviseQuote(db,t,identifier(quoteId),data,requestId(res)));};
 const approval=(res:Response,quoteId:unknown,body:unknown)=>{const t=user(res,true,true);const data=approvalBody(body);return run(true,db=>approveQuote(db,t,identifier(quoteId),data,requestId(res)));};
 const invoiceDraft=(res:Response,quoteId:unknown)=>{const t=user(res,true,true);return run(true,db=>createInvoice(db,t,identifier(quoteId),requestId(res)));};
 const balance=(res:Response,invoiceId:unknown)=>{const t=user(res,false,true);return run(false,db=>invoiceBalance(db,t,identifier(invoiceId)));};
 const issue=(res:Response,invoiceId:unknown,body:unknown)=>{const t=user(res,true,true);const data=issueBody(body);return run(true,db=>issueInvoice(db,t,identifier(invoiceId),data,requestId(res)));};
 const payment=(res:Response,invoiceId:unknown,body:unknown)=>{const t=user(res,true,true);const data=paymentBody(body);return run(true,db=>receivePayment(db,t,identifier(invoiceId),data,requestId(res)));};
 return Object.freeze({history,revision,approval,invoiceDraft,balance,issue,payment});
}
