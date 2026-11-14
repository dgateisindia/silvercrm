import type { Response } from "express";

import { AppError } from "../errors/AppError";

export type CrmRole =
  | "OWNER"
  | "MANAGER"
  | "EMPLOYEE";

export type CrmAccessMode =
  | "FULL"
  | "READ_ONLY"
  | "DENIED";

export type MembershipStatus =
  | "ACTIVE"
  | "INACTIVE";

export interface VerifiedCrmIdentity {
  readonly companyId: string;
  readonly actorUserId: string;
  readonly role: CrmRole;
  readonly membershipStatus: MembershipStatus;
  readonly accessMode: CrmAccessMode;
}

export interface TenantContext {
  readonly companyId: string;
  readonly actorUserId: string;
  readonly role: CrmRole;
  readonly accessMode: Exclude<CrmAccessMode, "DENIED">;
}

const MAX_BIGINT_UNSIGNED =
  18446744073709551615n;

const ALLOWED_ROLES: readonly string[] = [
  "OWNER",
  "MANAGER",
  "EMPLOYEE",
];

// Tracks objects created by this trusted module.
const issuedContexts = new WeakSet<TenantContext>();

function isValidDatabaseId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value)
  ) {
    return false;
  }

  return BigInt(value) <= MAX_BIGINT_UNSIGNED;
}

/**
 * Attach a verified company identity to the request.
 *
 * IMPORTANT:
 * Call only from trusted authentication middleware
 * AFTER verifying the Platform session, membership
 * and CRM entitlement.
 *
 * Never construct identity from req.body,
 * req.query, req.params or unverified headers.
 *
 * Local test authentication must be disabled
 * in production.
 */
export function setVerifiedTenantContext(
  res: Response,
  identity: VerifiedCrmIdentity
): void {
  if (res.locals.tenantContext !== undefined) {
    throw AppError.forbidden();
  }

  if (
    !identity ||
    typeof identity !== "object" ||
    !isValidDatabaseId(identity.companyId) ||
    !isValidDatabaseId(identity.actorUserId)
  ) {
    throw AppError.unauthenticated();
  }

  if (identity.membershipStatus !== "ACTIVE") {
    throw AppError.forbidden();
  }

  if (!ALLOWED_ROLES.includes(identity.role)) {
    throw AppError.forbidden();
  }

  if (
    identity.accessMode !== "FULL" &&
    identity.accessMode !== "READ_ONLY"
  ) {
    throw AppError.forbidden();
  }

  const context: TenantContext = Object.freeze({
    companyId: identity.companyId,
    actorUserId: identity.actorUserId,
    role: identity.role,
    accessMode: identity.accessMode,
  });

  issuedContexts.add(context);

  res.locals.tenantContext = context;
}

/**
 * Retrieve the trusted company context.
 *
 * Controllers and repositories must obtain
 * their company scope from this context.
 *
 * This function rejects missing or forged
 * tenant context objects.
 */
export function getTenantContext(
  res: Response
): TenantContext {
  const context: unknown = res.locals.tenantContext;

  if (
    !context ||
    typeof context !== "object" ||
    !issuedContexts.has(context as TenantContext)
  ) {
    throw AppError.unauthenticated();
  }

  return context as TenantContext;
}
