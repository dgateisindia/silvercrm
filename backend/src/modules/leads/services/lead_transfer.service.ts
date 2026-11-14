import type { Response } from "express";

import { getDbPool } from "../../../core/database/pool";
import { getTenantContext } from "../../../core/tenant/tenantContext";
import { requirePermission } from "../../../core/permissions/policies";
import { AppError } from "../../../core/errors/AppError";

import { leadRecordId } from "../schemas/lead_edit.schema";
import { parseDirectTransfer } from "../schemas/lead_transfer.schema";

import {
  executeDirectTransfer,
  type DirectTransferConnection,
} from "../repositories/lead_transfer.repository";

export interface DirectTransferDependencies {
  readonly connectionFactory?: () => Promise<DirectTransferConnection>;
}

export function createDirectTransferService(
  deps: DirectTransferDependencies = {}
) {
  const factory =
    deps.connectionFactory ??
    (() => getDbPool().getConnection());

  async function transfer(
    res: Response,
    rawLeadId: unknown,
    input: unknown
  ) {
    const tenant = getTenantContext(res);

    requirePermission(tenant, "leads.update");

    if (
      tenant.role !== "MANAGER" ||
      tenant.accessMode !== "FULL"
    ) {
      throw AppError.forbidden();
    }

    const leadId = leadRecordId(rawLeadId);
    const body = parseDirectTransfer(input);

    const rawRequestId: unknown = res.locals.requestId;

    const requestId =
      typeof rawRequestId === "string" &&
      rawRequestId.length <= 100
        ? rawRequestId
        : null;

    const db = await factory();

    let begun = false;
    let commitAttempted = false;
    let destroy = false;

    try {
      await db.beginTransaction();

      begun = true;

      const result = await executeDirectTransfer(
        db,
        tenant,
        leadId,
        body,
        requestId
      );

      commitAttempted = true;

      await db.commit();

      commitAttempted = false;
      begun = false;

      return result;
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

  return Object.freeze({ transfer });
}