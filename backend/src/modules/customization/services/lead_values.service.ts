import type { Response } from "express";
import { getDbPool } from "../../../core/database/pool";
import { AppError } from "../../../core/errors/AppError";
import { getTenantContext } from "../../../core/tenant/tenantContext";
import { requirePermission } from "../../../core/permissions/policies";
import { parseRecordId, parseCustomKey, parseValueEdit } from "../schemas/lead_values.schema";
import { readLeadCustomValues, updateLeadCustomValue,
  type LeadValuesReadConnection, type LeadValuesWriteConnection } from "../repositories/lead_values.repository";

export interface LeadValuesServiceDependencies {
  readonly readConnection?: LeadValuesReadConnection;
  readonly writeConnectionFactory?: () => Promise<LeadValuesWriteConnection>;
}
function requestId(res: Response): string | null {
  const value: unknown = res.locals.requestId;
  return typeof value === "string" && value.length > 0 && value.length <= 100 ? value : null;
}
async function transaction<T>(factory: () => Promise<LeadValuesWriteConnection>,
  operation: (db: LeadValuesWriteConnection) => Promise<T>): Promise<T> {
  const db = await factory();
  let started = false;
  let ambiguous = false;
  let destroy = false;
  try {
    await db.beginTransaction();
    started = true;
    const result = await operation(db);
    ambiguous = true;
    await db.commit();
    ambiguous = false;
    started = false;
    return result;
  } catch (error) {
    if (ambiguous) destroy = true;
    else if (started) {
      try { await db.rollback(); } catch { destroy = true; }
    }
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") {
      throw AppError.conflict();
    }
    throw error;
  } finally {
    if (destroy) db.destroy(); else db.release();
  }
}
/** Only the user's lead permissions allow viewing; owner has read-only sales access. */
export function createLeadValuesService(dependencies: LeadValuesServiceDependencies = {}) {
  const reads = dependencies.readConnection ?? getDbPool();
  const factory = dependencies.writeConnectionFactory ?? (() => getDbPool().getConnection());

  async function list(res: Response, rawLeadId: unknown) {
    const tenant = getTenantContext(res);
    requirePermission(tenant, "leads.read");
    const leadId = parseRecordId(rawLeadId);
    return readLeadCustomValues(reads, tenant, leadId);
  }
  async function put(res: Response, rawLeadId: unknown, rawFieldKey: unknown, body: unknown) {
    const tenant = getTenantContext(res);
    requirePermission(tenant, "leads.read");
    if (tenant.role === "OWNER" || tenant.accessMode !== "FULL") throw AppError.forbidden();
    // In addition to the role and record scope, honor any explicit lead-update restriction.
    requirePermission(tenant, "leads.update");
    const leadId = parseRecordId(rawLeadId);
    const fieldKey = parseCustomKey(rawFieldKey);
    const edit = parseValueEdit(body);
    return transaction(factory, db => updateLeadCustomValue(
      db, tenant, leadId, fieldKey, edit, requestId(res)
    ));
  }
  return Object.freeze({ list, put });
}