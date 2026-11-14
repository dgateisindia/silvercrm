import type { Response } from 'express';
import { getDbPool } from '../../core/database/pool';
import { getTenantContext } from '../../core/tenant/tenantContext';
import { AppError } from '../../core/errors/AppError';
import { inviteId, inviteLimit, inviteRequest } from './invitation.schema';
import type { InvitationDb } from './invitation.repository';
import { reserveInvitation,finalizeInvitation,beginRevocation,finishRevocation,
  listInvitations } from './invitation.repository';
import { configuredClerkInvitationProvider,type StaffInvitationProvider } from './invitation.provider';

export interface InvitationDependencies {
  readonly connectionFactory?: () => Promise<InvitationDb>;
  readonly providerFactory?: () => StaffInvitationProvider;
}

export function createInvitationService(deps: InvitationDependencies = {}) {
  const factory = deps.connectionFactory ?? (() => getDbPool().getConnection());
  const providerFactory = deps.providerFactory ?? configuredClerkInvitationProvider;
  function enabled(): void {
    const live = process.env.NODE_ENV === 'production' && process.env.AUTH_MODE === 'platform';
    const mockTest = process.env.NODE_ENV === 'test' && deps.providerFactory !== undefined;
    if (process.env.CRM_STAFF_INVITATIONS_ENABLED !== 'true' || (!live && !mockTest))
      throw AppError.forbidden();
  }
  async function withDb<T>(fn: (db: InvitationDb) => Promise<T>): Promise<T> {
    const db = await factory();
    try { return await fn(db); }
    finally { db.release(); }
  }
  return Object.freeze({
    async list(res: Response, q: Record<string,unknown>) {
      enabled();
      const t = getTenantContext(res);
      const limit=inviteLimit(q);
      return withDb(db => listInvitations(db,t,limit));
    },
    async send(res: Response, body: unknown) {
      enabled();
      const t = getTenantContext(res);
      const request = inviteRequest(body);
      const reservation = await withDb(db => reserveInvitation(db,t,request));
      if (!reservation.created) return reservation.current;
      let providerId: string;
      try {
        // Only reached after DB reservation and tenant/role checks. No passwords or
        // CRM roles are ever supplied as public Clerk invitation metadata.
        const sent = await providerFactory().send(request.email);
        providerId = sent.id;
      } catch {
        // Delivery may have occurred despite a timeout; NEVER auto-retry the send.
        try { await withDb(db => finalizeInvitation(db,t,reservation.id,null,'uncertain')); }
        catch { /* reservation remains blocked; an operator must reconcile */ }
        throw AppError.conflict();
      }
      await withDb(db => finalizeInvitation(db,t,reservation.id,providerId,'sent'));
      return { ...reservation.current,status:'sent',invitationSent:true };
    },
    async revoke(res: Response, rawId: unknown) {
      enabled();
      const t = getTenantContext(res);
      const id = inviteId(rawId);
      const providerId = await withDb(db => beginRevocation(db,t,id));
      try { await providerFactory().revoke(providerId); }
      catch {
        try { await withDb(db => finishRevocation(db,t,id,'uncertain')); }
        catch { /* needs operator reconciliation; never auto-revoke twice */ }
        throw AppError.conflict();
      }
      await withDb(db => finishRevocation(db,t,id,'revoked'));
      return {id,status:'revoked',invitationSent:false};
    }
  });
}
