import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  Response,
} from "express";

import { ZodError } from "zod";

import { AppError } from "./AppError";
import { logger } from "../../config/logger";

function isMalformedJson(error: unknown): boolean {
  if (!(error instanceof SyntaxError)) {
    return false;
  }

  return (
    (error as SyntaxError & { type?: unknown }).type ===
    "entity.parse.failed"
  );
}

function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof ZodError) {
    return AppError.validation();
  }

  if (isMalformedJson(error)) {
    return AppError.badRequest(
      "Malformed JSON request body"
    );
  }

  return AppError.internal();
}

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Express must handle errors after response headers are sent.
  if (res.headersSent) {
    next(error);
    return;
  }

  const appError = normalizeError(error);

  // Request IDs must be assigned by trusted backend middleware.
  const requestId: unknown = res.locals.requestId;

  // Log route templates, not user-supplied URLs or query strings.
  const route: unknown = req.route?.path;

  const context = {
    requestId:
      typeof requestId === "string"
        ? requestId
        : undefined,

    httpMethod: req.method,

    route:
      typeof route === "string"
        ? route
        : undefined,

    statusCode: appError.statusCode,

    errorCode: appError.code,
  };

  if (appError.statusCode >= 500) {
    logger.error("http.request_failed", context);
  } else {
    logger.warn("http.request_rejected", context);
    // DGATE_LOCAL_403_TYPED_TRACE_BEGIN
    // Local development only. Never log error.message, raw error.stack, SQL or tokens.
    if (
      appError.statusCode === 403 &&
      process.env.NODE_ENV === "development" &&
      process.env.AUTH_MODE === "local"
    ) {
      const local403Locations =
        error instanceof Error && typeof error.stack === "string"
          ? Array.from(
              error.stack.matchAll(/src[\\/][A-Za-z0-9_.\\/-]+\.tsx?:\d+:\d+/g),
              (match) => match[0]
            )
          : [];
      const local403Origin = local403Locations.find(
        (location) =>
          !/[\\/]core[\\/]errors[\\/](?:AppError|errorHandler)\.ts:/.test(location)
      );
      const local403Site =
        local403Origin?.replace(/[\\/]/g, ".").slice(0, 140) ?? "unavailable";
      logger.warn("http.request_rejected.local403.origin." + local403Site, context);
    }
    // DGATE_LOCAL_403_TYPED_TRACE_END
  }

  res
    .status(appError.statusCode)
    .json(appError.toJSON());
};
