D-GATE CRM / STAFF INVITATIONS (BUILD ONLY)

New authenticated routes, *disabled unless intentionally enabled*:
  GET /api/v1/crm/admin/invitations
  POST /api/v1/crm/admin/invitations/send
  POST /api/v1/crm/admin/invitations/:invitationId/revoke

Role boundaries:
  Owner can invite Managers; Manager can invite Employees to a managed active team.
  Existing users and duplicate outstanding emails are blocked per company.
  Same idempotency key never sends a second email.
  A provider failure is treated as uncertain; operator reconciliation is necessary.
  Revocation prevents using a given invite link, NOT signing up separately.
  No user, role, team membership, or platform entitlement is created by these APIs.

Security gate for deployment ONLY:
  CRM_STAFF_INVITATIONS_ENABLED=true
  NODE_ENV=production
  AUTH_MODE=platform
  CRM_CLERK_BACKEND_SECRET_KEY=<server-side existing company Clerk secret>
  CRM_STAFF_INVITE_REDIRECT_URL=https://<approved verified UI callback>

This batch NEVER runs database migrations, changes .env, calls Clerk or starts production.
The migration 20261103_staff_invitations.sql must be reviewed and applied later.
Integration with the verified D-GATE Platform membership/activation contract remains pending.
Before activation: complete real HTTP/MariaDB/Postman regression tests with a fake
Clerk provider and the reviewed migration on an isolated database.
