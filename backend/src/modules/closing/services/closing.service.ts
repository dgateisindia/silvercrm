import type { Response } from "express";
import { getDbPool } from "../../../core/database/pool";
import { AppError } from "../../../core/errors/AppError";
import { requirePermission } from "../../../core/permissions/policies";
import { getTenantContext } from "../../../core/tenant/tenantContext";
import { id } from "../../sales/schemas/sales.schema";
import type { Db } from "../../finance/repositories/finance.repository";
import { rolloverBody, refundReviewBody, analyticsRange, analyticsFormat } from "../schemas/closing.schema";
import { carryTarget, reviewRefund, targetPerformance, invoiceAging, targetCsv, agingCsv } from "../repositories/closing.repository";

export interface ClosingDependencies { readonly connectionFactory?: () => Promise<Db>; }

export function createClosingService(deps: ClosingDependencies={}){
  const factory=deps.connectionFactory??(()=>getDbPool().getConnection());
  function context(res:Response,perm:'deals.read'|'deals.update',write:boolean){
    const t=getTenantContext(res);requirePermission(t,perm);
    if(write && (t.role!=='MANAGER' || t.accessMode!=='FULL')) throw AppError.forbidden();
    return t;
  }
  function requestId(res:Response){const v:unknown=res.locals.requestId;
    return typeof v==='string' && v.length<=100?v:null;}
  async function execute<T>(write:boolean,action:(db:Db)=>Promise<T>){
    const db=await factory();let begun=false,committing=false,destroy=false;
    try{
      if(write){await db.beginTransaction();begun=true;}
      const result=await action(db);
      if(write){committing=true;await db.commit();committing=false;begun=false;}
      return result;
    }catch(error){
      if(committing) destroy=true;
      else if(begun){try{await db.rollback();}catch{destroy=true;}}
      if(error && typeof error==='object' && 'code' in error && error.code==='ER_DUP_ENTRY'){
        throw AppError.conflict();
      }
      throw error;
    }finally{if(destroy)db.destroy();else db.release();}
  }
  const carry=(res:Response,targetId:unknown,raw:unknown)=>{
    const t=context(res,'deals.update',true),body=rolloverBody(raw);
    return execute(true,db=>carryTarget(db,t,id(targetId),body,requestId(res)));
  };
  const refund=(res:Response,refundId:unknown,raw:unknown)=>{
    const t=context(res,'deals.update',true),body=refundReviewBody(raw);
    return execute(true,db=>reviewRefund(db,t,id(refundId),body,requestId(res)));
  };
  const performance=(res:Response,from:unknown,to:unknown,format:unknown)=>{
    const t=context(res,'deals.read',false),dates=analyticsRange(from,to),mode=analyticsFormat(format);
    return execute(false,async db=>{
      const data=await targetPerformance(db,t,dates);
      return mode==='csv'?{format:'csv' as const,csv:targetCsv(data)}:{format:'json' as const,data};
    });
  };
  const aging=(res:Response,format:unknown)=>{
    const t=context(res,'deals.read',false),mode=analyticsFormat(format);
    if(t.role==='EMPLOYEE') throw AppError.forbidden();
    return execute(false,async db=>{
      const data=await invoiceAging(db,t);
      return mode==='csv'?{format:'csv' as const,csv:agingCsv(data)}:{format:'json' as const,data};
    });
  };
  return Object.freeze({carry,refund,performance,aging});
}