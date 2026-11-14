import type {RowDataPacket} from 'mysql2/promise';
import type {TenantContext} from '../../core/tenant/tenantContext';
import {ownerScope,type InsightConnection} from '../dashboard/dashboard.repository';

interface DayRow extends RowDataPacket {readonly day:string;readonly total:string|number;}
export async function activityReport(db:InsightConnection,t:TenantContext,from:string,to:string){
 const ls=ownerScope(t,'l'),ds=ownerScope(t,'d'),ts=ownerScope(t,'t');
 const [leads]=await db.execute<DayRow[]>(`SELECT DATE_FORMAT(l.created_at,'%Y-%m-%d') day, COUNT(*) total FROM leads l
 WHERE l.company_id=? AND l.created_at>=? AND l.created_at<DATE_ADD(?,INTERVAL 1 DAY) ${ls.sql}
 GROUP BY DATE_FORMAT(l.created_at,'%Y-%m-%d') ORDER BY day`,[t.companyId,from,to,...ls.params]);
 const [deals]=await db.execute<DayRow[]>(`SELECT DATE_FORMAT(d.created_at,'%Y-%m-%d') day, COUNT(*) total FROM deals d
 WHERE d.company_id=? AND d.created_at>=? AND d.created_at<DATE_ADD(?,INTERVAL 1 DAY) ${ds.sql}
 GROUP BY DATE_FORMAT(d.created_at,'%Y-%m-%d') ORDER BY day`,[t.companyId,from,to,...ds.params]);
 const [tasks]=await db.execute<DayRow[]>(`SELECT DATE_FORMAT(t.completed_at,'%Y-%m-%d') day, COUNT(*) total FROM tasks t
 WHERE t.company_id=? AND t.status='completed' AND t.completed_at>=? AND t.completed_at<DATE_ADD(?,INTERVAL 1 DAY) ${ts.sql}
 GROUP BY DATE_FORMAT(t.completed_at,'%Y-%m-%d') ORDER BY day`,[t.companyId,from,to,...ts.params]);
 return {leads,deals,tasks};
}
