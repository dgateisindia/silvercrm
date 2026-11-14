import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { TenantContext } from '../../core/tenant/tenantContext';
import { AppError } from '../../core/errors/AppError';
import type { InviteRequest } from './invitation.schema';

export type InvitationDb = Pick<PoolConnection,
  'execute' | 'beginTransaction' | 'commit' | 'rollback' | 'release'>;
interface InviteRow extends RowDataPacket {
  readonly id: string | number;
  readonly company_id: string | number;
  readonly requested_by_id: string | number;
  readonly email: string;
  readonly role: 'manager' | 'employee';
  readonly team_id: string | number | null;
  readonly full_name: string;
  readonly idempotency_key: string;
  readonly state: string;
  readonly provider_invitation_id: string | null;
}
interface CountRow extends RowDataPacket { readonly total: number | string; }

async function audit(db: InvitationDb, t: TenantContext,
  action: string, id: string, details: Record<string, unknown>): Promise<void> {
  await db.execute(`INSERT INTO audit_logs
   (company_id,actor_user_id,action,entity_type,entity_id,outcome,request_id,details_json,occurred_at)
   VALUES (?,?,?,'crm_staff_invitation',?,'success',NULL,?,UTC_TIMESTAMP(3))`,
   [t.companyId,t.actorUserId,action,id,JSON.stringify(details)]);
}

async function authorizeAdmin(db: InvitationDb, t: TenantContext,
  role: 'manager' | 'employee', teamId: string | null, revocation = false): Promise<void> {
  if (t.accessMode !== 'FULL' || t.role === 'EMPLOYEE') throw AppError.forbidden();
  const [companies] = await db.execute<RowDataPacket[]>(`SELECT id FROM companies
    WHERE id=? AND status='active' AND platform_access_mode='FULL' LIMIT 1 FOR UPDATE`,[t.companyId]);
  if (!companies.length) throw AppError.forbidden();
  const [users] = await db.execute<RowDataPacket[]>(`SELECT id FROM users
    WHERE company_id=? AND id=? AND status='active' AND role=? LIMIT 1`,
    [t.companyId,t.actorUserId,t.role.toLowerCase()]);
  if (!users.length) throw AppError.forbidden();
  if (t.role === 'OWNER') {
    if (!revocation && (role !== 'manager' || teamId !== null)) throw AppError.forbidden();
    return;
  }
  if (t.role !== 'MANAGER' || role !== 'employee' || teamId === null)
    throw AppError.forbidden();
  const [teams] = await db.execute<RowDataPacket[]>(`SELECT id FROM teams WHERE
    company_id=? AND id=? AND manager_user_id=? AND status='active' LIMIT 1`,
    [t.companyId,teamId,t.actorUserId]);
  if (!teams.length) throw AppError.notFound();
}

function view(r: InviteRow) {
  return { id: String(r.id), email: r.email, fullName: r.full_name,
    role: r.role, teamId: r.team_id === null ? null : String(r.team_id),
    status: r.state, invitationSent: r.state === 'sent',
    requestedBy: String(r.requested_by_id) };
}

export async function reserveInvitation(db: InvitationDb, t: TenantContext,
  request: InviteRequest): Promise<{ id: string; created: boolean; current: ReturnType<typeof view> }> {
  await db.beginTransaction();
  try {
    await authorizeAdmin(db,t,request.role,request.teamId);
    const [old] = await db.execute<InviteRow[]>(`SELECT * FROM crm_staff_invitations
      WHERE company_id=? AND idempotency_key=? LIMIT 1 FOR UPDATE`,
      [t.companyId,request.idempotencyKey]);
    if (old[0]) {
      const previous = old[0];
      if (previous.email !== request.email || previous.role !== request.role ||
          previous.full_name !== request.fullName ||
          (previous.team_id === null ? null : String(previous.team_id)) !== request.teamId)
        throw AppError.conflict();
      await db.commit();
      return { id: String(previous.id), created: false, current: view(previous) };
    }
    const [users] = await db.execute<RowDataPacket[]>(`SELECT id FROM users
      WHERE company_id=? AND LOWER(email)=? LIMIT 1`,[t.companyId,request.email]);
    if (users.length) throw AppError.conflict();
    const [other] = await db.execute<RowDataPacket[]>(`SELECT id FROM crm_staff_invitations
      WHERE company_id=? AND email=? AND state <> 'revoked' LIMIT 1`,
      [t.companyId,request.email]);
    if (other.length) throw AppError.conflict();
    const [rate] = await db.execute<CountRow[]>(`SELECT COUNT(*) total FROM crm_staff_invitations
      WHERE company_id=? AND created_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 HOUR)`,[t.companyId]);
    if (Number(rate[0]?.total ?? 0) >= 20) throw AppError.conflict();
    const [result] = await db.execute<ResultSetHeader>(`INSERT INTO crm_staff_invitations
      (company_id,email,full_name,role,team_id,requested_by_id,idempotency_key,state)
      VALUES(?,?,?,?,?,?,?,'reserved')`,[t.companyId,request.email,request.fullName,
        request.role,request.teamId,t.actorUserId,request.idempotencyKey]);
    const id = String(result.insertId);
    await audit(db,t,'staff.invitation.reserved',id,{role:request.role,teamId:request.teamId});
    await db.commit();
    return { id, created: true, current: {id,email:request.email,fullName:request.fullName,
      role:request.role,teamId:request.teamId,status:'reserved',invitationSent:false,requestedBy:t.actorUserId} };
  } catch (err) { await db.rollback(); throw err; }
}

