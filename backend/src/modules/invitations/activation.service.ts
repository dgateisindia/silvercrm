import { getDbPool } from '../../core/database/pool';
import { AppError } from '../../core/errors/AppError';
import { positiveDbId } from './activation.schema';
import { loadActivationTarget,commitVerifiedActivation,type ActivationDb } from './activation.repository';
import type { AcceptanceVerificationProvider, PlatformMembershipVerificationProvider } from './activation.types';

export interface InvitationActivationDependencies {
  readonly connectionFactory: () => Promise<ActivationDb>;
  readonly acceptanceProvider: AcceptanceVerificationProvider;
  readonly membershipProvider: PlatformMembershipVerificationProvider;
}

/**
 * Internal use only. There is intentionally NO public HTTP route and no production
 * provider factory, because the external Platform and Clerk acceptance contracts
 * have not yet been signed off by the Platform team.
 */
export function createTrustedInvitationActivator(deps: InvitationActivationDependencies) {
  if(!deps || typeof deps.connectionFactory!=='function' ||
     typeof deps.acceptanceProvider?.verifyAcceptedInvitation!=='function' ||
     typeof deps.membershipProvider?.verifyActiveMembership!=='function')
    throw Error('CRM_TRUSTED_ACTIVATION_PROVIDERS_REQUIRED');
  async function withDb<T>(fn:(db:ActivationDb)=>Promise<T>):Promise<T>{
    const db=await deps.connectionFactory();
    try{return await fn(db);}finally{db.release();}
  }
  return Object.freeze({
    async activate(companyId:string, invitationId:string) {
      if(process.env.NODE_ENV!=='test' &&
         (process.env.NODE_ENV!=='production' || process.env.AUTH_MODE!=='platform'))
        throw AppError.forbidden();
      if(process.env.CRM_STAFF_ACTIVATION_ENABLED!=='true') throw AppError.forbidden();
      positiveDbId(companyId);positiveDbId(invitationId);
      const target=await withDb(db=>loadActivationTarget(db,companyId,invitationId));
      if(!target.provider_invitation_id) throw AppError.forbidden();
      const accepted=await deps.acceptanceProvider.verifyAcceptedInvitation(target.provider_invitation_id);
      // Platform membership must be looked up independently using the verified subject.
      if(!accepted || accepted.accepted!==true || !accepted.platformUserId)
        throw AppError.forbidden();
      const membership=await deps.membershipProvider.verifyActiveMembership(
        target.platform_org_id,accepted.platformUserId
      );
      return withDb(db=>commitVerifiedActivation(db,companyId,invitationId,accepted,membership));
    }
  });
}

/** Convenience database factory, not a provider implementation or activation switch. */
export function crmActivationConnectionFactory():Promise<ActivationDb>{
  return getDbPool().getConnection();
}
