import type { Response } from "express";

import type {
  PoolConnection,
  RowDataPacket,
} from "mysql2/promise";

import { getDbPool } from "./pool";

import {
  getTenantContext,
} from "../tenant/tenantContext";

/**
 * Supported tenant-owned CRM tables.
 *
 * This is an explicit allowlist. Never allow
 * request parameters to select a SQL table.
 *
 * Add new tables only after checking the
 * actual database schema.
 */
export const TENANT_TABLES = [
  "leads",
  "contacts",
  "accounts",
  "deals",
  "tasks",
  "users",
] as const;

export type TenantTable =
  (typeof TENANT_TABLES)[number];

export interface TenantRecordIdentity {
  readonly id: string;
  readonly companyId: string;
}

/**
 * Accepts the execute method from an existing
 * MySQL transaction connection.
 *
 * Without this argument, the shared pool
 * executes the read-only query.
 */
export type TenantQueryConnection =
  Pick<PoolConnection, "execute">;

const ALLOWED_TABLES = new Set<string>(
  TENANT_TABLES
);

const MAX_UNSIGNED_BIGINT =
  18446744073709551615n;

function validateRecordId(
  value: unknown
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value) ||
    BigInt(value) > MAX_UNSIGNED_BIGINT
  ) {
    throw new Error("Invalid CRM record identifier");
  }
}

function normalizeDatabaseId(
  value: unknown
): string | null {
  if (typeof value === "string") {
    if (
      /^[1-9][0-9]{0,19}$/.test(value) &&
      BigInt(value) <= MAX_UNSIGNED_BIGINT
    ) {
      return value;
    }

    return null;
  }

  if (typeof value === "bigint") {
    if (
      value > 0n &&
      value <= MAX_UNSIGNED_BIGINT
    ) {
      return value.toString();
    }

    return null;
  }

  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  ) {
    return String(value);
  }

  return null;
}

/**
 * Locate a record by its ID inside the
 * currently authenticated CRM company.
 *
 * Returns only ID and company ID.
 *
 * The company ID comes exclusively from
 * the server-issued tenant context.
 *
 * The caller must still enforce:
 * - CRM role permissions
 * - Employee record assignment
 * - Team visibility
 * - Workflow authorization
 *
 * This lookup alone does not authorize
 * reading or modifying a business record.
 */
export async function findTenantRecordIdentity(
  res: Response,
  table: TenantTable,
  recordId: string,
  connection?: TenantQueryConnection
): Promise<TenantRecordIdentity | null> {
  const tenant = getTenantContext(res);

  if (
    typeof table !== "string" ||
    !ALLOWED_TABLES.has(table)
  ) {
    throw new Error("Unsupported CRM repository table");
  }

  validateRecordId(recordId);

  const executor = connection ?? getDbPool();

  const sql = `
    SELECT id, company_id
    FROM \`${table}\`
    WHERE company_id = ?
      AND id = ?
    LIMIT 1
  `;

  const [rows] = await executor.execute<RowDataPacket[]>(
    sql,
    [
      tenant.companyId,
      recordId,
    ]
  );

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];

  if (!row) {
    throw new Error("Invalid CRM database response");
  }

  const actualId = normalizeDatabaseId(row.id);

  const actualCompanyId =
    normalizeDatabaseId(row.company_id);

  if (
    actualId !== recordId ||
    actualCompanyId !== tenant.companyId
  ) {
    // Fail closed if the database adapter or
    // a mocked result violates the tenant scope.
    throw new Error(
      "CRM tenant query integrity violation"
    );
  }

  return Object.freeze({
    id: actualId,
    companyId: actualCompanyId,
  });
}
