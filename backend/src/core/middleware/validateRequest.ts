import type {
  RequestHandler,
  Response,
} from "express";

import { z } from "zod";

import { AppError } from "../errors/AppError";

export type ValidationSource =
  | "body"
  | "params"
  | "query";

export type RequestValidationSchemas = Partial<
  Record<ValidationSource, z.ZodType>
>;

type ValidatedRequest = Partial<
  Record<ValidationSource, unknown>
>;

const sources: readonly ValidationSource[] = [
  "params",
  "query",
  "body",
];

/**
 * Validate incoming HTTP request data using Zod.
 *
 * Validated and transformed values are stored in
 * res.locals.validatedRequest.
 *
 * Express 5 request.query must not be overwritten.
 *
 * Use z.strictObject() for mutation schemas to reject
 * unexpected fields such as companyId and role.
 */
export function validateRequest(
  schemas: RequestValidationSchemas
): RequestHandler {
  if (!sources.some((source) => schemas[source])) {
    throw new Error(
      "At least one request validation schema is required"
    );
  }

  return async (req, res, next): Promise<void> => {
    try {
      const validated: ValidatedRequest = {};

      for (const source of sources) {
        const schema = schemas[source];

        if (!schema) {
          continue;
        }

        const result = await schema.safeParseAsync(
          req[source]
        );

        if (!result.success) {
          throw AppError.validation();
        }

        validated[source] = result.data;
      }

      // Store only successfully validated values.
      res.locals.validatedRequest = validated;

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Retrieve previously validated request data.
 *
 * Controllers call this after validateRequest().
 * T must match the corresponding Zod schema output.
 */
export function getValidatedRequest<T>(
  res: Response,
  source: ValidationSource
): T {
  const validated = res.locals.validatedRequest as
    | ValidatedRequest
    | undefined;

  if (
    !validated ||
    !Object.prototype.hasOwnProperty.call(
      validated,
      source
    )
  ) {
    throw AppError.internal();
  }

  return validated[source] as T;
}
