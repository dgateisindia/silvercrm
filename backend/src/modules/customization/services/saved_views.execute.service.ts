import type { Response } from "express";
import { getDbPool } from "../../../core/database/pool";
import { getTenantContext } from "../../../core/tenant/tenantContext";
import { requirePermission } from "../../../core/permissions/policies";
import { parseViewId, type ViewQueryOptions } from "../schemas/saved_views.execute.schema";
import {
  querySavedLeadView, type ViewExecuteConnection,
  type ViewResultsDependencies,
} from "../repositories/saved_views.execute.repository";
import type { ManagerLeadScopeResolver } from "../../leads/services/leads.service";

export interface SavedViewExecutionDependencies {
  readonly connection?: ViewExecuteConnection;
  readonly managerScopeResolver?: ManagerLeadScopeResolver;
}
/** Saved views never grant access: the signed-in user's leads.read and SQL scope always apply. */
export function createSavedViewExecutionService(deps: SavedViewExecutionDependencies = {}) {
  const queryDeps: ViewResultsDependencies = {
    connection: deps.connection ?? getDbPool(),
    ...(deps.managerScopeResolver ? { managerScopeResolver: deps.managerScopeResolver } : {}),
  };
  async function executeLeads(res: Response, rawViewId: unknown, options: ViewQueryOptions) {
    const tenant = getTenantContext(res);
    requirePermission(tenant, "leads.read");
    const viewId = parseViewId(rawViewId);
    return querySavedLeadView(tenant, viewId, options, queryDeps);
  }
  return Object.freeze({ executeLeads });
}