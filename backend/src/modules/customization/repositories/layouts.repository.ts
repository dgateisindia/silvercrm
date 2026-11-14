import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { AppError } from "../../../core/errors/AppError";
import type { TenantContext } from "../../../core/tenant/tenantContext";
import type { CompanyPageInput, PersonalPageInput, DashboardInput, DashboardRevision } from "../schemas/layouts.schema";

export type LayoutReadConnection = Pick<PoolConnection, "execute">;
export type LayoutWriteConnection = Pick<PoolConnection, "execute" | "beginTransaction" | "commit" | "rollback" | "release" | "destroy">;
interface PageRow extends RowDataPacket { id: unknown; company_id: unknown; page_key: string; config_json: unknown; version_no: number; }
interface PreferenceRow extends RowDataPacket { id: unknown; company_id: unknown; user_id: unknown; page_key: string; preference_json: unknown; }
interface DashboardRow extends RowDataPacket { id: unknown; company_id: unknown; user_id: unknown; name: string; layout_json: unknown; }

function strId(value: unknown): string {
  if (typeof value === "bigint" && value > 0n) return String(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n) return value;
  throw new Error("Invalid layout database identifier");
}

function jsonValue(value: unknown): Record<string, unknown> {
  let result: unknown = value;
  if (typeof result === "string") result = JSON.parse(result);
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Invalid stored layout document");
  }
  return result as Record<string, unknown>;
}

function verifyTenant(company: unknown, tenant: TenantContext): void {
  if (strId(company) !== tenant.companyId) throw AppError.forbidden();
}

export async function getPageConfiguration(db: LayoutReadConnection, tenant: TenantContext, pageKey: string) {
  const [pageRows] = await db.execute<PageRow[]>(
    `SELECT id, company_id, page_key, config_json, version_no
     FROM crm_custom_page_config WHERE company_id = ? AND page_key = ? LIMIT 1`,
    [tenant.companyId, pageKey]);
  const [prefRows] = await db.execute<PreferenceRow[]>(
    `SELECT id, company_id, user_id, page_key, preference_json
     FROM user_page_preferences WHERE company_id = ? AND user_id = ? AND page_key = ? LIMIT 1`,
    [tenant.companyId, tenant.actorUserId, pageKey]);
  const page = pageRows[0];
  const pref = prefRows[0];
  if (page) {
    verifyTenant(page.company_id, tenant);
    if (page.page_key !== pageKey || !Number.isSafeInteger(page.version_no)) throw new Error("Invalid page row");
  }
  if (pref) {
    verifyTenant(pref.company_id, tenant);
    if (pref.page_key !== pageKey || strId(pref.user_id) !== tenant.actorUserId) throw AppError.forbidden();
  }
  return {
    pageKey,
    company: page ? { version: page.version_no, config: jsonValue(page.config_json) } : null,
    personal: pref ? jsonValue(pref.preference_json) : null,
  };
}

async function audit(db: LayoutWriteConnection, tenant: TenantContext, action: string,
  entityType: string, entityId: string, details: Record<string, unknown>, requestId: string | null): Promise<void> {
  await db.execute(
    `INSERT INTO audit_logs
      (company_id, actor_user_id, action, entity_type, entity_id, outcome, request_id, details_json, occurred_at)
     VALUES (?, ?, ?, ?, ?, 'success', ?, ?, UTC_TIMESTAMP(3))`,
    [tenant.companyId, tenant.actorUserId, action, entityType, entityId, requestId, JSON.stringify(details)]);
}

export async function saveCompanyPage(db: LayoutWriteConnection, tenant: TenantContext,
  pageKey: string, input: CompanyPageInput, requestId: string | null) {
  const [rows] = await db.execute<PageRow[]>(
    `SELECT id, company_id, page_key, version_no FROM crm_custom_page_config
     WHERE company_id = ? AND page_key = ? FOR UPDATE`,
    [tenant.companyId, pageKey]);
  const existing = rows[0];
  let id: string;
  let nextVersion: number;
  if (!existing) {
    if (input.expectedVersion !== 0) throw AppError.conflict();
    const [result] = await db.execute<ResultSetHeader>(
      `INSERT INTO crm_custom_page_config (company_id, page_key, config_json, version_no)
       VALUES (?, ?, ?, 1)`,
      [tenant.companyId, pageKey, input.configJson]);
    id = strId(result.insertId);
    nextVersion = 1;
  } else {
    verifyTenant(existing.company_id, tenant);
    if (existing.page_key !== pageKey) throw AppError.forbidden();
    if (!Number.isSafeInteger(existing.version_no) || existing.version_no !== input.expectedVersion || existing.version_no >= 4294967295) {
      throw AppError.conflict();
    }
    id = strId(existing.id);
    nextVersion = existing.version_no + 1;
    const [result] = await db.execute<ResultSetHeader>(
      `UPDATE crm_custom_page_config SET config_json = ?, version_no = ?
       WHERE company_id = ? AND id = ? AND version_no = ?`,
      [input.configJson, nextVersion, tenant.companyId, id, input.expectedVersion]);
    if (result.affectedRows !== 1) throw AppError.conflict();
  }
  await audit(db, tenant, "page_layout.saved", "page_layout", id, { pageKey, version: nextVersion }, requestId);
  return { pageKey, version: nextVersion };
}

