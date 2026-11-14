import { describe, expect, it } from 'vitest';
import { inviteId, inviteLimit, inviteRequest } from '../../src/modules/invitations/invitation.schema';

const manager = () => ({
  email: ' MANAGER@EXAMPLE.COM ', fullName: '  Example Manager  ', role: 'manager',
  teamId: null, idempotencyKey: 'manager-request-0001'
});
const employee = () => ({
  email: 'employee@example.com', fullName: 'Example Employee', role: 'employee',
  teamId: '23', idempotencyKey: 'employee-request-0001'
});

describe('Clerk invitation input contract (no network)', () => {
  it('normalizes email/name for a manager invitation', () => {
    const value = inviteRequest(manager());
    expect(value.email).toBe('manager@example.com');
    expect(value.fullName).toBe('Example Manager');
    expect(value.teamId).toBeNull();
    expect(Object.isFrozen(value)).toBe(true);
  });
  it('requires a valid team for employees', () => {
    expect(inviteRequest(employee()).teamId).toBe('23');
    expect(() => inviteRequest({ ...employee(), teamId: null })).toThrow();
  });
  it('rejects assigning managers directly to an employee team', () => {
    expect(() => inviteRequest({ ...manager(), teamId: '23' })).toThrow();
  });
  it.each([
    { ...manager(), role: 'owner' },
    { ...manager(), email: 'invalid' },
    { ...manager(), fullName: '' },
    { ...manager(), idempotencyKey: 'short' },
    { ...manager(), companyId: '999' },
    Object.assign(Object.create(null), { ...manager(), unexpected: 'x' }),
    null, [], 'wrong-body'
  ])('rejects malformed invitation payload %#', (value: unknown) => {
    expect(() => inviteRequest(value)).toThrow();
  });
  it('rejects invalid or overflowing invitation ids', () => {
    expect(inviteId('18446744073709551615')).toBe('18446744073709551615');
    for (const invalid of ['0', '-1', '1.0', '18446744073709551616', 1, '', '01']) {
      expect(() => inviteId(invalid)).toThrow();
    }
  });
  it('bounds invitation history queries', () => {
    expect(inviteLimit({})).toBe(30);
    expect(inviteLimit({ limit: '50' })).toBe(50);
    for (const invalid of [{ limit: '51' }, { limit: '0' }, { limit: 2 }, { userId: '1' }]) {
      expect(() => inviteLimit(invalid)).toThrow();
    }
  });
});
