import type {
  Request,
  RequestHandler,
} from "express";

import {
  AppError,
} from "../../../core/errors/AppError";

import {
  createCustomizationService,
  type CustomizationServiceDependencies,
} from "../services/customization.service";

export interface CustomizationController {
  readonly listFields: RequestHandler;
  readonly listOptions: RequestHandler;
  readonly getFormMetadata: RequestHandler;
}

/**
 * Validate company-configurable entity and
 * field names without imposing fixed choices.
 *
 * Customer-defined configuration values are
 * data, never SQL identifiers or expressions.
 */
function validateKey(
  value: unknown,
  maximumLength: number
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(value)
  ) {
    throw AppError.badRequest();
  }

  return value;
}

/**
 * Parse the original HTTP query string.
 *
 * Reject:
 * - Unknown parameters
 * - Duplicate parameters
 * - Unexpectedly large values
 *
 * This avoids ambiguous interpretations of
 * repeated or nested query parameters.
 */
function parseQuery(
  req: Request,
  allowedKeys: readonly string[]
): Map<string, string> {
  const parsed = new URL(
    req.originalUrl,
    "http://localhost"
  );

  const result = new Map<string, string>();

  for (const [key, value] of parsed.searchParams) {
    if (
      !allowedKeys.includes(key) ||
      result.has(key) ||
      value.length > 4096
    ) {
      throw AppError.badRequest();
    }

    result.set(key, value);
  }

  return result;
}

function parseIncludeInactive(
  parameters: Map<string, string>
): boolean {
  const value = parameters.get(
    "includeInactive"
  );

  if (value === undefined || value === "false") {
    return false;
  }

  if (value === "true") {
    return true;
  }

  throw AppError.badRequest();
}

function parsePicklistKeys(
  parameters: Map<string, string>
): readonly string[] {
  const raw = parameters.get("picklists");

  if (raw === undefined) {
    return [];
  }

  const keys = raw.split(",");

  if (
    keys.length < 1 ||
    keys.length > 50 ||
    new Set(keys).size !== keys.length
  ) {
    throw AppError.badRequest();
  }

  return keys.map(
    key => validateKey(key, 80)
  );
}

/**
 * Creates read-only customization API handlers.
 *
 * The service provides role authorization and
 * company isolation. This controller handles
 * HTTP validation and response formatting.
 *
 * Customization write endpoints must use
 * separate validated management workflows.
 */
export function createCustomizationController(
  dependencies: CustomizationServiceDependencies = {}
): CustomizationController {
  const service =
    createCustomizationService(dependencies);

  const listFields: RequestHandler = async (
    req,
    res,
    next
  ) => {
    try {
      const entityType = validateKey(
        req.params.entityType,
        40
      );

      parseQuery(req, []);

      const fields = await service.listFields(
        res,
        entityType
      );

      res.status(200).json({
        success: true,
        data: fields,
      });
    } catch (error) {
      next(error);
    }
  };

  const listOptions: RequestHandler = async (
    req,
    res,
    next
  ) => {
    try {
      const entityType = validateKey(
        req.params.entityType,
        40
      );

      const fieldKey = validateKey(
        req.params.fieldKey,
        80
      );

      const parameters = parseQuery(
        req,
        ["includeInactive"]
      );

      const includeInactive =
        parseIncludeInactive(parameters);

      const options = await service.listOptions(
        res,
        entityType,
        fieldKey,
        { includeInactive }
      );

      res.status(200).json({
        success: true,
        data: options,
      });
    } catch (error) {
      next(error);
    }
  };

  const getFormMetadata: RequestHandler = async (
    req,
    res,
    next
  ) => {
    try {
      const entityType = validateKey(
        req.params.entityType,
        40
      );

      const parameters = parseQuery(
        req,
        [
          "picklists",
          "includeInactive",
        ]
      );

      const picklistKeys =
        parsePicklistKeys(parameters);

      const includeInactive =
        parseIncludeInactive(parameters);

      const metadata =
        await service.getFormMetadata(
          res,
          entityType,
          picklistKeys,
          { includeInactive }
        );

      res.status(200).json({
        success: true,
        data: metadata,
      });
    } catch (error) {
      next(error);
    }
  };

  return Object.freeze({
    listFields,
    listOptions,
    getFormMetadata,
  });
}
