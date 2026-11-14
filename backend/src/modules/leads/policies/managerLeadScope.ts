import type {
  PoolConnection,
  RowDataPacket,
} from "mysql2/promise";

import { AppError } from "../../../core/errors/AppError";

import {
  getDbPool,
} from "../../../core/database/pool";

import type {
  TenantContext,
} from "../../../core/tenant/tenantContext";

import type {
  ManagerLeadScopeResolver,
} from "../services/leads.service";

type ScopeConnection =
  Pick<PoolConnection, "execute">;

interface TeamMemberRow extends RowDataPacket {
  company_id: string | number | bigint;
  user_id: string | number | bigint;
}

const MAX_ID = 18446744073709551615n;
const MAX_SCOPE_USERS = 5000;

/**
 * Trusted database query.
 *
 * Only current, active team memberships count.
 *
 * The company and manager identifiers come
 * from verified server-side tenant context.
 */
const TEAM_SCOPE_SQL = `
  SELECT DISTINCT
    tm.company_id AS company_id,
    tm.user_id AS user_id

  FROM team_members AS tm

  INNER JOIN teams AS t
    ON t.company_id = tm.company_id
   AND t.id = tm.team_id

  INNER JOIN users AS u
    ON u.company_id = tm.company_id
   AND u.id = tm.user_id

  WHERE t.company_id = ?
    AND t.manager_user_id = ?
    AND t.status = 'active'

    AND tm.left_at IS NULL
    AND tm.joined_at <= UTC_TIMESTAMP(3)

    AND u.role = 'employee'
    AND u.status = 'active'

  LIMIT 5000
`;

function normalizeId(value: unknown): string {
  if (
    typeof value === "string" &&
    /^[1-9][0-9]{0,19}$/.test(value) &&
    BigInt(value) <= MAX_ID
  ) {
    return value;
  }

  if (
    typeof value === "bigint" &&
    value > 0n &&
    value <= MAX_ID
  ) {
    return value.toString();
  }

  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  ) {
    return String(value);
  }

  throw AppError.forbidden();
}

/**
 * Returns an injectable manager scope resolver.
 *
 * Results:
 * - Manager's own user ID
 * - Active employees in teams managed by them
 *
 * The returned list can be passed directly to
 * the lead service's managerScopeResolver option.
 *
 * This function does not accept identifiers
 * from browser requests.
 */
export function createManagerLeadScopeResolver(
  connection?: ScopeConnection
): ManagerLeadScopeResolver {
  return async (
    tenant: TenantContext
  ): Promise<readonly string[]> => {
    if (tenant.role !== "MANAGER") {
      throw AppError.forbidden();
    }

    const companyId = normalizeId(
      tenant.companyId
    );

    const managerId = normalizeId(
      tenant.actorUserId
    );

    const executor = connection ?? getDbPool();

    const [rows] = await executor.execute<TeamMemberRow[]>(
      TEAM_SCOPE_SQL,
      [
        companyId,
        managerId,
      ]
    );

    if (
      !Array.isArray(rows) ||
      rows.length > MAX_SCOPE_USERS
    ) {
      throw AppError.forbidden();
    }

    const authorizedUsers = new Set<string>();

    // Manager always retains access to
    // their own assigned lead records.
    authorizedUsers.add(managerId);

    for (const row of rows) {
      const rowCompanyId = normalizeId(
        row.company_id
      );

      const userId = normalizeId(
        row.user_id
      );

      if (rowCompanyId !== companyId) {
        throw AppError.forbidden();
      }

      authorizedUsers.add(userId);

      if (
        authorizedUsers.size > MAX_SCOPE_USERS
      ) {
        throw AppError.forbidden();
      }
    }

    return Object.freeze([
      ...authorizedUsers,
    ]);
  };
}
