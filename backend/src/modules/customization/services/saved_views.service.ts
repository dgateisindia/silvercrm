import type { Response } from "express";
import { getDbPool } from "../../../core/database/pool";
import { AppError } from "../../../core/errors/AppError";
import { getTenantContext, type TenantContext } from "../../../core/tenant/tenantContext";
import { requirePermission } from "../../../core/permissions/policies";
import { parseSavedViewEntity, parseSavedViewId,
  parseNewSavedView, parseRevisedSavedView } from "../schemas/saved_views.schema";
import { listSavedViews, createSavedView, reviseSavedView,
  type SavedViewReadConnection, type SavedViewWriteConnection } from "../repositories/saved_views.repository";

export interface SavedViewServiceDependencies {
  readonly readConnection?: SavedViewReadConnection;
  readonly writeConnectionFactory?: () => Promise<SavedViewWriteConnection>;
  /** Future modules must provide a trusted, server-side permission check. */
  readonly authorizeEntityRead?: (tenant: TenantContext, entityType: string) => void | Promise<void>;
}

function requestId(res: Response): string | null {
  const value: unknown = res.locals.requestId;
  return typeof value === "string" && value.length > 0 && value.length <= 100 ? value : null;
}

async function transaction<T>(factory: () => Promise<SavedViewWriteConnection>,
  operation: (db: SavedViewWriteConnection) => Promise<T>): Promise<T> {
  const db = await factory();
  let started = false;
  let uncertain = false;
  let destroy = false;
  try {
    await db.beginTransaction();
    started = true;
    const result = await operation(db);
    uncertain = true;
    await db.commit();
    uncertain = false;
    started = false;
    return result;
  } catch (error) {
    if (uncertain) destroy = true;
    else if (started) {
      try { await db.rollback(); } catch { destroy = true; }
    }
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") {
      throw AppError.conflict();
    }
    throw error;
  } finally {
    if (destroy) db.destroy();
    else db.release();
  }
}

/** Metadata access only; applying filters to actual records requires separate safe query compilation. */
export function createSavedViewService(dependencies: SavedViewServiceDependencies = {}) {
  const reads = dependencies.readConnection ?? getDbPool();
  const factory = dependencies.writeConnectionFactory ?? (() => getDbPool().getConnection());

  async function entityAuth(tenant: TenantContext, entityType: string) {
    if (entityType === "leads" || entityType === "accounts" || entityType === "contacts") {
      requirePermission(tenant, "leads.read");
    } else if (entityType === "deals") {
      requirePermission(tenant, "deals.read");
    } else if (dependencies.authorizeEntityRead) {
      await dependencies.authorizeEntityRead(tenant, entityType);
    } else {
      throw AppError.forbidden();
    }
  }

  async function list(res: Response, rawEntity: unknown) {
    const entityType = parseSavedViewEntity(rawEntity);
    const tenant = getTenantContext(res);
    await entityAuth(tenant, entityType);
    return listSavedViews(reads, tenant, entityType);
  }

  async function create(res: Response, input: unknown) {
    const tenant = getTenantContext(res);
    const data = parseNewSavedView(input);
    await entityAuth(tenant, data.entityType);
    if (data.scope === "company") requirePermission(tenant, "settings.manage");
    else if (tenant.accessMode !== "FULL") throw AppError.forbidden();
    return transaction(factory, db => createSavedView(db, tenant, data, requestId(res)));
  }

  async function revise(res: Response, rawId: unknown, input: unknown) {
    const tenant = getTenantContext(res);
    const id = parseSavedViewId(rawId);
    const revision = parseRevisedSavedView(input);
    if (tenant.accessMode !== "FULL") throw AppError.forbidden();
    // Visibility/authorization of the persisted entity is checked under the row lock.
    // Supported entities use their established read policies; all others still fail closed.
    // A malicious client must not be able to update records of unapproved modules.
    return transaction(factory, async db => {
      const [rows] = await db.execute<Array<import("mysql2/promise").RowDataPacket & { entity_type: string }>>(
        `SELECT entity_type FROM saved_views WHERE company_id = ? AND id = ? FOR UPDATE`,
        [tenant.companyId, id]
      );
      const row = rows[0];
      if (!row) throw AppError.notFound();
      const entityType = parseSavedViewEntity(row.entity_type);
      await entityAuth(tenant, entityType);
      return reviseSavedView(db, tenant, id, revision, requestId(res));
    });
  }

  return Object.freeze({ list, create, revise });
}