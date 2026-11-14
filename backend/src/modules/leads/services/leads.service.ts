import type { Response } from "express";

import { AppError } from "../../../core/errors/AppError";

import {
  getTenantContext,
  type TenantContext,
} from "../../../core/tenant/tenantContext";

import {
  requirePermission,
} from "../../../core/permissions/policies";

import {
  findLeadById,
  listLeads,
  type LeadRecord,
  type LeadListOptions,
  type LeadQueryConnection,
} from "../repositories/leads.repository";

const MAX_UNSIGNED_BIGINT =
  18446744073709551615n;

const MAX_MANAGER_SCOPE_USERS = 5000;

/**
 * Server-side manager team-scope provider.
 *
 * Must load actual authorized employee IDs
 * for the current manager and company.
 *
 * Never derive this list from request body,
 * query parameters, or browser headers.
 */
export type ManagerLeadScopeResolver = (
  tenant: TenantContext
) => Promise<readonly string[]>;

export interface LeadServiceOptions {
  readonly connection?: LeadQueryConnection;
  readonly managerScopeResolver?: ManagerLeadScopeResolver;
}

export interface LeadPage {
  readonly items: readonly LeadRecord[];
  readonly nextCursor: string | null;
}

function validUserId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]{0,19}$/.test(value) &&
    BigInt(value) <= MAX_UNSIGNED_BIGINT
  );
}

/**
 * Resolve the current manager's authorized
 * lead-owner IDs.
 *
 * Owner and Employee use their respective
 * existing company/ownership repository rules.
 *
 * Manager requests without trusted team scope
 * are denied rather than treated as company-wide.
 */
async function getManagerScope(
  tenant: TenantContext,
  resolver?: ManagerLeadScopeResolver
): Promise<ReadonlySet<string> | null> {
  if (tenant.role !== "MANAGER") {
    return null;
  }

  if (typeof resolver !== "function") {
    throw AppError.forbidden();
  }

  const ids = await resolver(tenant);

  if (
    !Array.isArray(ids) ||
    ids.length > MAX_MANAGER_SCOPE_USERS ||
    !ids.every(validUserId)
  ) {
    throw AppError.forbidden();
  }

  return new Set(ids);
}

/**
 * Read one lead.
 *
 * OWNER:
 * Company-wide read according to role policy.
 *
 * MANAGER:
 * Only leads belonging to approved team owners.
 *
 * EMPLOYEE:
 * Only personally assigned leads.
 *
 * Missing or unauthorized records both return
 * null to avoid revealing record existence.
 */
export async function getLeadForViewer(
  res: Response,
  leadId: string,
  options: LeadServiceOptions = {}
): Promise<LeadRecord | null> {
  const tenant = getTenantContext(res);

  requirePermission(tenant, "leads.read");

  const managerScope = await getManagerScope(
    tenant,
    options.managerScopeResolver
  );

  if (
    managerScope !== null &&
    managerScope.size === 0
  ) {
    return null;
  }

  const lead = await findLeadById(
    res,
    leadId,
    options.connection
  );

  if (!lead) {
    return null;
  }

  if (
    managerScope !== null &&
    !managerScope.has(lead.ownerUserId)
  ) {
    return null;
  }

  return lead;
}

/**
 * Read a page of permitted leads.
 *
 * OWNER: Company-wide records.
 * EMPLOYEE: Assigned records.
 * MANAGER: Results filtered through trusted
 * team-owner scope.
 *
 * The cursor advances through scanned records,
 * including records excluded by manager scope.
 * This avoids repeating the same source page.
 *
 * A future repository improvement must perform
 * manager team filtering directly in SQL.
 */
export async function listLeadsForViewer(
  res: Response,
  options: LeadListOptions = {},
  dependencies: LeadServiceOptions = {}
): Promise<LeadPage> {
  const tenant = getTenantContext(res);

  requirePermission(tenant, "leads.read");

  const managerScope = await getManagerScope(
    tenant,
    dependencies.managerScopeResolver
  );

  const records = await listLeads(
    res,
    options,
    dependencies.connection
  );

  const visibleRecords =
    managerScope === null
      ? records
      : records.filter(
          lead => managerScope.has(lead.ownerUserId)
        );

  const limit = options.limit ?? 25;

  const lastScanned = records.at(-1);

  const nextCursor =
    records.length === limit && lastScanned
      ? lastScanned.id
      : null;

  return Object.freeze({
    items: Object.freeze([...visibleRecords]),
    nextCursor,
  });
}
