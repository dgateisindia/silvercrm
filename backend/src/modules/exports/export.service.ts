import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { getDbPool } from '../../core/database/pool';
import { getTenantContext } from '../../core/tenant/tenantContext';
import { requirePermission } from '../../core/permissions/policies';
import type { ExportConnection } from './export.repository';
import { scopedLeads, recordExport, ownExportHistory } from './export.repository';
import { parseExportQuery, parseHistoryQuery } from './export.schema';

export interface ExportDependencies {
  readonly connectionFactory?: () => Promise<ExportConnection>;
  readonly beforeCommit?: () => Promise<void> | void;
}

function textField(value: unknown): string {
  const source = value instanceof Date ? value.toISOString() :
    (value === null || value === undefined ? '' : String(value));
  return source.replace(/\r\n|\r|\n/g, ' ');
}
function csvCell(value: unknown): string {
  let cell = textField(value);
  // Excel formula-injection prevention, including leading whitespace/control characters.
  if (/^[\s\uFEFF]*[=+\-@]/u.test(cell)) cell = "'" + cell;
  return '"' + cell.replace(/"/g, '""') + '"';
}
function csvBytes(rows: Awaited<ReturnType<typeof scopedLeads>>['rows']): Buffer {
  const headers = ['id','title','status','priority','source_key','owner_user_id','created_at','next_followup_at'];
  const lines = [headers.join(',')];
  for (const row of rows) {
    const values = [row.id,row.title,row.status,row.priority,row.source_key,row.owner_user_id,
      row.created_at,row.next_followup_at];
    lines.push(values.map(csvCell).join(','));
  }
  return Buffer.from('\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
}
function jsonBytes(rows: Awaited<ReturnType<typeof scopedLeads>>['rows'],hasMore:boolean): Buffer {
  const safe = rows.map(row => ({
    id:String(row.id),title:row.title,status:row.status,priority:row.priority,
    sourceKey:row.source_key,ownerUserId:String(row.owner_user_id),
    createdAt:textField(row.created_at),nextFollowupAt:textField(row.next_followup_at),
  }));
  return Buffer.from(JSON.stringify({rows:safe,hasMore}), 'utf8');
}
export function createExportService(deps:ExportDependencies={}) {
  const factory = deps.connectionFactory ?? (() => getDbPool().getConnection());
  return Object.freeze({
    async leads(res:Response, raw:Record<string,unknown>) {
      const tenant=getTenantContext(res);
      requirePermission(tenant,'leads.read');
      const query=parseExportQuery(raw);
      const db=await factory();
      let active=false, committing=false, destroy=false;
      try {
        await db.beginTransaction(); active=true;
        const result=await scopedLeads(db,tenant,query.limit);
        const bytes=query.format==='CSV' ? csvBytes(result.rows) : jsonBytes(result.rows,result.hasMore);
        if(bytes.length>1048576)throw Error('EXPORT_RESPONSE_EXCEEDS_1MB');
        const hash=createHash('sha256').update(bytes).digest('hex');
        const jobId=await recordExport(db,tenant,query,result.rows.length,result.hasMore,hash);
        await deps.beforeCommit?.();
        committing=true;await db.commit();committing=false;active=false;
        return {jobId,bytes,format:query.format,rowCount:result.rows.length,hasMore:result.hasMore};
      } catch(error) {
        if(committing)destroy=true;
        else if(active){try{await db.rollback();}catch{destroy=true;}}
        throw error;
      } finally { if(destroy)db.destroy(); else db.release(); }
    },
    async history(res:Response,raw:Record<string,unknown>) {
      const tenant=getTenantContext(res);
      requirePermission(tenant,'leads.read');
      const limit=parseHistoryQuery(raw);
      const db=await factory();
      try{return {items:await ownExportHistory(db,tenant,limit)};}
      finally{db.release();}
    },
  });
}