/**
 * Trust boundary for CRM invitation provisioning.
 * These results MUST be obtained by server-side verification against both providers.
 * Browser requests, Clerk public metadata and unsigned webhooks cannot instantiate
 * the providers or invoke the provisioning service.
 */
export interface VerifiedInvitationAcceptance {
  readonly providerInvitationId: string;
  readonly platformUserId: string;
  readonly verifiedEmail: string;
  readonly accepted: true;
}
export interface VerifiedPlatformMembership {
  readonly platformOrgId: string;
  readonly platformUserId: string;
  readonly verifiedEmail: string;
  readonly membershipId: string;
  readonly productAccessId: string;
  readonly membershipStatus: 'active';
  readonly accessMode: 'FULL';
  /** Exact nonnegative version from the trusted Platform, represented losslessly. */
  readonly entitlementVersion: string;
}
export interface AcceptanceVerificationProvider {
  verifyAcceptedInvitation(providerInvitationId: string): Promise<VerifiedInvitationAcceptance>;
}
export interface PlatformMembershipVerificationProvider {
  verifyActiveMembership(
    platformOrgId: string, platformUserId: string
  ): Promise<VerifiedPlatformMembership>;
}
export interface InvitationActivationResult {
  readonly invitationId: string;
  readonly crmUserId: string;
  readonly role: 'manager' | 'employee';
  readonly state: 'provisioned' | 'already_provisioned';
}
