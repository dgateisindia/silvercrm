import type {Response} from 'express';
import {getDbPool} from '../../core/database/pool';
import {getTenantContext} from '../../core/tenant/tenantContext';
import {AppError} from '../../core/errors/AppError';
import {dashboardSnapshot,type InsightConnection} from './dashboard.repository';

export interface InsightDependencies {readonly connectionFactory?:()=>Promise<InsightConnection>;}
export function createDashboardService(deps:InsightDependencies={}){
 const factory=deps.connectionFactory??(()=>getDbPool().getConnection());
 return Object.freeze({
  async overview(res:Response,query:Record<string,unknown>){
   if(Object.keys(query).length)throw AppError.badRequest();
   const t=getTenantContext(res);
   const db=await factory();
   try{return await dashboardSnapshot(db,t);}finally{db.release();}
  }
 });
}
