import { describe, expect, it } from 'vitest';
import { checkVerifiedEvidence, positiveDbId } from '../../src/modules/invitations/activation.schema';
import type { VerifiedInvitationAcceptance, VerifiedPlatformMembership } from '../../src/modules/invitations/activation.types';

const accepted: VerifiedInvitationAcceptance = {
  providerInvitationId: 'inv_0001', platformUserId: 'user_0001',
  verifiedEmail: 'member@example.com', accepted: true
};
const member: VerifiedPlatformMembership = {
  platformOrgId: 'org_0001', platformUserId: 'user_0001',
  verifiedEmail: 'member@example.com', membershipId: '42', productAccessId: '13',
  membershipStatus: 'active', accessMode: 'FULL', entitlementVersion: '5'
};
const valid = (a: VerifiedInvitationAcceptance = accepted, m: VerifiedPlatformMembership = member) =>
  checkVerifiedEvidence('inv_0001', 'member@example.com', 'org_0001', a, m);

describe('Trusted staff activation evidence (no providers)', () => {
  it('accepts consistent provider-verified evidence', () => expect(() => valid()).not.toThrow());
  it('rejects invitation identifier or email mismatches', () => {
    expect(() => valid({ ...accepted, providerInvitationId: 'inv_9999' })).toThrow();
    expect(() => valid({ ...accepted, verifiedEmail: 'other@example.com' })).toThrow();
  });
  it('rejects inactive membership, access downgrade and wrong organization', () => {
    expect(() => valid(accepted, { ...member, membershipStatus: 'inactive' as 'active' })).toThrow();
    expect(() => valid(accepted, { ...member, accessMode: 'READ_ONLY' as 'FULL' })).toThrow();
    expect(() => valid(accepted, { ...member, platformOrgId: 'org_other' })).toThrow();
  });
  it('rejects a mismatched platform identity', () => {
    expect(() => valid(accepted, { ...member, platformUserId: 'user_other' })).toThrow();
  });
  it('rejects malformed membership ids and entitlement versions', () => {
    expect(() => valid(accepted, { ...member, membershipId: '0' })).toThrow();
    expect(() => valid(accepted, { ...member, productAccessId: '-2' })).toThrow();
    expect(() => valid(accepted, { ...member, entitlementVersion: '-1' })).toThrow();
    expect(() => valid(accepted, { ...member, entitlementVersion: '18446744073709551616' })).toThrow();
  });
  it('preserves the full unsigned database id range', () => {
    expect(positiveDbId('18446744073709551615')).toBe('18446744073709551615');
    expect(() => positiveDbId('18446744073709551616')).toThrow();
  });
});
