import type { Response } from "express";

import {
  getDbPool,
} from "../../../core/database/pool";

import {
  getTenantContext,
} from "../../../core/tenant/tenantContext";

import {
  requirePermission,
} from "../../../core/permissions/policies";

import {
  AppError,
} from "../../../core/errors/AppError";

import {
  parseNewLead,
} from "../schemas/lead_create.schema";

import {
  insertLeadWithCustomValues,
  type LeadCreateConnection,
} from "../repositories/lead_create.repository";

export interface LeadCreateDependencies {
  readonly connectionFactory?: () =>
    Promise<LeadCreateConnection>;
}

export function createLeadCreationService(
  deps: LeadCreateDependencies = {}
) {
  const factory =
    deps.connectionFactory ??
    (() => getDbPool().getConnection());

  async function create(
    res: Response,
    body: unknown
  ) {
    const tenant = getTenantContext(res);

    requirePermission(
      tenant,
      "leads.update"
    );

    if (
      tenant.accessMode !== "FULL" ||
      !["MANAGER", "EMPLOYEE"].includes(
        tenant.role
      )
    ) {
      throw AppError.forbidden();
    }

    const input = parseNewLead(
      body,
      tenant.actorUserId
    );

    const rawRequestId: unknown =
      res.locals.requestId;

    const requestId =
      typeof rawRequestId === "string" &&
      rawRequestId.length <= 100
        ? rawRequestId
        : null;

    const db = await factory();

    let active = false;
    let ambiguousCommit = false;
    let destroy = false;

    try {
      await db.beginTransaction();

      active = true;

      const result =
        await insertLeadWithCustomValues(
          db,
          tenant,
          input,
          requestId
        );

      ambiguousCommit = true;

      await db.commit();

      ambiguousCommit = false;
      active = false;

      return result;
    } catch (error) {
      if (ambiguousCommit) {
        destroy = true;
      } else if (active) {
        try {
          await db.rollback();
        } catch {
          destroy = true;
        }
      }

      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ER_DUP_ENTRY"
      ) {
        throw AppError.conflict();
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

  return Object.freeze({
    create,
  });
}
