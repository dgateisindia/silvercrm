import type {PoolConnection,RowDataPacket} from 'mysql2/promise';
import type {TenantContext} from '../../core/tenant/tenantContext';
import {AppError} from '../../core/errors/AppError';

export type InsightConnection=Pick<PoolConnection,'execute'|'release'>;
interface CountRow extends RowDataPacket { readonly total:string|number; }
interface TaskCountRow extends RowDataPacket {readonly total:string|number;readonly overdue:string|number|null;}
interface DealCountRow extends RowDataPacket {readonly total:string|number;readonly expectedAmount:string;}
interface StatusCountRow extends RowDataPacket {readonly status:string;readonly total:string|number;}

/** Company ownership is never accepted from URL or query; tenant context is trusted. */
export function ownerScope(t:TenantContext,table:'l'|'d'|'t'):{sql:string;params:string[]} {
 const owner=`${table}.owner_user_id`;
 if(t.role==='OWNER')return {sql:'',params:[]};
 if(t.role==='EMPLOYEE')return {sql:` AND ${owner}=?`,params:[t.actorUserId]};
 if(t.role==='MANAGER')return {
  sql:` AND (${owner}=? OR EXISTS (SELECT 1 FROM team_members tm
   INNER JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id
   WHERE tm.company_id=${table}.company_id AND tm.user_id=${owner}
   AND tm.left_at IS NULL AND tm.joined_at<=UTC_TIMESTAMP(3)
   AND te.status='active' AND te.manager_user_id=?))`,
  params:[t.actorUserId,t.actorUserId]
 };
 throw AppError.forbidden();
}
export async function dashboardSnapshot(db:InsightConnection,t:TenantContext){
 const ls=ownerScope(t,'l'),ts=ownerScope(t,'t'),ds=ownerScope(t,'d');
 const [leadRows]=await db.execute<CountRow[]>(`SELECT COUNT(*) total FROM leads l WHERE l.company_id=? ${ls.sql}`,[t.companyId,...ls.params]);
 const [statusRows]=await db.execute<StatusCountRow[]>(`SELECT l.status status,COUNT(*) total FROM leads l WHERE l.company_id=? ${ls.sql} GROUP BY l.status ORDER BY total DESC,l.status LIMIT 100`,[t.companyId,...ls.params]);
 const [taskRows]=await db.execute<TaskCountRow[]>(`SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN t.status='open' AND t.due_at<UTC_TIMESTAMP(3) THEN 1 ELSE 0 END),0) overdue FROM tasks t WHERE t.company_id=? ${ts.sql}`,[t.companyId,...ts.params]);
 const [dealRows]=await db.execute<DealCountRow[]>(`SELECT COUNT(*) total,CAST(COALESCE(SUM(d.expected_amount),0) AS CHAR) expectedAmount FROM deals d WHERE d.company_id=? ${ds.sql}`,[t.companyId,...ds.params]);
 return {
  scope:t.role==='OWNER'?'company':t.role==='MANAGER'?'managed_team':'own',
  leads:{total:String(leadRows[0]?.total??'0'),byStatus:statusRows.map(r=>({status:String(r.status),count:String(r.total)}))},
  tasks:{total:String(taskRows[0]?.total??'0'),overdue:String(taskRows[0]?.overdue??'0')},
  deals:{total:String(dealRows[0]?.total??'0'),expectedAmount:String(dealRows[0]?.expectedAmount??'0')}
 };
}
