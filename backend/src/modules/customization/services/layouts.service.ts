import type { Response } from "express";
import type { RowDataPacket } from "mysql2/promise";
import { getDbPool } from "../../../core/database/pool";
import { AppError } from "../../../core/errors/AppError";
import { getTenantContext, type TenantContext } from "../../../core/tenant/tenantContext";
import { requirePermission, hasPermission } from "../../../core/permissions/policies";
import {
  parsePageKey, parseCompanyPageInput, parsePersonalPageInput, parseDashboardInput,
  parseDashboardRevision, parseDashboardId, validateLeadFormPresentation,
} from "../schemas/layouts.schema";
import {
  getPageConfiguration, saveCompanyPage, savePersonalPage, listDashboards,
  createDashboard, reviseDashboard, type LayoutReadConnection, type LayoutWriteConnection,
} from "../repositories/layouts.repository";

export interface LayoutServiceDependencies {
  readonly readConnection?: LayoutReadConnection;
  readonly writeConnectionFactory?: () => Promise<LayoutWriteConnection>;
  /** Future feature modules must register their own server-side page authorization. */
  readonly authorizePageRead?: (tenant: TenantContext, pageKey: string) => void | Promise<void>;
}

function requestId(res: Response): string | null {
  const id: unknown = res.locals.requestId;
  return typeof id === "string" && id.length > 0 && id.length <= 100 ? id : null;
}

async function transaction<T>(factory: () => Promise<LayoutWriteConnection>,
  work: (db: LayoutWriteConnection) => Promise<T>): Promise<T> {
  const db = await factory();
  let begun = false;
  let uncertain = false;
  let destroy = false;
  try {
    await db.beginTransaction();
    begun = true;
    const result = await work(db);
    uncertain = true;
    await db.commit();
    uncertain = false;
    begun = false;
    return result;
  } catch (error) {
    if (uncertain) {
      destroy = true;
    } else if (begun) {
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

/** Read only configuration metadata; metric data still needs its module's authorization. */
export function createLayoutService(dependencies: LayoutServiceDependencies = {}) {
  const reads = dependencies.readConnection ?? getDbPool();
  const factory = dependencies.writeConnectionFactory ?? (() => getDbPool().getConnection());

  async function pageAuth(res: Response, pageKey: string): Promise<TenantContext> {
    const tenant = getTenantContext(res);
    if (pageKey === "leads" || pageKey.startsWith("leads.")) {
      requirePermission(tenant, "leads.read");
    } else if (dependencies.authorizePageRead) {
      await dependencies.authorizePageRead(tenant, pageKey);
    } else {
      throw AppError.forbidden();
    }
    return tenant;
  }

  async function getPage(res: Response, rawPageKey: unknown) {
    const pageKey = parsePageKey(rawPageKey);
    const tenant = await pageAuth(res, pageKey);
    return getPageConfiguration(reads, tenant, pageKey);
  }

  async function putCompanyPage(res: Response, rawPageKey: unknown, input: unknown) {
    const pageKey = parsePageKey(rawPageKey);
    const tenant = await pageAuth(res, pageKey);
    // Only Lead form presentation is delegated to Managers; all other pages
    // keep the existing Owner-only company settings permission.
    requirePermission(tenant, pageKey === "leads.form" ? "customization.fields.manage" : "settings.manage");
    const config = parseCompanyPageInput(input);
    if (pageKey === "leads.form") {
      validateLeadFormPresentation(config.configJson);
      const presentation = JSON.parse(config.configJson) as { hidden: string[] };
      // Backend rejects hiding required company custom fields, regardless of UI.
      const [requiredFields] = await reads.execute<(RowDataPacket & { field_key: string })[]>(
        `SELECT field_key FROM custom_fields WHERE company_id = ? AND entity_type = 'leads' AND required = 1`,
        [tenant.companyId]
      );
      if (requiredFields.some(field => presentation.hidden.includes(field.field_key))) {
        throw AppError.badRequest();
      }
    }
    return transaction(factory, db => saveCompanyPage(db, tenant, pageKey, config, requestId(res)));
  }

  async function putPersonalPage(res: Response, rawPageKey: unknown, input: unknown) {
    const pageKey = parsePageKey(rawPageKey);
    const tenant = await pageAuth(res, pageKey);
    if (tenant.accessMode !== "FULL") throw AppError.forbidden();
    const preference = parsePersonalPageInput(input);
    return transaction(factory, db => savePersonalPage(db, tenant, pageKey, preference, requestId(res)));
  }

  async function getDashboards(res: Response) {
    const tenant = getTenantContext(res);
    requirePermission(tenant, "leads.read");
    return listDashboards(reads, tenant);
  }

  async function postDashboard(res: Response, input: unknown) {
    const tenant = getTenantContext(res);
    requirePermission(tenant, "leads.read");
    const data = parseDashboardInput(input);
    if (data.scope === "company") requirePermission(tenant, "settings.manage");
    else if (tenant.accessMode !== "FULL") throw AppError.forbidden();
    return transaction(factory, db => createDashboard(db, tenant, data, requestId(res)));
  }

  async function patchDashboard(res: Response, rawId: unknown, input: unknown) {
    const tenant = getTenantContext(res);
    requirePermission(tenant, "leads.read");
    if (tenant.accessMode !== "FULL") throw AppError.forbidden();
    const id = parseDashboardId(rawId);
    const revision = parseDashboardRevision(input);
    const allowCompanyEdit = hasPermission(tenant, "settings.manage");
    return transaction(factory, db => reviseDashboard(db, tenant, id, revision,
      requestId(res), allowCompanyEdit));
  }

  return Object.freeze({ getPage, putCompanyPage, putPersonalPage, getDashboards, postDashboard, patchDashboard });
}