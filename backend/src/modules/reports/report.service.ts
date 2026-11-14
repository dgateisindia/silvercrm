import type {Response} from 'express';
import {getDbPool} from '../../core/database/pool';
import {getTenantContext} from '../../core/tenant/tenantContext';
import {period} from './report.schema';
import {requirePermission} from '../../core/permissions/policies';
import {activityReport} from './report.repository';
import type {InsightConnection} from '../dashboard/dashboard.repository';

export interface ActivityReportDependencies {readonly connectionFactory?:()=>Promise<InsightConnection>;}
export function createActivityReportService(deps:ActivityReportDependencies={}){
 const factory=deps.connectionFactory??(()=>getDbPool().getConnection());
 return Object.freeze({
  async daily(res:Response,q:Record<string,unknown>){
   const t=getTenantContext(res);requirePermission(t,'leads.read');const range=period(q);
   const db=await factory();
   try {
    const series=await activityReport(db,t,range.from,range.to);
    const values=new Map<string,{leads:string;deals:string;tasksCompleted:string}>();
    for(let i=0;i<range.days;i++){
     const key=new Date(Date.parse(`${range.from}T00:00:00Z`)+i*86400000).toISOString().slice(0,10);
     values.set(key,{leads:'0',deals:'0',tasksCompleted:'0'});
    }
    for(const r of series.leads){const x=values.get(String(r.day));if(x)x.leads=String(r.total);}
    for(const r of series.deals){const x=values.get(String(r.day));if(x)x.deals=String(r.total);}
    for(const r of series.tasks){const x=values.get(String(r.day));if(x)x.tasksCompleted=String(r.total);}
    return {period:range,scope:t.role==='OWNER'?'company':t.role==='MANAGER'?'managed_team':'own',
      days:Array.from(values.entries(),([day,metrics])=>({day,...metrics}))};
   }finally{db.release();}
  }
 });
}
