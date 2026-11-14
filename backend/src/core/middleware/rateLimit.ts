import type { RequestHandler } from "express";

import { rateLimit } from "express-rate-limit";

import { AppError } from "../errors/AppError";

/**
 * Creates an IP-based rate limiter.
 *
 * Uses express-rate-limit's default IP key generator,
 * which handles IPv6 subnet grouping.
 *
 * Never trust a browser-supplied user ID or company ID
 * as a rate-limit identity.
 */
export function createRateLimiter(
  windowMs: number,
  limit: number
): RequestHandler {
  if (
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1000 ||
    windowMs > 86_400_000
  ) {
    throw new Error("Invalid rate limit window");
  }

  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100_000
  ) {
    throw new Error("Invalid request limit");
  }

  return rateLimit({
    windowMs,
    limit,

    standardHeaders: "draft-8",
    legacyHeaders: false,

    ipv6Subnet: 56,

    skipSuccessfulRequests: false,
    skipFailedRequests: false,

    passOnStoreError: false,

    handler: (_req, _res, next) => {
      next(AppError.rateLimited());
    },
  });
}

/**
 * General CRM API protection.
 * 120 requests per minute per IP.
 */
export const apiRateLimiter = createRateLimiter(
  60_000,
  120
);

/**
 * Sensitive operation protection.
 * 10 requests per 15 minutes per IP.
 *
 * Mount this on specifically selected endpoints.
 */
export const sensitiveRateLimiter = createRateLimiter(
  15 * 60_000,
  10
);
