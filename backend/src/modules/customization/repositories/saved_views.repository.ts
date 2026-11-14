import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { AppError } from "../../../core/errors/AppError";
import type { TenantContext } from "../../../core/tenant/tenantContext";
import { requirePermission } from "../../../core/permissions/policies";
import { layoutJson, } from "../schemas/layouts.schema";
import type { NewSavedView, RevisedSavedView, SavedViewScope } from "../schemas/saved_views.schema";

export type SavedViewReadConnection = Pick<PoolConnection, "execute">;
export type SavedViewWriteConnection = Pick<PoolConnection,
  "execute" | "beginTransaction" | "commit" | "rollback" | "release" | "destroy">;

interface SavedViewRow extends RowDataPacket {
  id: string | number | bigint;
  company_id: string | number | bigint;
  owner_user_id: string | number | bigint | null;
  entity_type: string;
  name: string;
  filter_json: unknown;
  shared: number | string | boolean;
}

function idString(value: unknown): string {
  if (typeof value === "bigint" && value > 0n && value <= 18446744073709551615n) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) &&
      BigInt(value) <= 18446744073709551615n) return value;
  throw new Error("Invalid saved view database identifier");
}

function flag(value: unknown): boolean {
  if (value === 1 || value === true || value === "1") return true;
  if (value === 0 || value === false || value === "0") return false;
  throw new Error("Invalid saved view visibility flag");
}

function configValue(value: unknown): Record<string, unknown> {
  let parsed: unknown = value;
  try {
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
  } catch {
    throw new Error("Invalid stored saved view configuration");
  }
  // Also enforces bounded size, JSON-safe structure and dangerous-key rejection.
  return JSON.parse(layoutJson(parsed)) as Record<string, unknown>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map(k =>
      `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function verify(row: SavedViewRow, tenant: TenantContext, entityType?: string): void {
  if (idString(row.company_id) !== tenant.companyId) throw AppError.forbidden();
  if (entityType !== undefined && row.entity_type !== entityType) throw AppError.notFound();
  if (typeof row.name !== "string") throw new Error("Invalid saved view name");
}

async function audit(db: SavedViewWriteConnection, tenant: TenantContext, id: string,
  action: string, details: Record<string, unknown>, requestId: string | null): Promise<void> {
  await db.execute(
    `INSERT INTO audit_logs
      (company_id, actor_user_id, action, entity_type, entity_id, outcome, request_id, details_json, occurred_at)
     VALUES (?, ?, ?, 'saved_view', ?, 'success', ?, ?, UTC_TIMESTAMP(3))`,
    [tenant.companyId, tenant.actorUserId, action, id, requestId, JSON.stringify(details)]
  );
}

/** List visible shared views and only this user's private views. */
export async function listSavedViews(
  db: SavedViewReadConnection, tenant: TenantContext, entityType: string
) {
  const [rows] = await db.execute<SavedViewRow[]>(
    `SELECT id, company_id, owner_user_id, entity_type, name, filter_json, shared
     FROM saved_views WHERE company_id = ? AND entity_type = ?
       AND (shared = 1 OR owner_user_id = ?)
     ORDER BY id DESC LIMIT 201`,
    [tenant.companyId, entityType, tenant.actorUserId]
  );
  if (!Array.isArray(rows) || rows.length > 200) {
    throw new Error("Saved view list limit exceeded");
  }
  return Object.freeze(rows.map(row => {
    verify(row, tenant, entityType);
    const isShared = flag(row.shared);
    const owner = row.owner_user_id === null ? null : idString(row.owner_user_id);
    if (!isShared && owner !== tenant.actorUserId) throw AppError.forbidden();
    return Object.freeze({
      id: idString(row.id), entityType: row.entity_type,
      name: row.name, scope: isShared ? "company" as const : "personal" as const,
      ownerUserId: owner, config: configValue(row.filter_json),
    });
  }));
}

/** Must be called inside an already-open transaction. */
export async function createSavedView(db: SavedViewWriteConnection, tenant: TenantContext,
  input: NewSavedView, requestId: string | null) {
  const [result] = await db.execute<ResultSetHeader>(
    `INSERT INTO saved_views (company_id, owner_user_id, entity_type, name, filter_json, shared)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [tenant.companyId, tenant.actorUserId, input.entityType,
      input.name, input.configJson, input.scope === "company" ? 1 : 0]
  );
  const id = idString(result.insertId);
  await audit(db, tenant, id, "saved_view.created", {
    entityType: input.entityType, scope: input.scope, name: input.name,
  }, requestId);
  return Object.freeze({ id, scope: input.scope });
}

/** Row-locked optimistic update. Never accepts company/owner identifiers from the client. */
export async function reviseSavedView(db: SavedViewWriteConnection, tenant: TenantContext,
  id: string, input: RevisedSavedView, requestId: string | null) {
  const [rows] = await db.execute<SavedViewRow[]>(
    `SELECT id, company_id, owner_user_id, entity_type, name, filter_json, shared
     FROM saved_views WHERE company_id = ? AND id = ? FOR UPDATE`,
    [tenant.companyId, id]
  );
  const row = rows[0];
  if (!row) throw AppError.notFound();
  verify(row, tenant);
  const owner = row.owner_user_id === null ? null : idString(row.owner_user_id);
  const wasShared = flag(row.shared);
  const previousScope: SavedViewScope = wasShared ? "company" : "personal";
  if (!wasShared && owner !== tenant.actorUserId) throw AppError.notFound();
  if (wasShared || input.scope === "company") requirePermission(tenant, "settings.manage");
  // Avoid turning another person's shared definition into their private view.
  if (input.scope === "personal" && owner !== tenant.actorUserId) throw AppError.forbidden();

  const beforeConfig = configValue(row.filter_json);
  if (row.name !== input.expectedName || previousScope !== input.expectedScope ||
      canonical(beforeConfig) !== canonical(JSON.parse(input.expectedConfigJson))) {
    throw AppError.conflict();
  }
  const [changed] = await db.execute<ResultSetHeader>(
    `UPDATE saved_views SET name = ?, filter_json = ?, shared = ?
     WHERE company_id = ? AND id = ?`,
    [input.name, input.configJson, input.scope === "company" ? 1 : 0, tenant.companyId, id]
  );
  if (changed.affectedRows !== 1) throw AppError.conflict();
  await audit(db, tenant, id, "saved_view.updated", {
    entityType: row.entity_type, beforeScope: previousScope, afterScope: input.scope,
    beforeName: row.name, afterName: input.name,
  }, requestId);
  return Object.freeze({ id, updated: true });
}