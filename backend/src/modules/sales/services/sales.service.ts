import { linkDealToCustomerAccount } from "../repositories/sales.repository"; // STEP13Y4_LINK_ACCOUNT
import { createCustomerPurchaseOrder, listCustomerPurchaseOrders, getCustomerPurchaseOrder } from '../repositories/sales.repository';
import { parseCustomerPurchaseOrder, parseCustomerPurchaseOrderId, parseCustomerPurchaseOrderCursor } from '../schemas/sales.schema';
import type {Response} from "express";
import {getDbPool} from "../../../core/database/pool";
import {getTenantContext} from "../../../core/tenant/tenantContext";
import {requirePermission} from "../../../core/permissions/policies";
import {AppError} from "../../../core/errors/AppError";
import {id,limit,parsePipeline,parseProduct,parseDeal,parseStage,parseQuote} from "../schemas/sales.schema";
import {listQuotationSummaries, Db,listPipelines,createPipeline,listProducts,createProduct,createDeal,listDeals,visibleDeal,updateStage,createQuote,getQuote,pipelineInsights} from "../repositories/sales.repository";

export interface SalesDependencies{readonly connectionFactory?:()=>Promise<Db>}
export function createSalesService(deps:SalesDependencies={}){
 const factory=deps.connectionFactory??(()=>getDbPool().getConnection());
 function tenant(res:Response, permission:"sales.catalog.manage" | "deals.read"|"deals.update"|"settings.manage",write=false){
  const t=getTenantContext(res);requirePermission(t,permission);
  if(write&&(t.accessMode!=="FULL"|| (permission!=="settings.manage"&&t.role==="OWNER")))throw AppError.forbidden();
  return t;
 }
 function reqId(res:Response){const v:unknown=res.locals.requestId;return typeof v==="string"&&v.length<=100?v:null;}
 async function run<T>(write:boolean,work:(db:Db)=>Promise<T>):Promise<T>{
  const db=await factory();let started=false,committing=false,bad=false;
  try{
   if(write){await db.beginTransaction();started=true;}
   const result=await work(db);
   if(write){committing=true;await db.commit();committing=false;started=false;}
   return result;
  }catch(e){
   if(committing)bad=true;
   else if(started)try{await db.rollback();}catch{bad=true;}
   if(e&&typeof e==="object"&&"code" in e&&e.code==="ER_DUP_ENTRY")throw AppError.conflict();
   throw e;
  }finally{if(bad)db.destroy();else db.release();}
 }
 const pipelines=(res:Response)=>{const t=tenant(res,"deals.read");return run(false,db=>listPipelines(db,t));};
 const pipelineCreate=(res:Response,data:unknown)=>{const t=tenant(res,"settings.manage",true);const v=parsePipeline(data);return run(true,db=>createPipeline(db,t,v,reqId(res)));};
 const products=(res:Response,n:unknown)=>{const t=tenant(res,"deals.read");return run(false,db=>listProducts(db,t,limit(n)));};
 const productCreate=(res:Response,data:unknown)=>{const t=tenant(res,"sales.catalog.manage",true);const v=parseProduct(data);return run(true,db=>createProduct(db,t,v,reqId(res)));};
 const deals=(res:Response,n:unknown)=>{const t=tenant(res,"deals.read");return run(false,db=>listDeals(db,t,limit(n)));};
   // STEP13Y4_LINK_ACCOUNT: only Manager can confirm a previously unlinked deal's company.
  const dealAccountLink=(res:Response,dealId:unknown,raw:unknown)=>{
    const t=tenant(res,"deals.update",true);
    if(t.role!=="MANAGER")throw AppError.forbidden();
    if(raw===null||typeof raw!=="object"||Array.isArray(raw))throw AppError.badRequest();
    const body=raw as Record<string,unknown>;
    if(Object.keys(body).length!==1||!Object.prototype.hasOwnProperty.call(body,"accountId"))throw AppError.badRequest();
    return run(true,db=>linkDealToCustomerAccount(db,t,id(dealId),id(body.accountId),reqId(res)));
  };
const dealGet=(res:Response,dealId:unknown)=>{const t=tenant(res,"deals.read");return run(false,db=>visibleDeal(db,t,id(dealId)));};
 const dealCreate=(res:Response,data:unknown)=>{const t=tenant(res,"deals.update",true);const v=parseDeal(data);return run(true,db=>createDeal(db,t,v,reqId(res)));};
 const stageChange=(res:Response,dealId:unknown,data:unknown)=>{const t=tenant(res,"deals.update",true);const d=id(dealId);const v=parseStage(data);return run(true,db=>updateStage(db,t,d,v,reqId(res)));};
 const quoteCreate=(res:Response,data:unknown)=>{const t=tenant(res,"deals.update",true);const v=parseQuote(data);return run(true,db=>createQuote(db,t,v,reqId(res)));};
 const quoteList=(res:Response,n:unknown,before:unknown)=>{const t=tenant(res,"deals.read");const size=limit(n);const cursor=before===undefined?null:id(before);return run(false,db=>listQuotationSummaries(db,t,size,cursor));};
 const quoteGet=(res:Response,quoteId:unknown)=>{const t=tenant(res,"deals.read");return run(false,db=>getQuote(db,t,id(quoteId)));};
 const insights=(res:Response)=>{const t=tenant(res,"deals.read");return run(false,db=>pipelineInsights(db,t));};
 const purchaseOrders=(res:Response,n:unknown,before:unknown)=>{const t=tenant(res,'deals.read');return run(false,db=>listCustomerPurchaseOrders(db,t,limit(n),parseCustomerPurchaseOrderCursor(before)));};
 const purchaseOrder=(res:Response,orderId:unknown)=>{const t=tenant(res,'deals.read');return run(false,db=>getCustomerPurchaseOrder(db,t,parseCustomerPurchaseOrderId(orderId)));};
 const purchaseOrderCreate=(res:Response,data:unknown)=>{const t=tenant(res,'deals.update',true);const input=parseCustomerPurchaseOrder(data);return run(true,db=>createCustomerPurchaseOrder(db,t,input,reqId(res)));};
 return Object.freeze({pipelines,pipelineCreate,products,productCreate,deals,dealGet,dealCreate,stageChange,quoteCreate,quoteList,quoteGet,insights,purchaseOrders,purchaseOrder,purchaseOrderCreate,dealAccountLink});
}
