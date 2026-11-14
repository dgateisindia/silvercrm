-- D-GATE CRM: INVITATION PROVISIONING STATE (NOT AUTOMATICALLY APPLIED)
-- Requires 20261103_staff_invitations.sql first. Review both migrations before executing.
-- Adds no API access; only a trusted internal service can mark accepted invitations.
ALTER TABLE crm_staff_invitations
  MODIFY COLUMN state ENUM('reserved','sent','revoking','revoked','uncertain','provisioned')
  NOT NULL DEFAULT 'reserved';
