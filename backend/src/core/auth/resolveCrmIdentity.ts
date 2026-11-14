import type { RequestHandler } from "express";

import { AppError } from "../errors/AppError";

import {
  getVerifiedPlatformSession,
  type VerifiedCustomerSession,
} from "./verifyPlatformSession";

import {
  setVerifiedTenantContext,
  type VerifiedCrmIdentity,
} from "../tenant/tenantContext";

/**
 * Resolve a verified customer session into CRM access.
 *
 * The production implementation must independently verify:
 *
 * 1. Platform customer identity
 * 2. Active organization membership
 * 3. Active CRM product access
 * 4. Effective CRM entitlement
 * 5. Matching CRM company and user profiles
 * 6. Explicit CRM Owner/Manager/Employee role
 *
 * A generic Platform MEMBER role must not
 * automatically become a CRM Manager.
 *
 * Never trust companyId, role or accessMode
 * supplied by browser headers or request bodies.
 */
export type CrmIdentityResolver = (
  session: VerifiedCustomerSession
) => Promise<VerifiedCrmIdentity | null>;

/**
 * Resolve CRM membership and entitlement.
 *
 * Must run after createVerifyPlatformSession().
 *
 * Null:
 * No authorized CRM membership.
 *
 * Provider failure:
 * Service temporarily unavailable.
 *
 * DENIED / INACTIVE:
 * Access forbidden.
 */
export function createResolveCrmIdentity(
  resolver: CrmIdentityResolver
): RequestHandler {
  if (typeof resolver !== "function") {
    throw new Error(
      "A trusted CRM identity resolver is required"
    );
  }

  return (_req, res, next): void => {
    void (async () => {
      const session = getVerifiedPlatformSession(res);

      // Prevent overwriting an already-established
      // company identity during the same request.
      if (res.locals.tenantContext !== undefined) {
        throw AppError.forbidden();
      }

      let identity: VerifiedCrmIdentity | null;

      try {
        identity = await resolver(session);
      } catch {
        // Do not expose Platform errors or
        // private integration information.
        throw AppError.serviceUnavailable();
      }

      if (!identity) {
        throw AppError.forbidden();
      }

      // Existing tenantContext validates role,
      // company ID, user ID, membership and entitlement.
      setVerifiedTenantContext(res, identity);
    })().then(
      () => next(),
      (error: unknown) => next(error)
    );
  };
}
