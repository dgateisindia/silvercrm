import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { AppError } from "../../../core/errors/AppError";
import type { TenantContext } from "../../../core/tenant/tenantContext";
import { Db, id, scopedLead, sameManagedTeam, activeEmployee, audit } from "./lead_workflows.common";

interface RequestRow extends RowDataPacket {
 id: string | number | bigint; company_id: string | number | bigint; from_user_id: string | number | bigint;
 to_user_id: string | number | bigint; requested_by_id: string | number | bigint; status: string;
 transfer_type: string; request_mode: string; lead_id: string | number | bigint;
}
export async function requestTransfer(db: Db, tenant: TenantContext, leadId: string, to: string, reason: string, requestId: string | null) {
  const lead = await scopedLead(db, tenant, leadId, true);
  if (tenant.role !== "EMPLOYEE" || lead.ownerUserId !== tenant.actorUserId) throw AppError.forbidden();
  if (to === lead.ownerUserId) throw AppError.badRequest();
  await activeEmployee(db, tenant, to);
  // Require both employees in an active team with a responsible manager.
  const [joint] = await db.execute<RowDataPacket[]>(
    `SELECT t.id FROM teams t
     JOIN team_members a ON a.company_id=t.company_id AND a.team_id=t.id
     JOIN team_members b ON b.company_id=t.company_id AND b.team_id=t.id
     JOIN users manager ON manager.company_id=t.company_id AND manager.id=t.manager_user_id
     WHERE t.company_id=? AND t.status='active' AND manager.status='active'
       AND a.user_id=? AND b.user_id=?
       AND a.left_at IS NULL AND b.left_at IS NULL
       AND a.joined_at<=UTC_TIMESTAMP(3) AND b.joined_at<=UTC_TIMESTAMP(3)
     LIMIT 1`, [tenant.companyId,lead.ownerUserId,to]);
  if (!joint.length) throw AppError.forbidden();
  // Prevent conflicting pending requests against same Lead during a serializing Lead lock.
  const [existing] = await db.execute<RowDataPacket[]>(
    `SELECT tri.id FROM lead_transfer_request_items tri
     JOIN lead_transfer_requests tr ON tr.company_id=tri.company_id AND tr.id=tri.request_id
     WHERE tri.company_id=? AND tri.lead_id=? AND tr.status='pending' LIMIT 1`, [tenant.companyId,leadId]);
  if (existing.length) throw AppError.conflict();
  const [created] = await db.execute<ResultSetHeader>(
    `INSERT INTO lead_transfer_requests (company_id,requested_by_id,from_user_id,to_user_id,transfer_type,request_mode,status,reason)
     VALUES (?,?,?,?,'permanent','employee_request','pending',?)`,
    [tenant.companyId,tenant.actorUserId,lead.ownerUserId,to,reason]);
  const transferId = id(created.insertId);
  await db.execute(
    `INSERT INTO lead_transfer_request_items (company_id,request_id,lead_id,decision) VALUES (?,?,?,'pending')`,
    [tenant.companyId,transferId,leadId]);
  await audit(db,tenant,leadId,"lead.transfer_requested",{transferRequestId:transferId,toUserId:to},requestId);
  return Object.freeze({transferRequestId: transferId, leadId, status:"pending"});
}
export async function decideTransfer(db: Db, tenant: TenantContext, transferId: string, decision: "approved" | "rejected", notes: string | null, requestId: string | null) {
  const [rows] = await db.execute<RequestRow[]>(
    `SELECT tr.id,tr.company_id,tr.from_user_id,tr.to_user_id,tr.requested_by_id,
      tr.status,tr.transfer_type,tr.request_mode,tri.lead_id
     FROM lead_transfer_requests tr
     JOIN lead_transfer_request_items tri ON tri.company_id=tr.company_id AND tri.request_id=tr.id
     WHERE tr.company_id=? AND tr.id=? LIMIT 1 FOR UPDATE`,
    [tenant.companyId,transferId]);
  const request = rows[0];
  if (!request || id(request.company_id)!==tenant.companyId || id(request.id)!==transferId || request.request_mode!=="employee_request" || request.transfer_type!=="permanent") throw AppError.notFound();
  const from = id(request.from_user_id), to=id(request.to_user_id), leadId=id(request.lead_id);
  await sameManagedTeam(db,tenant,from,to);
  if (request.status !== "pending") throw AppError.conflict();
  const lead = await scopedLead(db,tenant,leadId,true);
  if (lead.ownerUserId !== from) throw AppError.conflict();
  if (decision === "approved") {
    await activeEmployee(db,tenant,to);
    const [changed] = await db.execute<ResultSetHeader>(
      `UPDATE leads SET owner_user_id=?,assigned_at=UTC_TIMESTAMP(3),
       updated_at=GREATEST(DATE_ADD(updated_at,INTERVAL 1000 MICROSECOND),UTC_TIMESTAMP(3))
       WHERE company_id=? AND id=? AND owner_user_id=?`,
      [to,tenant.companyId,leadId,from]);
    if (changed.affectedRows!==1) throw AppError.conflict();
    await db.execute(
      `INSERT INTO assignment_history (company_id,entity_type,entity_id,from_user_id,to_user_id,assigned_by_user_id,reason,happened_at)
       VALUES (?,'lead',?,?,?,?,?,UTC_TIMESTAMP(3))`,
      [tenant.companyId,leadId,from,to,tenant.actorUserId,"Employee-requested transfer approved"]);
  }
  await db.execute(
    `UPDATE lead_transfer_requests SET status=?,decided_by_id=?,decided_at=UTC_TIMESTAMP(3)
     WHERE company_id=? AND id=?`,[decision,tenant.actorUserId,tenant.companyId,transferId]);
  await db.execute(
    `UPDATE lead_transfer_request_items SET decision=?,notes=? WHERE company_id=? AND request_id=? AND lead_id=?`,
    [decision,notes,tenant.companyId,transferId,leadId]);
  await audit(db,tenant,leadId,decision==="approved"?"lead.transfer_approved":"lead.transfer_rejected",{transferRequestId:transferId,from,to},requestId);
  return Object.freeze({transferRequestId:transferId,leadId,status:decision,fromUserId:from,toUserId:to});
}
export async function pendingTransfers(db: Db, tenant: TenantContext, limit: number) {
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT tr.id,tri.lead_id,tr.from_user_id,tr.to_user_id,tr.reason,tr.created_at
     FROM lead_transfer_requests tr
     JOIN lead_transfer_request_items tri ON tri.company_id=tr.company_id AND tri.request_id=tr.id
     WHERE tr.company_id=? AND tr.status='pending' AND tr.request_mode='employee_request'
       AND EXISTS (
         SELECT 1 FROM teams t
         JOIN team_members a ON a.company_id=t.company_id AND a.team_id=t.id
         JOIN team_members b ON b.company_id=t.company_id AND b.team_id=t.id
         WHERE t.company_id=tr.company_id AND t.manager_user_id=? AND t.status='active'
           AND a.user_id=tr.from_user_id AND b.user_id=tr.to_user_id
           AND a.left_at IS NULL AND b.left_at IS NULL
           AND a.joined_at<=UTC_TIMESTAMP(3) AND b.joined_at<=UTC_TIMESTAMP(3)
       ) ORDER BY tr.id DESC LIMIT ?`,[tenant.companyId,tenant.actorUserId,limit]);
  return rows.map(r=>({id:id(r.id),leadId:id(r.lead_id),fromUserId:id(r.from_user_id),toUserId:id(r.to_user_id),reason:String(r.reason),createdAt:r.created_at}));
}