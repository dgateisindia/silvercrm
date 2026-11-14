import type { Response } from "express";

import type {
  PoolConnection,
  RowDataPacket,
} from "mysql2/promise";

import { getDbPool } from "../../../core/database/pool";

import {
  getTenantContext,
  type TenantContext,
} from "../../../core/tenant/tenantContext";

export type LeadQueryConnection =
  Pick<PoolConnection, "execute">;

interface LeadDbRow extends RowDataPacket {
  id: string | number | bigint;
  company_id: string | number | bigint;
  contact_id: string | number | bigint | null;
  account_id: string | number | bigint | null;
  title: string;
  source_key: string | null;
  status: string;
  priority: string;
  created_by_user_id: string | number | bigint;
  owner_user_id: string | number | bigint;
  assigned_at: Date | string | null;
  next_followup_at: Date | string | null;
  description: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface LeadRecord {
  readonly id: string;
  readonly companyId: string;
  readonly contactId: string | null;
  readonly accountId: string | null;
  readonly title: string;
  readonly sourceKey: string | null;
  readonly status: string;
  readonly priority: string;
  readonly createdByUserId: string;
  readonly ownerUserId: string;
  readonly assignedAt: Date | string | null;
  readonly nextFollowupAt: Date | string | null;
  readonly description: string | null;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
}

export interface LeadListOptions {
  readonly limit?: number;
  readonly beforeId?: string;
}

const MAX_ID = 18446744073709551615n;

const LEAD_COLUMNS = `
  id,
  company_id,
  contact_id,
  account_id,
  title,
  source_key,
  status,
  priority,
  created_by_user_id,
  owner_user_id,
  assigned_at,
  next_followup_at,
  description,
  created_at,
  updated_at
`;

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]{0,19}$/.test(value) &&
    BigInt(value) <= MAX_ID
  );
}

function requireId(value: unknown): string {
  if (!validId(value)) {
    throw new Error("Invalid lead identifier");
  }

  return value;
}

function databaseId(value: unknown): string {
  if (typeof value === "bigint") {
    if (value > 0n && value <= MAX_ID) {
      return value.toString();
    }
  }

  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  ) {
    return String(value);
  }

  if (validId(value)) {
    return value;
  }

  throw new Error("Invalid lead database identifier");
}

function optionalDatabaseId(
  value: unknown
): string | null {
  return value === null ? null : databaseId(value);
}

function mapLead(
  row: LeadDbRow,
  tenant: TenantContext,
  expectedId?: string
): LeadRecord {
  const id = databaseId(row.id);
  const companyId = databaseId(row.company_id);
  const ownerUserId = databaseId(row.owner_user_id);

  if (
    companyId !== tenant.companyId ||
    (expectedId !== undefined && id !== expectedId) ||
    (
      tenant.role === "EMPLOYEE" &&
      ownerUserId !== tenant.actorUserId
    )
  ) {
    throw new Error("Lead tenant scope integrity violation");
  }

  if (
    typeof row.title !== "string" ||
    typeof row.status !== "string" ||
    typeof row.priority !== "string"
  ) {
    throw new Error("Invalid lead database row");
  }

  return Object.freeze({
    id,
    companyId,
    contactId: optionalDatabaseId(row.contact_id),
    accountId: optionalDatabaseId(row.account_id),
    title: row.title,
    sourceKey: row.source_key,
    status: row.status,
    priority: row.priority,
    createdByUserId: databaseId(row.created_by_user_id),
    ownerUserId,
    assignedAt: row.assigned_at,
    nextFollowupAt: row.next_followup_at,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function ownershipClause(
  tenant: TenantContext,
  parameters: Array<string | number>
): string {
  if (tenant.role === "EMPLOYEE") {
    parameters.push(tenant.actorUserId);

    return " AND owner_user_id = ?";
  }

  if (tenant.role === "MANAGER") {
    parameters.push(
      tenant.actorUserId,
      tenant.actorUserId
    );

    /**
     * Manager access:
     *
     * 1. Leads owned by the manager directly.
     * 2. Leads assigned to active employees
     *    in an active team managed by that user.
     *
     * All relationships are checked using
     * the authenticated company boundary.
     *
     * Historical team membership is excluded.
     */
    return `
      AND (
        leads.owner_user_id = ?

        OR EXISTS (
          SELECT 1
          FROM team_members AS tm

          INNER JOIN teams AS t
            ON t.company_id = tm.company_id
           AND t.id = tm.team_id

          INNER JOIN users AS u
            ON u.company_id = tm.company_id
           AND u.id = tm.user_id

          WHERE tm.company_id = leads.company_id
            AND tm.user_id = leads.owner_user_id

            AND tm.left_at IS NULL
            AND tm.joined_at <= UTC_TIMESTAMP(3)

            AND t.manager_user_id = ?
            AND t.status = 'active'

            AND u.role = 'employee'
            AND u.status = 'active'
        )
      )
    `;
  }

  return "";
}

/**
 * Read a lead within the authenticated company.
 *
 * Employees are restricted to their current
 * assigned leads.
 *
 * Feature services must additionally enforce
 * permission and manager/team scope rules.
 */
export async function findLeadById(
  res: Response,
  leadId: string,
  connection?: LeadQueryConnection
): Promise<LeadRecord | null> {
  const tenant = getTenantContext(res);
  const id = requireId(leadId);

  const parameters: Array<string | number> = [
    tenant.companyId,
    id,
  ];

  const ownership = ownershipClause(
    tenant,
    parameters
  );

  const executor = connection ?? getDbPool();

  const [rows] = await executor.execute<LeadDbRow[]>(
    `
      SELECT ${LEAD_COLUMNS}
      FROM leads
      WHERE company_id = ?
        AND id = ?
        ${ownership}
      LIMIT 1
    `,
    parameters
  );

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];

  if (!row) {
    throw new Error("Invalid lead query response");
  }

  return mapLead(row, tenant, id);
}

/**
 * Cursor-based lead listing.
 *
 * Uses descending primary-key order.
 * No client-supplied SQL fragments are accepted.
 *
 * A role permission check must occur in the
 * feature service before calling this function.
 */
export async function listLeads(
  res: Response,
  options: LeadListOptions = {},
  connection?: LeadQueryConnection
): Promise<LeadRecord[]> {
  const tenant = getTenantContext(res);

  const limit = options.limit ?? 25;

  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new Error("Invalid lead page size");
  }

  const parameters: Array<string | number> = [
    tenant.companyId,
  ];

  const ownership = ownershipClause(
    tenant,
    parameters
  );

  let cursorClause = "";

  if (options.beforeId !== undefined) {
    cursorClause = " AND id < ?";
    parameters.push(requireId(options.beforeId));
  }

  parameters.push(limit);

  const executor = connection ?? getDbPool();

  const [rows] = await executor.execute<LeadDbRow[]>(
    `
      SELECT ${LEAD_COLUMNS}
      FROM leads
      WHERE company_id = ?
        ${ownership}
        ${cursorClause}
      ORDER BY id DESC
      LIMIT ?
    `,
    parameters
  );

  if (rows.length > limit) {
    throw new Error("Invalid lead pagination response");
  }

  return rows.map(row => mapLead(row, tenant));
}
