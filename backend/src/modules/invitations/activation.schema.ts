import { AppError } from '../../core/errors/AppError';
import type { VerifiedInvitationAcceptance, VerifiedPlatformMembership } from './activation.types';
const MAX_U64 = 18446744073709551615n;
export function positiveDbId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value) ||
      BigInt(value) > MAX_U64) throw AppError.badRequest();
  return value;
}
function unsignedDbId(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) ||
      BigInt(value) > MAX_U64) throw AppError.forbidden();
  return value;
}
function validSubject(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{2,128}$/.test(value);
}
function validEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 &&
    value === value.toLowerCase().trim() &&
    /^[^\s@]{1,64}@[^\s@]{1,185}\.[a-z]{2,24}$/.test(value);
}
export function checkVerifiedEvidence(
  providerInvitationId: string,
  expectedEmail: string,
  platformOrgId: string,
  acceptance: VerifiedInvitationAcceptance,
  membership: VerifiedPlatformMembership
): void {
  if (!acceptance || acceptance.accepted !== true ||
      acceptance.providerInvitationId !== providerInvitationId ||
      !validSubject(acceptance.platformUserId) ||
      !validEmail(acceptance.verifiedEmail) ||
      acceptance.verifiedEmail !== expectedEmail) throw AppError.forbidden();
  if (!membership || membership.membershipStatus !== 'active' ||
      membership.accessMode !== 'FULL' ||
      membership.platformOrgId !== platformOrgId ||
      membership.platformUserId !== acceptance.platformUserId ||
      membership.verifiedEmail !== expectedEmail) throw AppError.forbidden();
  // All identifiers are decimal BIGINT strings, never JS numbers, to avoid precision loss.
  positiveDbId(membership.membershipId);
  positiveDbId(membership.productAccessId);
  unsignedDbId(membership.entitlementVersion);
}
