import type { RequestHandler } from "express";

import { AppError } from "../errors/AppError";

import {
  getTenantContext,
  type TenantContext,
} from "../tenant/tenantContext";

import {
  PERMISSION_RULES,
  requirePermission,
  type CrmPermission,
} from "./policies";

/**
 * Server-side company policy resolver.
 *
 * Only trusted backend services should implement this.
 * Never resolve permission options from browser input.
 */
export type ManagerInvitePolicyResolver = (
  context: TenantContext
) => boolean | Promise<boolean>;

/**
 * CRM route authorization middleware.
 *
 * Must execute AFTER verified authentication
 * and tenant context resolution.
 *
 * This checks feature-level permission.
 * Record-level ownership and team permissions
 * must be checked by feature policies/services.
 */
export function authorize(
  permission: CrmPermission,
  managerInvitePolicyResolver?: ManagerInvitePolicyResolver
): RequestHandler {
  if (
    !Object.prototype.hasOwnProperty.call(
      PERMISSION_RULES,
      permission
    )
  ) {
    throw new Error("Unknown CRM permission");
  }

  return (_req, res, next): void => {
    void (async () => {
      const context = getTenantContext(res);

      const requiresManagerInvitePolicy =
        permission === "invitations.employee.create" &&
        context.role === "MANAGER";

      if (requiresManagerInvitePolicy) {
        // Never load additional policy for an already
        // restricted or read-only company.
        if (
          context.accessMode !== "FULL" ||
          !managerInvitePolicyResolver
        ) {
          throw AppError.forbidden();
        }

        const enabled =
          await managerInvitePolicyResolver(context);

        requirePermission(context, permission, {
          managerEmployeeInvitesEnabled:
            enabled === true,
        });
      } else {
        requirePermission(context, permission);
      }

      next();
    })().catch(next);
  };
}
