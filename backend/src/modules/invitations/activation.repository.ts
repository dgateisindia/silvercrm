import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { AppError } from '../../core/errors/AppError';
import { positiveDbId, checkVerifiedEvidence } from './activation.schema';
import type { InvitationActivationResult, VerifiedInvitationAcceptance, VerifiedPlatformMembership } from './activation.types';

export type ActivationDb = Pick<PoolConnection,
  'execute' | 'beginTransaction' | 'commit' | 'rollback' | 'release'>;
interface InvitationRow extends RowDataPacket {
  id: string | number;
  company_id: string | number;
  email: string;
  full_name: string;
  role: 'manager' | 'employee';
  team_id: string | number | null;
  requested_by_id: string | number;
  state: string;
  provider_invitation_id: string | null;
  platform_org_id: string;
}
interface CompanyRow extends RowDataPacket {
  id: string | number;
  platform_org_id: string;
  platform_entitlement_version: string | number;
  status: string;
  platform_access_mode: string;
  fresh: number | string;
}
interface ExistingUser extends RowDataPacket {
  id: string | number;
  platform_user_id: string;
  email: string;
  role: string;
  status: string;
}

/** Read-only lookup. The actual invitation and company are locked again inside the transaction. */
export async function loadActivationTarget(
  db: ActivationDb, companyId: string, invitationId: string
): Promise<InvitationRow> {
  positiveDbId(companyId);
  positiveDbId(invitationId);
  const [rows] = await db.execute<InvitationRow[]>(`SELECT i.*,c.platform_org_id
    FROM crm_staff_invitations i JOIN companies c ON c.id=i.company_id
    WHERE i.company_id=? AND i.id=? AND i.state IN ('sent','provisioned')
      AND i.provider_invitation_id IS NOT NULL LIMIT 1`,[companyId,invitationId]);
  const row=rows[0];
  if(!row || !row.provider_invitation_id) throw AppError.notFound();
  return row;
}

/** Transaction is the sole creator of CRM membership. Never expose this through a public route. */
export async function commitVerifiedActivation(
  db: ActivationDb, companyId: string, invitationId: string,
  acceptance: VerifiedInvitationAcceptance, membership: VerifiedPlatformMembership
): Promise<InvitationActivationResult> {
  positiveDbId(companyId);
  positiveDbId(invitationId);
  await db.beginTransaction();
  try {
    // Lock order company -> invitation -> user/team. Matches existing invitation reservation lock order.
    const [companies]=await db.execute<CompanyRow[]>(`SELECT id,platform_org_id,
      platform_entitlement_version,status,platform_access_mode,
      (platform_checked_at IS NOT NULL AND
       TIMESTAMPDIFF(SECOND,platform_checked_at,UTC_TIMESTAMP(3)) BETWEEN -30 AND 300) AS fresh
      FROM companies WHERE id=? LIMIT 1 FOR UPDATE`,[companyId]);
    const company=companies[0];
    if(!company || company.status!=='active' || company.platform_access_mode!=='FULL' ||
       Number(company.fresh)!==1) throw AppError.forbidden();
    const [invitations]=await db.execute<InvitationRow[]>(`SELECT i.*, c.platform_org_id
      FROM crm_staff_invitations i JOIN companies c ON c.id=i.company_id
      WHERE i.company_id=? AND i.id=? LIMIT 1 FOR UPDATE`,[companyId,invitationId]);
    const inv=invitations[0];
    if(!inv || !inv.provider_invitation_id ||
       (inv.state!=='sent' && inv.state!=='provisioned')) throw AppError.conflict();
    checkVerifiedEvidence(inv.provider_invitation_id,inv.email,company.platform_org_id,acceptance,membership);
    if (BigInt(String(company.platform_entitlement_version)) !== BigInt(membership.entitlementVersion))
      throw AppError.conflict();
    if (inv.role!=='employee' && inv.role!=='manager') throw AppError.forbidden();
    if (inv.role==='manager' && inv.team_id!==null) throw AppError.conflict();
    if (inv.role==='employee' && inv.team_id===null) throw AppError.conflict();
    // Account created by an approved invitation requires the inviter still has authority.
    const authorizedRole=inv.role==='manager'?'owner':'manager';
    const [admins]=await db.execute<RowDataPacket[]>(`SELECT id FROM users
      WHERE company_id=? AND id=? AND role=? AND status='active' LIMIT 1`,
      [companyId,String(inv.requested_by_id),authorizedRole]);
    if(!admins.length) throw AppError.forbidden();
    if(inv.role==='employee'){
      const [teams]=await db.execute<RowDataPacket[]>(`SELECT id FROM teams WHERE company_id=?
        AND id=? AND manager_user_id=? AND status='active' LIMIT 1`,
        [companyId,String(inv.team_id),String(inv.requested_by_id)]);
      if(!teams.length) throw AppError.forbidden();
    }
    const [users]=await db.execute<ExistingUser[]>(`SELECT id,platform_user_id,email,role,status
      FROM users WHERE company_id=? AND (platform_user_id=? OR LOWER(email)=?) FOR UPDATE`,
      [companyId,membership.platformUserId,inv.email]);
    if(inv.state==='provisioned'){
      const prior=users[0];
      if(users.length!==1 || !prior || prior.platform_user_id!==membership.platformUserId ||
         prior.email.toLowerCase()!==inv.email || prior.role!==inv.role || prior.status!=='active')
         throw AppError.conflict();
      await db.commit();
      return {invitationId,crmUserId:String(prior.id),role:inv.role,state:'already_provisioned'};
    }
    // Any existing identity/email must be reviewed manually, rather than silently linked.
    if(users.length!==0) throw AppError.conflict();
    const [insert]=await db.execute<ResultSetHeader>(`INSERT INTO users
      (company_id,platform_user_id,full_name,email,role,status,platform_membership_id,
       platform_product_access_id,activated_at) VALUES(?,?,?,?,?,'active',?,?,UTC_TIMESTAMP(3))`,
      [companyId,membership.platformUserId,inv.full_name,inv.email,inv.role,
       membership.membershipId,membership.productAccessId]);
    if (!Number.isSafeInteger(insert.insertId) || insert.insertId < 1)
      throw Error('CRM_ACTIVATION_UNSAFE_INSERT_ID');
    const crmUserId=String(insert.insertId);
    if(inv.role==='employee'){
      await db.execute(`INSERT INTO team_members
        (company_id,team_id,user_id,joined_at) VALUES(?,?,?,UTC_TIMESTAMP(3))`,
        [companyId,String(inv.team_id),crmUserId]);
    }
    const [changed]=await db.execute<ResultSetHeader>(`UPDATE crm_staff_invitations
      SET state='provisioned',updated_at=UTC_TIMESTAMP(3)
      WHERE company_id=? AND id=? AND state='sent'`,[companyId,invitationId]);
    if(changed.affectedRows!==1) throw AppError.conflict();
    // Minimal audit: no Clerk token, email, secret, or full provider response.
    await db.execute(`INSERT INTO audit_logs
      (company_id,actor_user_id,action,entity_type,entity_id,outcome,request_id,details_json,occurred_at)
      VALUES(?,NULL,'staff.invitation.provisioned','crm_staff_invitation',?,
      'success',NULL,?,UTC_TIMESTAMP(3))`,
      [companyId,invitationId,JSON.stringify({role:inv.role,crmUserId,source:'trusted_platform_membership'})]);
    await db.commit();
    return {invitationId,crmUserId,role:inv.role,state:'provisioned'};
  }catch(error){await db.rollback();throw error;}
}
