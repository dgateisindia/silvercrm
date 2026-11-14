# D-GATE Silver CRM: Trusted invitation activation â€” build handoff

This build adds an internal-only invitation activation service. It does NOT call Clerk or
D-GATE Platform directly, expose an HTTP endpoint, or automatically provision staff.

## Preconditions for actual activation

1. Review and apply `20261103_staff_invitations.sql`, then
   `20261103_staff_invitation_activation.sql` during an approved migration window.
2. The Clerk server-side provider must prove invitation acceptance and provide the
   Clerk **verified** email, signed/verified user identifier and invitation ID.
3. A separate D-GATE Platform provider must prove the same identity has active
   membership/product access in the correct Platform organization, with numeric
   membership and product-access IDs plus an entitlement version.
4. D-GATE Platform team must confirm the exact verification API and identifier formats.
   No fabricated or client-provided role, company ID, or access grant is acceptable.
5. Enable `CRM_STAFF_ACTIVATION_ENABLED=true` ONLY when the approved trusted caller,
   provider implementations, migrations, production auth, and functional tests are ready.
6. Activate through a non-public trusted internal job/service, never from a directly
   accessible browser API or unauthenticated webhook.

## Security constraints

- CRM role/team are taken from the original approved invitation, not identity metadata.
- Owner invitations and public sign-up never create Owner membership.
- A revoked invitation, mismatched email, changed Manager/team, duplicate CRM user,
  stale/denied entitlement, or mismatched Platform version fails closed.
- Creation of user/team assignment, invitation state and audit is one DB transaction.
- Duplicate calls cannot silently attach an existing CRM user to a second invitation.
- No cross-database FK to Platform; remote memberships require independent verification.
- No storage of passwords, bearer credentials, or full provider payloads.

## Testing phase (later)

Use isolated MariaDB clones and provider test doubles to cover acceptance/activation,
failed activation rollback, retries, idempotency, concurrent callers, team revocation,
invitation revocation, identity mismatch, entitlement expiry and platform API outages.
Check real Clerk/Platform integration only after the contract and credentials are approved.
