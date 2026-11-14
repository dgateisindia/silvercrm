import type { Response } from "express";

import { getDbPool } from "../../../core/database/pool";

import {
  getTenantContext,
} from "../../../core/tenant/tenantContext";

import {
  requirePermission,
} from "../../../core/permissions/policies";

import { AppError } from "../../../core/errors/AppError";

import {
  leadRecordId,
  parseLeadEdit,
} from "../schemas/lead_edit.schema";

import {
  lockedLead,
  reviseLead,
  type LeadEditConnection,
} from "../repositories/lead_edit.repository";

export interface LeadEditDependencies {
  readonly connectionFactory?: () =>
    Promise<LeadEditConnection>;
}

async function transaction<T>(
  factory: () => Promise<LeadEditConnection>,
  work: (db: LeadEditConnection) => Promise<T>
): Promise<T> {
  const db = await factory();

  let begun = false;
  let commitAttempted = false;
  let destroy = false;

  try {
    await db.beginTransaction();

    begun = true;

    const value = await work(db);

    commitAttempted = true;

    await db.commit();

    commitAttempted = false;
    begun = false;

    return value;
  } catch (error) {
    if (commitAttempted) {
      destroy = true;
    } else if (begun) {
      try {
        await db.rollback();
      } catch {
        destroy = true;
      }
    }

    throw error;
  } finally {
    if (destroy) {
      db.destroy();
    } else {
      db.release();
    }
  }
}

export function createLeadEditService(
  deps: LeadEditDependencies = {}
) {
  const factory =
    deps.connectionFactory ??
    (() => getDbPool().getConnection());

  async function get(
    res: Response,
    leadId: unknown
  ) {
    const tenant = getTenantContext(res);

    requirePermission(
      tenant,
      "leads.read"
    );

    const id = leadRecordId(leadId);

    return transaction(
      factory,
      db => lockedLead(db, tenant, id)
    );
  }

  async function edit(
    res: Response,
    leadId: unknown,
    input: unknown
  ) {
    const tenant = getTenantContext(res);

    requirePermission(
      tenant,
      "leads.update"
    );

    if (
      tenant.accessMode !== "FULL" ||
      tenant.role === "OWNER"
    ) {
      throw AppError.forbidden();
    }

    const id = leadRecordId(leadId);
    const data = parseLeadEdit(input);

    const rawId: unknown =
      res.locals.requestId;

    const requestId =
      typeof rawId === "string" &&
      rawId.length <= 100
        ? rawId
        : null;

    return transaction(
      factory,
      db => reviseLead(
        db,
        tenant,
        id,
        data,
        requestId
      )
    );
  }

  return Object.freeze({
    get,
    edit,
  });
}