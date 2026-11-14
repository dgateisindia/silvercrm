import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { AppError } from "../../../core/errors/AppError";
import type { TenantContext } from "../../../core/tenant/tenantContext";
import type { ManagerLeadScopeResolver } from "../../leads/services/leads.service";
import { createManagerLeadScopeResolver } from "../../leads/policies/managerLeadScope";
import {
  LEAD_BASE_COLUMNS, parseExecutableView,
  type ExecutableViewConfig, type ViewFilter, type ViewQueryOptions,
} from "../schemas/saved_views.execute.schema";

export type ViewExecuteConnection = Pick<PoolConnection, "execute">;

interface ViewRow extends RowDataPacket {
  id: string | number | bigint;
  company_id: string | number | bigint;
  owner_user_id: string | number | bigint | null;
  entity_type: string;
  name: string;
  filter_json: unknown;
  shared: number | boolean | string;
}
interface FieldRow extends RowDataPacket {
  company_id: string | number | bigint;
  field_key: string;
  field_type: string;
}
interface LeadRow extends RowDataPacket {
  id: string | number | bigint;
  company_id: string | number | bigint;
  owner_user_id: string | number | bigint;
  title: string; status: string; priority: string; source_key: string | null;
  contact_id: string | number | bigint | null; account_id: string | number | bigint | null;
  created_by_user_id: string | number | bigint;
  assigned_at: Date | string | null; next_followup_at: Date | string | null;
  description: string | null; created_at: Date | string; updated_at: Date | string;
}
interface ValueRow extends RowDataPacket {
  company_id: string | number | bigint;
  entity_id: string | number | bigint;
  field_key: string;
  value_json: unknown;
}
const MAX_ID = 18446744073709551615n;
function id(value: unknown): string {
  if (typeof value === "bigint" && value > 0n && value <= MAX_ID) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= MAX_ID) return value;
  throw new Error("Invalid CRM database identifier");
}
const BASE = LEAD_BASE_COLUMNS as Readonly<Record<string, string>>;
function usesCustom(field: string): boolean { return !Object.hasOwn(BASE, field); }
function jsonScalarExpr(key: string, args: unknown[]): string {
  args.push(key);
  return `(SELECT JSON_UNQUOTE(JSON_EXTRACT(v.value_json, '$'))
    FROM custom_field_values AS v
    INNER JOIN custom_fields AS cf ON cf.company_id = v.company_id
      AND cf.id = v.custom_field_id
    WHERE v.company_id = l.company_id AND v.entity_type = 'leads'
      AND v.entity_id = l.id AND cf.entity_type = 'leads'
      AND cf.field_key = ? LIMIT 1)`;
}
function expression(field: string, args: unknown[]): string {
  if (usesCustom(field)) return jsonScalarExpr(field, args);
  const baseExpression = BASE[field];
  if (typeof baseExpression !== "string") throw AppError.badRequest();
  return baseExpression;
}
function filterSql(filter: ViewFilter, args: unknown[], types: ReadonlyMap<string, string>): string {
  const fieldType = types.get(filter.field) ?? "";
  if ((filter.operator === "gte" || filter.operator === "lte") && usesCustom(filter.field) &&
      !["number", "decimal", "currency", "integer", "date", "datetime"].includes(fieldType)) {
    throw AppError.badRequest();
  }
  let expr = expression(filter.field, args);
  if (usesCustom(filter.field) && ["number", "decimal", "currency", "integer"].includes(fieldType)) {
    expr = `CAST(${expr} AS DECIMAL(30,6))`;
  }
  if (filter.operator === "in") {
    const values = filter.values ?? [];
    args.push(...values.map(v => String(v)));
    return `${expr} IN (${values.map(() => "?").join(",")})`;
  }
  if (filter.operator === "contains") {
    if (typeof filter.value !== "string") throw AppError.badRequest();
    // The LOCATE needle occurs before the custom-field expression in SQL.
    // Reorder bound arguments; never interpolate the customer-supplied value.
    if (usesCustom(filter.field)) {
      const last = args.pop();
      args.push(filter.value, last);
    } else {
      args.push(filter.value);
    }
    return `LOCATE(?, COALESCE(${expr}, '')) > 0`;
  }
  if (filter.value === null) {
    if (filter.operator === "equals") return `${expr} IS NULL`;
    if (filter.operator === "not_equals") return `${expr} IS NOT NULL`;
    throw AppError.badRequest();
  }
  args.push(typeof filter.value === "boolean" ? Number(filter.value) : filter.value);
  const op = filter.operator === "equals" ? "=" : filter.operator === "not_equals" ? "<>" :
    filter.operator === "gte" ? ">=" : "<=";
  return `${expr} ${op} ?`;
}
function jsonValue(raw: unknown): unknown {
  if (raw === null) return null;
  if (typeof raw === "string") { try { return JSON.parse(raw); } catch { throw new Error("Invalid custom field value JSON"); } }
  return raw;
}
function serialize(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

export interface ViewResultsDependencies {
  readonly connection: ViewExecuteConnection;
  readonly managerScopeResolver?: ManagerLeadScopeResolver;
}
/** All SQL field identifiers are from a server-owned map; customer input is bound data. */
export async function querySavedLeadView(
  tenant: TenantContext, viewId: string, page: ViewQueryOptions,
  deps: ViewResultsDependencies
) {
  const db = deps.connection;
  const [viewRows] = await db.execute<ViewRow[]>(
    `SELECT id, company_id, owner_user_id, entity_type, name, filter_json, shared
      FROM saved_views WHERE company_id = ? AND id = ? AND entity_type = 'leads'
      AND (shared = 1 OR owner_user_id = ?) LIMIT 1`,
    [tenant.companyId, viewId, tenant.actorUserId]
  );
  const view = viewRows[0];
  if (!view) throw AppError.notFound();
  if (id(view.company_id) !== tenant.companyId || id(view.id) !== viewId || view.entity_type !== "leads" ||
      (view.shared !== 1 && view.shared !== "1" && view.shared !== true &&
       (view.owner_user_id === null || id(view.owner_user_id) !== tenant.actorUserId))) {
    throw AppError.forbidden();
  }
  if (typeof view.name !== "string") throw new Error("Invalid saved view name");
  const config: ExecutableViewConfig = parseExecutableView(view.filter_json);
  const fields = [...new Set([
    ...config.columns, ...config.filters.map(f => f.field), ...config.sorting.map(s => s.field),
  ])];
  const customKeys = fields.filter(usesCustom);
  const types = new Map<string, string>();
  if (customKeys.length > 0) {
    const [fieldRows] = await db.execute<FieldRow[]>(
      `SELECT company_id, field_key, field_type FROM custom_fields
       WHERE company_id = ? AND entity_type = 'leads'
       AND field_key IN (${customKeys.map(() => "?").join(",")})`,
      [tenant.companyId, ...customKeys]
    );
    for (const item of fieldRows) {
      if (id(item.company_id) !== tenant.companyId || !customKeys.includes(item.field_key)) throw AppError.forbidden();
      types.set(item.field_key, item.field_type);
    }
    if (types.size !== customKeys.length) throw AppError.badRequest();
  }
  const args: unknown[] = [tenant.companyId];
  const where = ["l.company_id = ?"];
  let permittedOwners: ReadonlySet<string> | null = null;
  if (tenant.role === "EMPLOYEE") {
    args.push(tenant.actorUserId);
    where.push("l.owner_user_id = ?");
  } else if (tenant.role === "MANAGER") {
    const resolve = deps.managerScopeResolver ?? createManagerLeadScopeResolver(db);
    const memberIds = await resolve(tenant);
    if (!Array.isArray(memberIds) || memberIds.length < 1 || memberIds.length > 5000 ||
        !memberIds.includes(tenant.actorUserId)) throw AppError.forbidden();
    const owners = [...new Set(memberIds.map(id))];
    permittedOwners = new Set(owners);
    args.push(...owners);
    where.push(`l.owner_user_id IN (${owners.map(() => "?").join(",")})`);
    // Membership is rechecked at query time; stale resolver data cannot expand access.
    args.push(tenant.actorUserId, tenant.actorUserId);
    where.push(`(l.owner_user_id = ? OR EXISTS (
      SELECT 1 FROM team_members AS tm
      INNER JOIN teams AS t ON t.company_id = tm.company_id AND t.id = tm.team_id
      INNER JOIN users AS u ON u.company_id = tm.company_id AND u.id = tm.user_id
      WHERE tm.company_id = l.company_id AND tm.user_id = l.owner_user_id
        AND tm.left_at IS NULL AND tm.joined_at <= UTC_TIMESTAMP(3)
        AND t.manager_user_id = ? AND t.status = 'active'
        AND u.role = 'employee' AND u.status = 'active'
    ))`);
  }
  for (const item of config.filters) where.push(filterSql(item, args, types));
  const sorts: string[] = [];
  for (const item of config.sorting) {
    const expr = expression(item.field, args);
    sorts.push(`${expr} ${item.direction.toUpperCase()}`);
  }
  sorts.push("l.id DESC");
  args.push(page.limit + 1, page.offset);
  // mysql2 accepts explicitly typed bound values, not an unknown[] array.
  // Reject any invalid generated argument before issuing the SELECT.
  const sqlParameters = args.map((value): string | number => {
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    throw AppError.badRequest();
  });
  const [leadRows] = await db.execute<LeadRow[]>(
    `SELECT l.id, l.company_id, l.title, l.status, l.priority, l.source_key,
        l.contact_id, l.account_id, l.owner_user_id, l.created_by_user_id,
        l.assigned_at, l.next_followup_at, l.description, l.created_at, l.updated_at
      FROM leads AS l WHERE ${where.join(" AND ")}
      ORDER BY ${sorts.join(", ")} LIMIT ? OFFSET ?`,
    sqlParameters
  );
  if (!Array.isArray(leadRows) || leadRows.length > page.limit + 1) throw new Error("Lead view result limit exceeded");
  const hasMore = leadRows.length > page.limit;
  const visible = leadRows.slice(0, page.limit);
  const identifiers = visible.map(row => id(row.id));
  for (const row of visible) {
    if (id(row.company_id) !== tenant.companyId) throw AppError.forbidden();
    const ownerId = id(row.owner_user_id);
    if (tenant.role === "EMPLOYEE" && ownerId !== tenant.actorUserId) throw AppError.forbidden();
    if (tenant.role === "MANAGER" && !permittedOwners?.has(ownerId)) throw AppError.forbidden();
  }
  const customColumns = config.columns.filter(usesCustom);
  const customValues = new Map<string, Map<string, unknown>>();
  if (identifiers.length && customColumns.length) {
    const [valueRows] = await db.execute<ValueRow[]>(
      `SELECT v.company_id, v.entity_id, cf.field_key, v.value_json
       FROM custom_field_values AS v
       INNER JOIN custom_fields AS cf ON cf.company_id = v.company_id AND cf.id = v.custom_field_id
       WHERE v.company_id = ? AND v.entity_type = 'leads' AND cf.entity_type = 'leads'
       AND v.entity_id IN (${identifiers.map(() => "?").join(",")})
       AND cf.field_key IN (${customColumns.map(() => "?").join(",")})`,
      [tenant.companyId, ...identifiers, ...customColumns]
    );
    for (const item of valueRows) {
      const entityId = id(item.entity_id);
      if (id(item.company_id) !== tenant.companyId || !identifiers.includes(entityId) ||
          !customColumns.includes(item.field_key)) throw AppError.forbidden();
      if (!customValues.has(entityId)) customValues.set(entityId, new Map());
      customValues.get(entityId)!.set(item.field_key, jsonValue(item.value_json));
    }
  }
  const items = visible.map(row => {
    const rowId = id(row.id);
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const field of config.columns) {
      if (usesCustom(field)) {
        values[field] = customValues.get(rowId)?.get(field) ?? null;
      } else {
        const property = field as keyof LeadRow;
        const raw = row[property];
        values[field] = raw === null ? null : serialize(raw);
      }
    }
    return Object.freeze({ id: rowId, values: Object.freeze(values) });
  });
  return Object.freeze({
    viewId, viewName: view.name, columns: config.columns,
    items: Object.freeze(items), nextOffset: hasMore ? page.offset + items.length : null,
  });
}