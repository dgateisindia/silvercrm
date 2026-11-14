import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { AppError } from "../../../core/errors/AppError";
import type { TenantContext } from "../../../core/tenant/tenantContext";
import {Db,id,scopedLead,audit} from "./lead_workflows.common";
import type {followupInput} from "../schemas/lead_workflows.schema";

type FollowupInput = ReturnType<typeof followupInput>;
export async function addFollowup(db:Db,tenant:TenantContext,leadId:string,data:FollowupInput,requestId:string|null) {
 const lead=await scopedLead(db,tenant,leadId,true);
 const dueAt=data.dueAt === null ? null : data.dueAt.replace("T"," ").replace("Z","");
 const [result]=await db.execute<ResultSetHeader>(
  `INSERT INTO tasks(company_id,title,description,owner_user_id,lead_id,due_at,status,priority)
   VALUES (?,?,?,?,?,?,'open','normal')`,
  [tenant.companyId,data.title,data.description,lead.ownerUserId,leadId,dueAt]);
 const taskId=id(result.insertId);
 await audit(db,tenant,leadId,"lead.followup_created",{taskId},requestId);
 return Object.freeze({id:taskId,leadId,ownerUserId:lead.ownerUserId,status:"open"});
}
export async function listFollowups(db:Db,tenant:TenantContext,leadId:string,limit:number) {
 await scopedLead(db,tenant,leadId);
 const [rows]=await db.execute<RowDataPacket[]>(
  `SELECT id,title,description,owner_user_id,due_at,status,priority,completed_at
   FROM tasks WHERE company_id=? AND lead_id=? ORDER BY id DESC LIMIT ?`,
  [tenant.companyId,leadId,limit]);
 return rows.map(r=>({id:id(r.id),title:String(r.title),description:r.description,ownerUserId:id(r.owner_user_id),dueAt:r.due_at,status:r.status,priority:r.priority,completedAt:r.completed_at}));
}
export async function completeFollowup(db:Db,tenant:TenantContext,leadId:string,taskId:string,requestId:string|null) {
 await scopedLead(db,tenant,leadId,true);
 const [rows]=await db.execute<RowDataPacket[]>(
  `SELECT id,owner_user_id,status FROM tasks WHERE company_id=? AND lead_id=? AND id=? LIMIT 1 FOR UPDATE`,
  [tenant.companyId,leadId,taskId]);
 const row=rows[0];
 if(!row) throw AppError.notFound();
 if(tenant.role==="EMPLOYEE" && id(row.owner_user_id)!==tenant.actorUserId) throw AppError.notFound();
 if(row.status!=="open") throw AppError.conflict();
 const [result]=await db.execute<ResultSetHeader>(
  `UPDATE tasks SET status='completed',completed_at=UTC_TIMESTAMP(3)
   WHERE company_id=? AND lead_id=? AND id=? AND status='open'`,[tenant.companyId,leadId,taskId]);
 if(result.affectedRows!==1) throw AppError.conflict();
 await audit(db,tenant,leadId,"lead.followup_completed",{taskId},requestId);
 return Object.freeze({id:taskId,leadId,status:"completed"});
}