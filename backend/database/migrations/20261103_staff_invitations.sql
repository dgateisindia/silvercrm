-- D-GATE Silver CRM - Staff Invitation persistence (NOT automatically applied).
-- Apply only during the dedicated migration/testing phase after review and backup.
-- Never edit or infer membership from Clerk public metadata or unsigned headers.
CREATE TABLE crm_staff_invitations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id BIGINT UNSIGNED NOT NULL,
  email VARCHAR(254) NOT NULL,
  full_name VARCHAR(180) NOT NULL,
  role ENUM('manager','employee') NOT NULL,
  team_id BIGINT UNSIGNED NULL,
  requested_by_id BIGINT UNSIGNED NOT NULL,
  idempotency_key VARCHAR(120) NOT NULL,
  provider_invitation_id VARCHAR(128) NULL,
  state ENUM('reserved','sent','revoking','revoked','uncertain') NOT NULL DEFAULT 'reserved',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_staff_invitations_company_id (company_id,id),
  UNIQUE KEY uq_staff_invitations_idempotency (company_id,idempotency_key),
  UNIQUE KEY uq_staff_invitations_provider (provider_invitation_id),
  KEY idx_staff_invites_email (company_id,email,state),
  KEY idx_staff_invites_actor (company_id,requested_by_id,created_at),
  CONSTRAINT ck_staff_invites_team_role CHECK (
    (role='manager' AND team_id IS NULL) OR
    (role='employee' AND team_id IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
