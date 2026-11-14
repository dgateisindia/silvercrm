import type {Response} from "express";
import {getDbPool} from "../../../core/database/pool";
import {getTenantContext} from "../../../core/tenant/tenantContext";
import {requirePermission} from "../../../core/permissions/policies";
import {AppError} from "../../../core/errors/AppError";
import {id,limit,parsePipeline,parseProduct,parseDeal,parseStage,parseQuote} from "../schemas/sales.schema";
import {Db,listPipelines,createPipeline,listProducts,createProduct,createDeal,listDeals,visibleDeal,updateStage,createQuote,getQuote,pipelineInsights} from "../repositories/sales.repository";

export interface SalesDependencies{readonly connectionFactory?:()=>Promise<Db>}
export function createSalesService(deps:SalesDependencies={}){
 const factory=deps.connectionFactory??(()=>getDbPool().getConnection());
 function tenant(res:Response, permission:"deals.read"|"deals.update"|"settings.manage",write=false){
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
 const productCreate=(res:Response,data:unknown)=>{const t=tenant(res,"settings.manage",true);const v=parseProduct(data);return run(true,db=>createProduct(db,t,v,reqId(res)));};
 const deals=(res:Response,n:unknown)=>{const t=tenant(res,"deals.read");return run(false,db=>listDeals(db,t,limit(n)));};
 const dealGet=(res:Response,dealId:unknown)=>{const t=tenant(res,"deals.read");return run(false,db=>visibleDeal(db,t,id(dealId)));};
 const dealCreate=(res:Response,data:unknown)=>{const t=tenant(res,"deals.update",true);const v=parseDeal(data);return run(true,db=>createDeal(db,t,v,reqId(res)));};
 const stageChange=(res:Response,dealId:unknown,data:unknown)=>{const t=tenant(res,"deals.update",true);const d=id(dealId);const v=parseStage(data);return run(true,db=>updateStage(db,t,d,v,reqId(res)));};
 const quoteCreate=(res:Response,data:unknown)=>{const t=tenant(res,"deals.update",true);const v=parseQuote(data);return run(true,db=>createQuote(db,t,v,reqId(res)));};
 const quoteGet=(res:Response,quoteId:unknown)=>{const t=tenant(res,"deals.read");return run(false,db=>getQuote(db,t,id(quoteId)));};
 const insights=(res:Response)=>{const t=tenant(res,"deals.read");return run(false,db=>pipelineInsights(db,t));};
 return Object.freeze({pipelines,pipelineCreate,products,productCreate,deals,dealGet,dealCreate,stageChange,quoteCreate,quoteGet,insights});
}
