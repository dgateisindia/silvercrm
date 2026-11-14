import type {
  RequestHandler,
} from "express";

import {
  AppError,
} from "../../../core/errors/AppError";

import {
  createManagerLeadScopeResolver,
} from "../policies/managerLeadScope";

import {
  getLeadForViewer,
  listLeadsForViewer,
  type LeadServiceOptions,
} from "../services/leads.service";

import type {
  LeadQueryConnection,
  LeadRecord,
} from "../repositories/leads.repository";

import type {
  ManagerLeadScopeResolver,
} from "../services/leads.service";

const MAX_UNSIGNED_BIGINT =
  18446744073709551615n;

export interface LeadsControllerDependencies {
  readonly connection?: LeadQueryConnection;
  readonly managerScopeResolver?: ManagerLeadScopeResolver;
}

export interface LeadsController {
  readonly list: RequestHandler;
  readonly getById: RequestHandler;
}

/**
 * Validate external identifiers before passing
 * them into the CRM business service.
 */
function isValidId(
  value: unknown
): value is string {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]{0,19}$/.test(value) &&
    BigInt(value) <= MAX_UNSIGNED_BIGINT
  );
}

/**
 * Parse and validate lead list query options.
 *
 * Accepted:
 * - limit: 1 to 100
 * - beforeId: unsigned positive BIGINT
 *
 * Unknown and duplicated parameters fail.
 */
function parseListOptions(
  query: Record<string, unknown>
): {
  readonly limit: number;
  readonly beforeId?: string;
} {
  for (const key of Object.keys(query)) {
    if (
      key !== "limit" &&
      key !== "beforeId"
    ) {
      throw AppError.badRequest();
    }
  }

  const rawLimit = query.limit;

  let limit = 25;

  if (rawLimit !== undefined) {
    if (
      typeof rawLimit !== "string" ||
      !/^[1-9][0-9]{0,2}$/.test(rawLimit)
    ) {
      throw AppError.badRequest();
    }

    limit = Number(rawLimit);

    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw AppError.badRequest();
    }
  }

  const rawBeforeId = query.beforeId;

  if (
    rawBeforeId !== undefined &&
    !isValidId(rawBeforeId)
  ) {
    throw AppError.badRequest();
  }

  if (rawBeforeId === undefined) {
    return { limit };
  }

  return {
    limit,
    beforeId: rawBeforeId as string,
  };
}

/**
 * Convert an authorized database-backed lead
 * to an explicit public API response shape.
 *
 * No additional database columns, internal
 * metadata or authentication details are sent.
 */
function toLeadDto(lead: LeadRecord) {
  function formatDate(
    value: Date | string | null
  ): string | null {
    if (value === null) {
      return null;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    return value;
  }

  return {
    id: lead.id,
    contactId: lead.contactId,
    accountId: lead.accountId,
    title: lead.title,
    sourceKey: lead.sourceKey,
    status: lead.status,
    priority: lead.priority,
    createdByUserId: lead.createdByUserId,
    ownerUserId: lead.ownerUserId,
    assignedAt: formatDate(lead.assignedAt),
    nextFollowupAt: formatDate(
      lead.nextFollowupAt
    ),
    description: lead.description,
    createdAt: formatDate(lead.createdAt),
    updatedAt: formatDate(lead.updatedAt),
  };
}

/**
 * Create HTTP controllers.
 *
 * The manager scope defaults to the trusted
 * MariaDB-backed resolver.
 *
 * A mock resolver may be injected for isolated
 * testing. Controllers must be mounted inside
 * the authenticated CRM API boundary.
 */
export function createLeadsController(
  dependencies: LeadsControllerDependencies = {}
): LeadsController {
  const managerScopeResolver =
    dependencies.managerScopeResolver ??
    createManagerLeadScopeResolver();

  const serviceDependencies: LeadServiceOptions = {
    managerScopeResolver,
    ...(dependencies.connection
      ? { connection: dependencies.connection }
      : {}),
  };

  const list: RequestHandler = async (
    req,
    res,
    next
  ) => {
    try {
      const options = parseListOptions(
        req.query
      );

      const page = await listLeadsForViewer(
        res,
        options,
        serviceDependencies
      );

      res.status(200).json({
        success: true,
        data: page.items.map(toLeadDto),
        pagination: {
          limit: options.limit,
          nextCursor: page.nextCursor,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  const getById: RequestHandler = async (
    req,
    res,
    next
  ) => {
    try {
      const leadId = req.params.id;

      if (!isValidId(leadId)) {
        throw AppError.badRequest();
      }

      const lead = await getLeadForViewer(
        res,
        leadId,
        serviceDependencies
      );

      if (!lead) {
        res.status(404).json({
          error: {
            code: "NOT_FOUND",
            message: "Lead not found",
          },
        });

        return;
      }

      res.status(200).json({
        success: true,
        data: toLeadDto(lead),
      });
    } catch (error) {
      next(error);
    }
  };

  return Object.freeze({
    list,
    getById,
  });
}
