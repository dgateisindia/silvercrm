import { AppError } from "../errors/AppError";

import type {
  CrmRole,
  TenantContext,
} from "../tenant/tenantContext";

interface PermissionRule {
  readonly roles: readonly CrmRole[];
  readonly readOnlyAllowed: boolean;
}

const ALL: readonly CrmRole[] = [
  "OWNER",
  "MANAGER",
  "EMPLOYEE",
];

const MANAGEMENT: readonly CrmRole[] = [
  "OWNER",
  "MANAGER",
];

const SALES: readonly CrmRole[] = [
  "MANAGER",
  "EMPLOYEE",
];

const MANAGER: readonly CrmRole[] = [
  "MANAGER",
];

const OWNER: readonly CrmRole[] = [
  "OWNER",
];

const EMPLOYEE: readonly CrmRole[] = [
  "EMPLOYEE",
];

/**
 * Central CRM role-permission matrix.
 *
 * These are feature-level permissions only.
 * Record ownership, team scope, company isolation,
 * and workflow state require additional checks.
 *
 * Unlisted permissions are denied by default.
 */
export const PERMISSION_RULES = {
  "dashboard.read": {
    roles: ALL,
    readOnlyAllowed: true,
  },

  "leads.read": {
    roles: ALL,
    readOnlyAllowed: true,
  },

  "leads.create": {
    roles: SALES,
    readOnlyAllowed: false,
  },

  "leads.update": {
    roles: SALES,
    readOnlyAllowed: false,
  },

  "leads.assign": {
    roles: MANAGER,
    readOnlyAllowed: false,
  },

  "leads.transfer.request": {
    roles: EMPLOYEE,
    readOnlyAllowed: false,
  },

  "leads.transfer.approve": {
    roles: MANAGER,
    readOnlyAllowed: false,
  },

  "contacts.read": {
    roles: ALL,
    readOnlyAllowed: true,
  },

  "contacts.create": {
    roles: SALES,
    readOnlyAllowed: false,
  },

  "contacts.update": {
    roles: SALES,
    readOnlyAllowed: false,
  },

  "accounts.read": {
    roles: ALL,
    readOnlyAllowed: true,
  },

  "accounts.create": {
    roles: SALES,
    readOnlyAllowed: false,
  },

  "accounts.update": {
    roles: SALES,
    readOnlyAllowed: false,
  },

  "deals.read": {
    roles: ALL,
    readOnlyAllowed: true,
  },

  "deals.create": {
    roles: SALES,
    readOnlyAllowed: false,
  },

  "deals.update": {
    roles: SALES,
    readOnlyAllowed: false,
  },

  "tasks.read": {
    roles: ALL,
    readOnlyAllowed: true,
  },

  "tasks.create": {
    roles: SALES,
    readOnlyAllowed: false,
  },

  "tasks.update": {
    roles: SALES,
    readOnlyAllowed: false,
  },

  "tasks.assign": {
    roles: MANAGER,
    readOnlyAllowed: false,
  },

  "calendar.read": {
    roles: ALL,
    readOnlyAllowed: true,
  },

  "calendar.create": {
    roles: SALES,
    readOnlyAllowed: false,
  },

  "employees.read": {
    roles: MANAGEMENT,
    readOnlyAllowed: true,
  },

  "employees.manage": {
    roles: MANAGEMENT,
    readOnlyAllowed: false,
  },

  "invitations.manager.create": {
    roles: OWNER,
    readOnlyAllowed: false,
  },

  "invitations.employee.create": {
    roles: MANAGEMENT,
    readOnlyAllowed: false,
  },

  "reports.read": {
    roles: ALL,
    readOnlyAllowed: true,
  },

  "reports.export": {
    roles: MANAGEMENT,
    readOnlyAllowed: true,
  },

  "settings.read": {
    roles: MANAGEMENT,
    readOnlyAllowed: true,
  },

  "settings.manage": {
    roles: OWNER,
    readOnlyAllowed: false,
  },

  // Company Lead status/priority choices only; not general settings or other picklists.
  "sales.catalog.manage": { roles: MANAGER, readOnlyAllowed: false },
  "customization.leads.picklists.manage": {
    roles: MANAGEMENT,
    readOnlyAllowed: false,
  },

  // Company field definitions and Lead form presentation; not all admin settings.
  "customization.fields.manage": {
    roles: MANAGEMENT,
    readOnlyAllowed: false,
  },
} as const satisfies Record<string, PermissionRule>;

export type CrmPermission =
  keyof typeof PERMISSION_RULES;

export interface PermissionOptions {
  /**
   * Must be resolved from trusted server-side
   * company settings, never browser input.
   */
  readonly managerEmployeeInvitesEnabled?: boolean;
}

/**
 * Check role and entitlement authorization.
 *
 * Does NOT establish record-level authorization.
 */
export function hasPermission(
  context: TenantContext,
  permission: CrmPermission,
  options: PermissionOptions = {}
): boolean {
  if (
    !context ||
    typeof context !== "object"
  ) {
    return false;
  }

  if (
    !Object.prototype.hasOwnProperty.call(
      PERMISSION_RULES,
      permission
    )
  ) {
    return false;
  }

  const rule: PermissionRule =
    PERMISSION_RULES[permission];

  if (!rule.roles.includes(context.role)) {
    return false;
  }

  if (context.accessMode === "READ_ONLY") {
    if (!rule.readOnlyAllowed) {
      return false;
    }
  } else if (context.accessMode !== "FULL") {
    return false;
  }

  if (
    permission === "invitations.employee.create" &&
    context.role === "MANAGER" &&
    options.managerEmployeeInvitesEnabled !== true
  ) {
    return false;
  }

  return true;
}

/**
 * Throw HTTP 403 when a permission is denied.
 *
 * Feature services must additionally check
 * ownership, company, team and record state.
 */
export function requirePermission(
  context: TenantContext,
  permission: CrmPermission,
  options: PermissionOptions = {}
): void {
  if (!hasPermission(context, permission, options)) {
    throw AppError.forbidden();
  }
}
