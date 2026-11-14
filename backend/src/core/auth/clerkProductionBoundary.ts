import type { RequestHandler } from 'express';
import { AppError } from '../errors/AppError';
import { setVerifiedTenantContext } from '../tenant/tenantContext';
import { createProductionClerkRuntime } from './clerkRuntime';
import { ClerkAuthenticationError } from './clerkJwt';
import { ClerkMembershipError } from './clerkTenant';

/**
 * The ONLY production CRM authentication middleware. It validates a signed Clerk
 * token, checks the live Clerk session and resolves a fresh DB-backed CRM tenant.
 * The full result is never exposed to clients or put into HTTP headers.
 */
export type TrustedClerkRuntime = Pick<ReturnType<typeof createProductionClerkRuntime>, 'authenticate'>;
export function createProductionClerkBoundary(
  runtime: TrustedClerkRuntime = createProductionClerkRuntime(),
): RequestHandler {
  if (!runtime || typeof runtime.authenticate !== 'function') {
    throw new Error('CRM_TRUSTED_CLERK_RUNTIME_REQUIRED');
  }
  return async (req, res, next) => {
    try {
      const result = await runtime.authenticate(req.headers.authorization);
      // A caller must never supply identity via headers, query, or request body.
      setVerifiedTenantContext(res, {
        companyId: result.tenant.companyId,
        actorUserId: result.tenant.actorUserId,
        role: result.tenant.role,
        accessMode: result.tenant.accessMode,
        membershipStatus: 'ACTIVE',
      });
      next();
    } catch (error) {
      if (error instanceof ClerkMembershipError) {
        next(AppError.forbidden());
      } else if (error instanceof ClerkAuthenticationError) {
        next(AppError.unauthenticated());
      } else {
        // Provider outage, database errors and unexpected runtime failures deny.
        // Do not leak upstream exception details to HTTP callers.
        next(AppError.unauthenticated());
      }
    }
  };
}