export async function finalizeInvitation(db: InvitationDb, t: TenantContext,
  id: string, providerId: string | null, state: 'sent' | 'uncertain'): Promise<void> {
  await db.beginTransaction();
  try {
    const [result] = await db.execute<ResultSetHeader>(`UPDATE crm_staff_invitations
      SET state=?,provider_invitation_id=COALESCE(?,provider_invitation_id),updated_at=UTC_TIMESTAMP(3)
      WHERE company_id=? AND id=? AND state='reserved'`,
      [state,providerId,t.companyId,id]);
    if (result.affectedRows !== 1) throw AppError.conflict();
    await audit(db,t,`staff.invitation.${state}`,id,{state});
    await db.commit();
  } catch (err) { await db.rollback(); throw err; }
}

export async function beginRevocation(db: InvitationDb,t:TenantContext,id:string):Promise<string> {
  await db.beginTransaction();
  try {
    const [initial] = await db.execute<InviteRow[]>(`SELECT * FROM crm_staff_invitations
      WHERE company_id=? AND id=? LIMIT 1`,[t.companyId,id]);
    const original=initial[0];
    if(!original)throw AppError.notFound();
    // Lock the company before the invitation, like reservation; avoid lock inversion.
    await authorizeAdmin(db,t,original.role,
      original.team_id === null ? null : String(original.team_id),true);
    const [rows] = await db.execute<InviteRow[]>(`SELECT * FROM crm_staff_invitations
      WHERE company_id=? AND id=? LIMIT 1 FOR UPDATE`,[t.companyId,id]);
    const invitation=rows[0];
    if (!invitation || invitation.role!==original.role ||
        String(invitation.team_id??'')!==String(original.team_id??''))throw AppError.conflict();
    if (invitation.state !== 'sent' || !invitation.provider_invitation_id) throw AppError.conflict();
    await db.execute(`UPDATE crm_staff_invitations SET state='revoking'
      WHERE company_id=? AND id=?`,[t.companyId,id]);
    await audit(db,t,'staff.invitation.revoking',id,{state:'revoking'});
    await db.commit();
    return invitation.provider_invitation_id;
  } catch (err) { await db.rollback(); throw err; }
}

export async function finishRevocation(db:InvitationDb,t:TenantContext,id:string,
  state:'revoked'|'uncertain'):Promise<void> {
  await db.beginTransaction();
  try {
    const [result]=await db.execute<ResultSetHeader>(`UPDATE crm_staff_invitations
      SET state=?,updated_at=UTC_TIMESTAMP(3)
      WHERE company_id=? AND id=? AND state='revoking'`,[state,t.companyId,id]);
    if(result.affectedRows!==1)throw AppError.conflict();
    await audit(db,t,`staff.invitation.${state}`,id,{state});
    await db.commit();
  }catch(err){await db.rollback();throw err;}
}

export async function listInvitations(db:InvitationDb,t:TenantContext,limit:number){
  if(t.role==='EMPLOYEE')throw AppError.forbidden();
  const [users]=await db.execute<RowDataPacket[]>(`SELECT id FROM users
    WHERE company_id=? AND id=? AND status='active' AND role=? LIMIT 1`,
    [t.companyId,t.actorUserId,t.role.toLowerCase()]);
  if(!users.length)throw AppError.forbidden();
  const [rows]=await db.execute<InviteRow[]>(`SELECT i.* FROM crm_staff_invitations i
    WHERE i.company_id=? AND (?='OWNER' OR (i.role='employee' AND EXISTS(
      SELECT 1 FROM teams te WHERE te.company_id=i.company_id AND te.id=i.team_id
        AND te.manager_user_id=? AND te.status='active')))
    ORDER BY i.id DESC LIMIT ?`,[t.companyId,t.role,t.actorUserId,limit]);
  return {items:rows.map(view)};
}
