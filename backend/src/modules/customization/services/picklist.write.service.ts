import type { Response } from "express";
import { getDbPool } from "../../../core/database/pool";
import { getTenantContext } from "../../../core/tenant/tenantContext";
import { requirePermission } from "../../../core/permissions/policies";
import { AppError } from "../../../core/errors/AppError";
import { parseNewPicklistChoice, parseRevisedPicklistChoice, parsePicklistChoiceId } from "../schemas/picklist.write.schema";
import { createPicklistWriteRepository, type PicklistWriteConnection } from "../repositories/picklist.write.repository";

export interface PicklistWriteDependencies {
  readonly connectionFactory?: () => Promise<PicklistWriteConnection>;
}

async function transaction<T>(factory: () => Promise<PicklistWriteConnection>, work: (db: PicklistWriteConnection) => Promise<T>): Promise<T> {
  const db = await factory();
  let started = false;
  let ambiguousCommit = false;
  let destroy = false;
  try {
    await db.beginTransaction();
    started = true;
    const result = await work(db);
    ambiguousCommit = true;
    await db.commit();
    ambiguousCommit = false;
    started = false;
    return result;
  } catch (error) {
    if (ambiguousCommit) {
      destroy = true;
    } else if (started) {
      try { await db.rollback(); } catch { destroy = true; }
    }
    throw error;
  } finally {
    if (destroy) db.destroy();
    else db.release();
  }
}

function requestId(res: Response): string | null {
  const value: unknown = res.locals.requestId;
  return typeof value === "string" && value.length > 0 && value.length <= 100 ? value : null;
}

function translateConflict(error: unknown): never {
  if (error !== null && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") {
    throw AppError.conflict();
  }
  throw error;
}

/** The verified tenant context—not the request body—selects the company and actor. */
export function createPicklistWriteService(dependencies: PicklistWriteDependencies = {}) {
  const factory = dependencies.connectionFactory ?? (() => getDbPool().getConnection());

  async function create(res: Response, input: unknown) {
    const tenant = getTenantContext(res);
    const definition = parseNewPicklistChoice(input);
    const isLeadStatusOrPriority = definition.entityType === "leads" &&
      (definition.fieldKey === "status" || definition.fieldKey === "priority");
    requirePermission(tenant, isLeadStatusOrPriority
      ? "customization.leads.picklists.manage"
      : "settings.manage");
    try {
      return await transaction(factory, db =>
        createPicklistWriteRepository(db).create(tenant, definition, requestId(res)));
    } catch (error) { return translateConflict(error); }
  }

  async function revise(res: Response, optionId: unknown, input: unknown) {
    const tenant = getTenantContext(res);
    // Coarse authorization: the repository checks the saved option scope
    // before updating, so Managers cannot edit options from other fields.
    requirePermission(tenant, "customization.leads.picklists.manage");
    const id = parsePicklistChoiceId(optionId);
    const revision = parseRevisedPicklistChoice(input);
    try {
      return await transaction(factory, db =>
        createPicklistWriteRepository(db).revise(tenant, id, revision, requestId(res)));
    } catch (error) { return translateConflict(error); }
  }

  return Object.freeze({ create, revise });
}