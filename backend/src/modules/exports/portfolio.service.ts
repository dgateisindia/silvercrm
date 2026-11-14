import {createHash} from 'node:crypto';
import type {Response} from 'express';
import {getDbPool} from '../../core/database/pool';
import {getTenantContext} from '../../core/tenant/tenantContext';
import {requirePermission} from '../../core/permissions/policies';
import {parseExportQuery,parseHistoryQuery} from './export.schema';
import {portfolioSpec,readPortfolio,recordPortfolioExport,ownPortfolioHistory,
  type PortfolioConnection,type PortfolioEntity} from './portfolio.repository';
import {portfolioBytes} from './portfolio.codec';

export interface PortfolioExportDeps {
  readonly connectionFactory?:()=>Promise<PortfolioConnection>;
  readonly beforeCommit?:()=>Promise<void>|void;
}

export function createPortfolioExportService(deps:PortfolioExportDeps={}) {
  const factory=deps.connectionFactory??(()=>getDbPool().getConnection());
  return Object.freeze({
    async download(res:Response,entity:PortfolioEntity,raw:Record<string,unknown>) {
      const t=getTenantContext(res);
      requirePermission(t,portfolioSpec(entity).permission);
      const query=parseExportQuery(raw);
      const db=await factory();
      let active=false,committing=false,destroy=false;
      try {
        await db.beginTransaction();active=true;
        const result=await readPortfolio(db,t,entity,query.limit);
        const bytes=portfolioBytes(result.rows,result.columns,query.format,result.hasMore);
        if(bytes.length>1048576)throw Error('EXPORT_RESPONSE_EXCEEDS_1MB');
        const sha256=createHash('sha256').update(bytes).digest('hex');
        const jobId=await recordPortfolioExport(db,t,entity,query,
          result.rows.length,result.hasMore,sha256);
        await deps.beforeCommit?.();
        committing=true;await db.commit();committing=false;active=false;
        return {jobId,bytes,format:query.format,entity,hasMore:result.hasMore};
      }catch(error){
        if(committing)destroy=true;
        else if(active){try{await db.rollback();}catch{destroy=true;}}
        throw error;
      }finally{if(destroy)db.destroy();else db.release();}
    },
    async history(res:Response,raw:Record<string,unknown>) {
      const t=getTenantContext(res);
      // Read access is required; history is also scoped to the requesting actor only.
      requirePermission(t,'leads.read');
      const n=parseHistoryQuery(raw);
      const db=await factory();
      try{return {items:await ownPortfolioHistory(db,t,n)};}
      finally{db.release();}
    },
  });
}