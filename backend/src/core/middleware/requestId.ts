import { randomUUID } from "node:crypto";

import type {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";

/**
 * Assign a trusted, server-generated request identifier.
 *
 * Client-provided X-Request-ID values are never trusted.
 * This ID is used for logs and request correlation,
 * not authentication, authorization, or idempotency.
 */
export const requestId: RequestHandler = (
  _req: Request,
  res: Response,
  next: NextFunction
): void => {
  const id = randomUUID();

  res.locals.requestId = id;

  res.setHeader("X-Request-ID", id);

  next();
};