export async function savePersonalPage(db: LayoutWriteConnection, tenant: TenantContext,
  pageKey: string, input: PersonalPageInput, requestId: string | null) {
  await db.execute(
    `INSERT INTO user_page_preferences (company_id, user_id, page_key, preference_json)
     VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE preference_json = VALUES(preference_json)`,
    [tenant.companyId, tenant.actorUserId, pageKey, input.configJson]);
  const [rows] = await db.execute<PreferenceRow[]>(
    `SELECT id, company_id, user_id, page_key FROM user_page_preferences
     WHERE company_id = ? AND user_id = ? AND page_key = ? LIMIT 1`,
    [tenant.companyId, tenant.actorUserId, pageKey]);
  const row = rows[0];
  if (!row || strId(row.user_id) !== tenant.actorUserId || row.page_key !== pageKey) throw AppError.forbidden();
  verifyTenant(row.company_id, tenant);
  await audit(db, tenant, "page_preference.saved", "page_preference", strId(row.id), { pageKey }, requestId);
  return { pageKey, saved: true };
}

export async function listDashboards(db: LayoutReadConnection, tenant: TenantContext) {
  const [rows] = await db.execute<DashboardRow[]>(
    `SELECT id, company_id, user_id, name, layout_json
     FROM dashboard_layouts WHERE company_id = ? AND (user_id IS NULL OR user_id = ?)
     ORDER BY id DESC LIMIT 201`,
    [tenant.companyId, tenant.actorUserId]);
  if (!Array.isArray(rows) || rows.length > 200) throw new Error("Dashboard layout limit exceeded");
  return rows.map(row => {
    verifyTenant(row.company_id, tenant);
    const owner = row.user_id === null ? null : strId(row.user_id);
    if (owner !== null && owner !== tenant.actorUserId) throw AppError.forbidden();
    return {
      id: strId(row.id), scope: owner === null ? "company" : "personal",
      name: row.name, layout: jsonValue(row.layout_json),
    };
  });
}

export async function createDashboard(db: LayoutWriteConnection, tenant: TenantContext,
  input: DashboardInput, requestId: string | null) {
  const owner = input.scope === "company" ? null : tenant.actorUserId;
  const [result] = await db.execute<ResultSetHeader>(
    `INSERT INTO dashboard_layouts (company_id, user_id, name, layout_json) VALUES (?, ?, ?, ?)`,
    [tenant.companyId, owner, input.name, input.layoutJson]);
  const id = strId(result.insertId);
  await audit(db, tenant, "dashboard_layout.created", "dashboard_layout", id, { scope: input.scope }, requestId);
  return { id, scope: input.scope };
}

export async function reviseDashboard(db: LayoutWriteConnection, tenant: TenantContext,
  id: string, input: DashboardRevision, requestId: string | null, allowCompanyEdit: boolean) {
  const [rows] = await db.execute<DashboardRow[]>(
    `SELECT id, company_id, user_id, name, layout_json FROM dashboard_layouts
     WHERE company_id = ? AND id = ? FOR UPDATE`,
    [tenant.companyId, id]);
  const row = rows[0];
  if (!row) throw AppError.notFound();
  verifyTenant(row.company_id, tenant);
  const owner = row.user_id === null ? null : strId(row.user_id);
  if (owner === null) {
    if (!allowCompanyEdit) throw AppError.forbidden();
  } else if (owner !== tenant.actorUserId) {
    throw AppError.notFound();
  }
  const beforeJson = JSON.stringify(jsonValue(row.layout_json));
  if (row.name !== input.expectedName || beforeJson !== input.expectedLayoutJson) throw AppError.conflict();
  const [changed] = await db.execute<ResultSetHeader>(
    `UPDATE dashboard_layouts SET name = ?, layout_json = ? WHERE company_id = ? AND id = ?`,
    [input.name, input.layoutJson, tenant.companyId, id]);
  if (changed.affectedRows !== 1) throw AppError.conflict();
  await audit(db, tenant, "dashboard_layout.updated", "dashboard_layout", id,
    { scope: owner === null ? "company" : "personal" }, requestId);
  return { id, updated: true };
}