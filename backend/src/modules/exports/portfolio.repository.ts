import type {PoolConnection, RowDataPacket, ResultSetHeader} from 'mysql2/promise';
import type {TenantContext} from '../../core/tenant/tenantContext';
import type {ExportQuery} from './export.schema';
import {AppError} from '../../core/errors/AppError';

export type PortfolioEntity = 'accounts' | 'contacts' | 'deals';
export type PortfolioPermission = 'leads.read' | 'deals.read';
export type PortfolioConnection = Pick<PoolConnection,
  'execute' | 'beginTransaction' | 'commit' | 'rollback' | 'release' | 'destroy'>;

export interface PortfolioRecord extends RowDataPacket {
  readonly id: string | number;
  readonly owner_user_id: string | number | null;
}
interface VersionRow extends RowDataPacket {
  readonly platform_entitlement_version: string | number;
}
interface JobRow extends RowDataPacket {
  readonly id: string | number;
  readonly entity_type: string;
  readonly export_format: string;
  readonly status: string;
  readonly row_count: string | number;
  readonly result_sha256: string | null;
  readonly created_at: Date | string;
  readonly completed_at: Date | string | null;
}

const specs = {
  accounts: {
    permission:'leads.read', alias:'a',
    columns:['id','name','email','phone','website','status','owner_user_id','created_at'] as readonly string[],
    base:`SELECT a.id,a.name,a.email,a.phone,a.website,a.status,a.owner_user_id,
                 a.created_at FROM accounts a WHERE a.company_id=?`,
  },
  contacts: {
    permission:'leads.read', alias:'c',
    columns:['id','account_id','first_name','last_name','email','phone','owner_user_id','marketing_opt_in','created_at'] as readonly string[],
    base:`SELECT c.id,c.account_id,c.first_name,c.last_name,c.email,c.phone,
                 c.owner_user_id,c.marketing_opt_in,c.created_at
          FROM contacts c WHERE c.company_id=?`,
  },
  deals: {
    permission:'deals.read', alias:'d',
    columns:['id','lead_id','account_id','contact_id','pipeline_id','stage_id','owner_user_id',
             'title','expected_amount','currency','expected_close_date','closed_at','created_at'] as readonly string[],
    base:`SELECT d.id,d.lead_id,d.account_id,d.contact_id,d.pipeline_id,d.stage_id,
                 d.owner_user_id,d.title,d.expected_amount,d.currency,d.expected_close_date,
                 d.closed_at,d.created_at
          FROM deals d WHERE d.company_id=?`,
  },
} as const;

export function portfolioSpec(entity:PortfolioEntity) {return specs[entity];}

function ownershipClause(t:TenantContext, alias:string):{sql:string;args:string[]} {
  if(t.role==='OWNER')return {sql:'',args:[]};
  if(t.role==='EMPLOYEE')return {sql:` AND ${alias}.owner_user_id=?`,args:[t.actorUserId]};
  if(t.role!=='MANAGER')throw AppError.forbidden();
  return {
    sql:` AND (${alias}.owner_user_id=? OR EXISTS (
      SELECT 1 FROM team_members tm INNER JOIN teams te
        ON te.company_id=tm.company_id AND te.id=tm.team_id
      WHERE tm.company_id=${alias}.company_id
        AND tm.user_id=${alias}.owner_user_id
        AND tm.left_at IS NULL AND tm.joined_at<=UTC_TIMESTAMP(3)
        AND te.status='active' AND te.manager_user_id=?))`,
    args:[t.actorUserId,t.actorUserId],
  };
}

export async function readPortfolio(db:PortfolioConnection,t:TenantContext,entity:PortfolioEntity,limit:number) {
  const spec=specs[entity];
  const scope=ownershipClause(t,spec.alias);
  const [raw]=await db.execute<PortfolioRecord[]>(
    spec.base+scope.sql+` ORDER BY ${spec.alias}.id DESC LIMIT ?`,
    [t.companyId,...scope.args,limit+1],
  );
  return {rows:raw.slice(0,limit),hasMore:raw.length>limit,columns:spec.columns};
}

export async function recordPortfolioExport(
  db:PortfolioConnection,t:TenantContext,entity:PortfolioEntity,query:ExportQuery,
  rowCount:number,hasMore:boolean,sha256:string,
):Promise<string> {
  const [versions]=await db.execute<VersionRow[]>(
    `SELECT platform_entitlement_version FROM companies WHERE id=? LIMIT 1`,
    [t.companyId],
  );
  const version=versions[0]?.platform_entitlement_version;
  if(version===undefined)throw AppError.forbidden();
  const [result]=await db.execute<ResultSetHeader>(
    `INSERT INTO crm_export_jobs
      (company_id,entity_type,requested_by_id,status,export_format,export_scope_json,
       purpose,requested_access_mode,requested_entitlement_version,
       row_count,result_sha256,completed_at)
     VALUES (?,?,?,'completed',?,?,'STANDARD',?,?,?, ?,UTC_TIMESTAMP(3))`,
    [t.companyId,entity,t.actorUserId,query.format,
     JSON.stringify({scope:t.role,limit:query.limit,hasMore}),t.accessMode,
     version,rowCount,sha256],
  );
  const jobId=String(result.insertId);
  await db.execute(
    `INSERT INTO audit_logs
      (company_id,actor_user_id,action,entity_type,entity_id,outcome,details_json,occurred_at)
     VALUES (?,?,'crm.portfolio_export.generated','crm_export_job',?,'success',?,UTC_TIMESTAMP(3))`,
    [t.companyId,t.actorUserId,jobId,
     JSON.stringify({entity,format:query.format,rowCount,hasMore,scope:t.role})],
  );
  return jobId;
}

export async function ownPortfolioHistory(db:PortfolioConnection,t:TenantContext,limit:number) {
  const [rows]=await db.execute<JobRow[]>(
    `SELECT id,entity_type,export_format,status,row_count,result_sha256,created_at,completed_at
       FROM crm_export_jobs
      WHERE company_id=? AND requested_by_id=?
        AND entity_type IN ('accounts','contacts','deals')
      ORDER BY id DESC LIMIT ?`,
    [t.companyId,t.actorUserId,limit],
  );
  return rows.map(row=>({
    id:String(row.id),entityType:row.entity_type,format:row.export_format,
    status:row.status,rowCount:Number(row.row_count),sha256:row.result_sha256,
    createdAt:row.created_at,completedAt:row.completed_at,
  }));
}