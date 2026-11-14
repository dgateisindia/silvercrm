import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { getDbPool } from '../database/pool';

const ORG_ID = /^[a-zA-Z0-9_-]{2,128}$/;
const USER_ID = /^[a-zA-Z0-9._:-]{1,128}$/;
type Db = Pick<PoolConnection, 'execute' | 'beginTransaction' | 'commit' | 'rollback' | 'release' | 'destroy'>;
interface MemberRow extends RowDataPacket {
  id: string | number | bigint;
  company_id: string | number | bigint;
  status: 'pending' | 'active' | 'inactive' | 'suspended';
}

/**
 * A trusted Platform revocation can only REDUCE access.
 * It must never create a user, grant a CRM role or reactivate a local account.
 * Run before applying the entitlement heartbeat, so an audit failure cannot
 * make an unrevoked user appear freshly authorized.
 */
export function createTrustedMembershipRevoker(settings: {
  readonly connectionFactory: () => Promise<Db>;
}) {
  return Object.freeze({
    async revoke(platformOrgId: string, platformUserId: string): Promise<'suspended' | 'already_suspended' | 'not_found'> {
      if (!ORG_ID.test(platformOrgId) || !USER_ID.test(platformUserId)) {
        throw new Error('PLATFORM_MEMBERSHIP_INVALID');
      }
      let db: Db | undefined;
      let begun = false;
      try {
        db = await settings.connectionFactory();
        await db.beginTransaction();
        begun = true;
        const [rows] = await db.execute<MemberRow[]>(`
          SELECT u.id, u.company_id, u.status FROM users u
          INNER JOIN companies c ON c.id=u.company_id
          WHERE c.platform_org_id=? AND u.platform_user_id=?
          LIMIT 1 FOR UPDATE`, [platformOrgId, platformUserId]);
        const member = rows[0];
        if (!member) {
          await db.commit(); begun = false;
          return 'not_found';
        }
        if (member.status === 'suspended') {
          await db.commit(); begun = false;
          return 'already_suspended';
        }
        const companyId = String(member.company_id);
        const userId = String(member.id);
        await db.execute(`UPDATE users SET status='suspended' WHERE company_id=? AND id=?`, [companyId, userId]);
        await db.execute(`INSERT INTO audit_logs
          (company_id,actor_user_id,action,entity_type,entity_id,outcome,request_id,details_json,occurred_at)
          VALUES(?,NULL,'platform.membership.revoked','user',?,'success',NULL,?,UTC_TIMESTAMP(3))`,
          [companyId, userId, JSON.stringify({ source: 'trusted_platform_reconciliation' })]);
        await db.commit(); begun = false;
        return 'suspended';
      } catch (error) {
        if (db && begun) {
          try { await db.rollback(); }
          catch { db.destroy(); }
        }
        throw error;
      } finally {
        db?.release();
      }
    },
  });
}

export function createProductionMembershipRevoker() {
  return createTrustedMembershipRevoker({ connectionFactory: () => getDbPool().getConnection() });
}