import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { AppError } from "../../../core/errors/AppError";
import { requirePermission } from "../../../core/permissions/policies";
import type { TenantContext } from "../../../core/tenant/tenantContext";
import type { NewPicklistChoice, RevisedPicklistChoice } from "../schemas/picklist.write.schema";

export type PicklistWriteConnection = Pick<PoolConnection,
  "execute" | "beginTransaction" | "commit" | "rollback" | "release" | "destroy">;

interface ExistingRow extends RowDataPacket {
  id: string | number | bigint;
  company_id: string | number | bigint;
  entity_type: string;
  field_key: string;
  option_key: string;
  label: string;
  sort_order: number;
  is_active: number | boolean | string;
}

function idString(value: unknown): string {
  if (typeof value === "bigint" && value > 0n) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return value;
  throw new Error("Invalid picklist database identifier");
}

function booleanFromSql(value: unknown): boolean {
  if (value === 1 || value === true || value === "1") return true;
  if (value === 0 || value === false || value === "0") return false;
  throw new Error("Invalid picklist database flag");
}

async function audit(
  db: PicklistWriteConnection,
  tenant: TenantContext,
  id: string,
  action: string,
  details: Record<string, unknown>,
  requestId: string | null
): Promise<void> {
  await db.execute(
    `INSERT INTO audit_logs
      (company_id, actor_user_id, action, entity_type, entity_id, outcome, request_id, details_json, occurred_at)
     VALUES (?, ?, ?, 'picklist_option', ?, 'success', ?, ?, UTC_TIMESTAMP(3))`,
    [tenant.companyId, tenant.actorUserId, action, id, requestId, JSON.stringify(details)]
  );
}

/** Called only inside a service-owned transaction. */
export function createPicklistWriteRepository(db: PicklistWriteConnection) {
  async function create(tenant: TenantContext, data: NewPicklistChoice, requestId: string | null) {
    const [result] = await db.execute<ResultSetHeader>(
      `INSERT INTO picklist_options
       (company_id, entity_type, field_key, option_key, label, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [tenant.companyId, data.entityType, data.fieldKey, data.optionKey,
        data.label, data.sortOrder, data.isActive ? 1 : 0]
    );
    const id = idString(result.insertId);
    await audit(db, tenant, id, "picklist_option.created", {
      entityType: data.entityType, fieldKey: data.fieldKey,
      optionKey: data.optionKey, after: { label: data.label, sortOrder: data.sortOrder, isActive: data.isActive },
    }, requestId);
    return Object.freeze({ id });
  }

  async function revise(tenant: TenantContext, id: string, data: RevisedPicklistChoice, requestId: string | null) {
    const [rows] = await db.execute<ExistingRow[]>(
      `SELECT id, company_id, entity_type, field_key, option_key, label, sort_order, is_active
       FROM picklist_options WHERE company_id = ? AND id = ? FOR UPDATE`,
      [tenant.companyId, id]
    );
    const existing = rows[0];
    if (!existing) throw AppError.notFound();
    if (idString(existing.company_id) !== tenant.companyId || idString(existing.id) !== id) {
      throw AppError.forbidden();
    }
    // Check the actual company-scoped row, never a client-supplied field key.
    const isLeadStatusOrPriority = existing.entity_type === "leads" &&
      (existing.field_key === "status" || existing.field_key === "priority");
    requirePermission(tenant, isLeadStatusOrPriority
      ? "customization.leads.picklists.manage"
      : "settings.manage");

    if (typeof existing.label !== "string" || !Number.isSafeInteger(existing.sort_order)) {
      throw new Error("Invalid picklist database row");
    }
    const before = {
      label: existing.label,
      sortOrder: existing.sort_order,
      isActive: booleanFromSql(existing.is_active),
    };
    if (before.label !== data.expected.label ||
        before.sortOrder !== data.expected.sortOrder ||
        before.isActive !== data.expected.isActive) {
      throw AppError.conflict();
    }
    await db.execute(
      `UPDATE picklist_options SET label = ?, sort_order = ?, is_active = ?
       WHERE company_id = ? AND id = ?`,
      [data.label, data.sortOrder, data.isActive ? 1 : 0, tenant.companyId, id]
    );
    await audit(db, tenant, id, "picklist_option.updated", {
      entityType: existing.entity_type, fieldKey: existing.field_key, optionKey: existing.option_key,
      before, after: { label: data.label, sortOrder: data.sortOrder, isActive: data.isActive },
    }, requestId);
    return Object.freeze({ id });
  }
  return Object.freeze({ create, revise });
}