import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { TenantContext } from '../../core/tenant/tenantContext';
import type { ExportQuery } from './export.schema';

export type ExportConnection = Pick<PoolConnection,
  'execute' | 'beginTransaction' | 'commit' | 'rollback' | 'release' | 'destroy'>;

export interface LeadExportRow extends RowDataPacket {
  readonly id: string | number;
  readonly title: string;
  readonly status: string;
  readonly priority: string;
  readonly source_key: string | null;
  readonly owner_user_id: string | number;
  readonly created_at: Date | string;
  readonly next_followup_at: Date | string | null;
}

interface VersionRow extends RowDataPacket {
  readonly platform_entitlement_version: string | number;
}

interface ExportJobRow extends RowDataPacket {
  readonly id: string | number;
  readonly entity_type: string;
  readonly export_format: string;
  readonly row_count: string | number;
  readonly status: string;
  readonly result_sha256: string | null;
  readonly created_at: Date | string;
  readonly completed_at: Date | string | null;
}

export async function scopedLeads(db: ExportConnection, t: TenantContext, limit: number) {
  const fields = `SELECT l.id,l.title,l.status,l.priority,l.source_key,
                        l.owner_user_id,l.created_at,l.next_followup_at
                  FROM leads l WHERE l.company_id=?`;
  const tail = ' ORDER BY l.id DESC LIMIT ?';
  let condition = '';
  let params: (string | number)[] = [t.companyId];
  if (t.role === 'EMPLOYEE') {
    condition = ' AND l.owner_user_id=?';
    params = [t.companyId, t.actorUserId];
  } else if (t.role === 'MANAGER') {
    condition = ` AND (l.owner_user_id=? OR EXISTS (
      SELECT 1 FROM team_members tm
      INNER JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id
      WHERE tm.company_id=l.company_id AND tm.user_id=l.owner_user_id
        AND tm.left_at IS NULL AND tm.joined_at<=UTC_TIMESTAMP(3)
        AND te.status='active' AND te.manager_user_id=?))`;
    params = [t.companyId, t.actorUserId, t.actorUserId];
  } else if (t.role !== 'OWNER') {
    throw Error('EXPORT_UNRECOGNIZED_ROLE');
  }
  const [rows] = await db.execute<LeadExportRow[]>(fields + condition + tail, [...params, limit + 1]);
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

export async function recordExport(
  db: ExportConnection, t: TenantContext, query: ExportQuery,
  rowCount: number, hasMore: boolean, sha256: string,
): Promise<string> {
  const [company] = await db.execute<VersionRow[]>(
    `SELECT platform_entitlement_version FROM companies WHERE id=? LIMIT 1`,
    [t.companyId],
  );
  if (!company[0]) throw Error('EXPORT_COMPANY_NOT_FOUND');
  const [result] = await db.execute<ResultSetHeader>(
    `INSERT INTO crm_export_jobs
       (company_id,entity_type,requested_by_id,status,export_format,
        export_scope_json,purpose,requested_access_mode,requested_entitlement_version,
        row_count,result_sha256,completed_at)
     VALUES (?,'leads',?,'completed',?,?,'STANDARD',?,?,?, ?,UTC_TIMESTAMP(3))`,
    [t.companyId,t.actorUserId,query.format,
     JSON.stringify({scope:t.role,limit:query.limit,hasMore}),t.accessMode,
     company[0].platform_entitlement_version,rowCount,sha256],
  );
  const jobId = String(result.insertId);
  await db.execute(
    `INSERT INTO audit_logs
       (company_id,actor_user_id,action,entity_type,entity_id,outcome,details_json,occurred_at)
     VALUES (?,?,'crm.export.generated','crm_export_job',?,'success',?,UTC_TIMESTAMP(3))`,
    [t.companyId,t.actorUserId,jobId,
     JSON.stringify({format:query.format,rowCount,hasMore,scope:t.role})],
  );
  return jobId;
}

export async function ownExportHistory(db: ExportConnection, t: TenantContext, limit: number) {
  const [rows] = await db.execute<ExportJobRow[]>(
    `SELECT id,entity_type,export_format,row_count,status,result_sha256,created_at,completed_at
     FROM crm_export_jobs WHERE company_id=? AND requested_by_id=? AND entity_type='leads'
     ORDER BY id DESC LIMIT ?`,
    [t.companyId,t.actorUserId,limit],
  );
  return rows.map(row => ({
    id:String(row.id), entityType:row.entity_type, format:row.export_format,
    rowCount:Number(row.row_count), status:row.status, sha256:row.result_sha256,
    createdAt:row.created_at, completedAt:row.completed_at,
  }));
}