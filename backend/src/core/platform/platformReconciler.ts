import type { RowDataPacket } from 'mysql2/promise';
import { getDbPool } from '../database/pool';
import { createProductionPlatformSnapshotApplier } from './platformSnapshot';
import { createProductionMembershipRevoker } from './platformMemberRevocation';
import { createProductionPlatformSyncTransport } from './platformSyncTransport';
import type { PlatformSyncEnvelope } from './platformSyncTransport';

const MAX_COMPANIES_PER_RUN = 1000;
interface OrgRow extends RowDataPacket {
  id: string | number | bigint;
  platform_org_id: string;
}

export interface ReconciliationSummary {
  readonly scanned: number;
  readonly applied: number;
  readonly heartbeats: number;
  readonly stale: number;
  readonly membershipsSuspended: number;
  readonly failed: number;
  readonly hasMore: boolean;
}
export interface PlatformReconciliationOptions {
  readonly fetchSnapshot: (platformOrgId: string) => Promise<PlatformSyncEnvelope>;
  readonly revokeMembership: (org: string, user: string) => Promise<'suspended' | 'already_suspended' | 'not_found'>;
  readonly applySnapshot: (snapshot: PlatformSyncEnvelope['snapshot']) => Promise<{ outcome: 'applied' | 'heartbeat' | 'stale' }>;
  readonly listCompanies: (afterId: string, limit: number) => Promise<readonly { id: string; platformOrgId: string }[]>;
}

/**
 * Reconcile a bounded page of existing CRM tenants against an authenticated
 * Platform adapter. A failure is counted, never converted into an entitlement
 * grant or a fresh heartbeat. Individual failures do not stop other tenants.
 */
export function createPlatformReconciler(settings: PlatformReconciliationOptions) {
  if (!settings || typeof settings.fetchSnapshot !== 'function' ||
      typeof settings.revokeMembership !== 'function' ||
      typeof settings.applySnapshot !== 'function' ||
      typeof settings.listCompanies !== 'function') {
    throw new Error('PLATFORM_RECONCILER_INVALID_SETTINGS');
  }
  return Object.freeze({
    async runOnce(): Promise<ReconciliationSummary> {
      let scanned = 0;
      let applied = 0;
      let heartbeats = 0;
      let stale = 0;
      let membershipsSuspended = 0;
      let failed = 0;
      let cursor = '0';
      let hasMore = false;
      while (scanned < MAX_COMPANIES_PER_RUN) {
        const limit = Math.min(50, MAX_COMPANIES_PER_RUN - scanned);
        const companies = await settings.listCompanies(cursor, limit);
        if (companies.length === 0) break;
        if (companies.length > limit) throw new Error('PLATFORM_RECONCILER_INVALID_PAGE');
        for (const company of companies) {
          if (BigInt(company.id) <= BigInt(cursor)) throw new Error('PLATFORM_RECONCILER_INVALID_CURSOR');
          cursor = company.id;
          scanned++;
          try {
            const received = await settings.fetchSnapshot(company.platformOrgId);
            if (received.snapshot.platformOrgId !== company.platformOrgId) {
              throw new Error('PLATFORM_RECONCILER_ORG_MISMATCH');
            }
            // Process revocations first. A later grant/heartbeat cannot conceal
            // a failed revoke: the run fails for this org before applying it.
            for (const userId of received.revokedPlatformUserIds) {
              const result = await settings.revokeMembership(company.platformOrgId, userId);
              if (result === 'suspended') membershipsSuspended++;
            }
            const result = await settings.applySnapshot(received.snapshot);
            if (result.outcome === 'applied') applied++;
            else if (result.outcome === 'heartbeat') heartbeats++;
            else stale++;
          } catch {
            // Do not log provider tokens, user IDs or response bodies.
            // Missing fresh heartbeat will lead the platform access guard to
            // reject access when its configured max-age is exceeded.
            failed++;
          }
        }
        if (companies.length < limit) break;
        if (scanned === MAX_COMPANIES_PER_RUN) {
          hasMore = (await settings.listCompanies(cursor, 1)).length > 0;
        }
      }
      return Object.freeze({ scanned, applied, heartbeats, stale, membershipsSuspended, failed, hasMore });
    },
  });
}

export function createProductionPlatformReconciler() {
  if (process.env.NODE_ENV !== 'production' || process.env.AUTH_MODE !== 'platform') {
    throw new Error('PLATFORM_RECONCILER_PRODUCTION_MODE_REQUIRED');
  }
  const transport = createProductionPlatformSyncTransport();
  const revoker = createProductionMembershipRevoker();
  const applier = createProductionPlatformSnapshotApplier();
  const pool = getDbPool();
  return createPlatformReconciler({
    fetchSnapshot: org => transport.fetchCompanySnapshot(org),
    revokeMembership: (org, user) => revoker.revoke(org, user),
    applySnapshot: snapshot => applier.apply(snapshot),
    listCompanies: async (afterId, limit) => {
      const [rows] = await pool.execute<OrgRow[]>(`
        SELECT id, platform_org_id FROM companies
        WHERE id > ? ORDER BY id ASC LIMIT ?`, [afterId, limit]);
      return rows.map(row => ({ id: String(row.id), platformOrgId: row.platform_org_id }));
    },
  });
}