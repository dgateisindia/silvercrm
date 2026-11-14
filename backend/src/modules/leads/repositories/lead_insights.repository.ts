import type { RowDataPacket } from "mysql2/promise";
import {AppError} from "../../../core/errors/AppError";
import type {TenantContext} from "../../../core/tenant/tenantContext";
import {Db,id,scopedLead} from "./lead_workflows.common";

/** This intentionally exposes only authorized lead-scoped data, not raw audit payloads. */
export async function leadTimeline(db:Db,tenant:TenantContext,leadId:string,limit:number) {
 await scopedLead(db,tenant,leadId);
 const [statuses]=await db.execute<RowDataPacket[]>(
  `SELECT id,old_status,new_status,changed_by_id,changed_at
   FROM crm_lead_status_history WHERE company_id=? AND lead_id=? ORDER BY id DESC LIMIT ?`,
  [tenant.companyId,leadId,limit]);
 const [assignments]=await db.execute<RowDataPacket[]>(
  `SELECT id,from_user_id,to_user_id,assigned_by_user_id,happened_at
   FROM assignment_history WHERE company_id=? AND entity_type='lead' AND entity_id=? ORDER BY id DESC LIMIT ?`,
  [tenant.companyId,leadId,limit]);
 const [logs]=await db.execute<RowDataPacket[]>(
  `SELECT id,action,actor_user_id,occurred_at
   FROM audit_logs WHERE company_id=? AND entity_type='lead' AND entity_id=? ORDER BY id DESC LIMIT ?`,
  [tenant.companyId,leadId,limit]);
 const events=[
  ...statuses.map(s=>({type:"status",eventId:id(s.id),at:s.changed_at,actorId:id(s.changed_by_id),before:s.old_status,after:s.new_status})),
  ...assignments.map(s=>({type:"assignment",eventId:id(s.id),at:s.happened_at,actorId:id(s.assigned_by_user_id),before:s.from_user_id===null?null:id(s.from_user_id),after:id(s.to_user_id)})),
  ...logs.map(s=>({type:"audit",eventId:id(s.id),at:s.occurred_at,actorId:s.actor_user_id===null?null:id(s.actor_user_id),action:s.action})),
 ];
 return events.sort((a,b)=>new Date(b.at).getTime()-new Date(a.at).getTime()).slice(0,limit);
}
/** Same-company, same-role-view potential matches. Title similarity is only a review signal. */
export async function potentialDuplicates(db:Db,tenant:TenantContext,leadId:string,limit:number) {
 const lead=await scopedLead(db,tenant,leadId);
 const clauses=["l.company_id=?","l.id<>?","LOWER(TRIM(l.title))=LOWER(TRIM(?))"];
 const args:(string|number)[]=[tenant.companyId,leadId,lead.title];
 if(tenant.role==="EMPLOYEE") {
  clauses.push("l.owner_user_id=?");args.push(tenant.actorUserId);
 } else if(tenant.role==="MANAGER") {
  clauses.push(`(l.owner_user_id=? OR EXISTS (
   SELECT 1 FROM team_members tm JOIN teams t ON t.company_id=tm.company_id AND t.id=tm.team_id
   WHERE tm.company_id=l.company_id AND tm.user_id=l.owner_user_id
     AND tm.left_at IS NULL AND tm.joined_at<=UTC_TIMESTAMP(3)
     AND t.manager_user_id=? AND t.status='active'))`);
  args.push(tenant.actorUserId,tenant.actorUserId);
 }
 args.push(limit);
 const [rows]=await db.execute<RowDataPacket[]>(
  `SELECT l.id,l.title,l.status,l.owner_user_id FROM leads l WHERE ${clauses.join(" AND ")}
   ORDER BY l.id DESC LIMIT ?`,args);
 return rows.map(r=>({id:id(r.id),title:String(r.title),status:String(r.status),ownerUserId:id(r.owner_user_id),matchReason:"exact_normalized_title"}));
}
export async function statusCounts(db:Db,tenant:TenantContext) {
 const clauses=["l.company_id=?"];
 const args:string[]=[tenant.companyId];
 if(tenant.role==="EMPLOYEE") {clauses.push("l.owner_user_id=?");args.push(tenant.actorUserId);}
 else if(tenant.role==="MANAGER") {
  clauses.push(`(l.owner_user_id=? OR EXISTS(
    SELECT 1 FROM team_members tm JOIN teams t ON t.company_id=tm.company_id AND t.id=tm.team_id
    WHERE tm.company_id=l.company_id AND tm.user_id=l.owner_user_id
      AND tm.left_at IS NULL AND tm.joined_at<=UTC_TIMESTAMP(3)
      AND t.manager_user_id=? AND t.status='active'))`);
  args.push(tenant.actorUserId,tenant.actorUserId);
 }
 const [rows]=await db.execute<RowDataPacket[]>(
  `SELECT l.status,COUNT(*) AS total FROM leads l WHERE ${clauses.join(" AND ")}
   GROUP BY l.status ORDER BY l.status ASC LIMIT 201`,args);
 if(rows.length>200) throw AppError.conflict();
 const groups=rows.map(r=>({status:String(r.status),count:Number(r.total)}));
 if(groups.some(g=>!Number.isSafeInteger(g.count)||g.count<0)) throw Error("Unsafe count");
 return {total:groups.reduce((n,g)=>n+g.count,0),byStatus:groups};
}