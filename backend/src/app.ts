import express, {
  type Express,
  type Router,
  type RequestHandler,
} from "express";

import {
  createVerifyPlatformSession,
  type CustomerSessionVerifier,
} from "./core/auth/verifyPlatformSession";

import {
  createResolveCrmIdentity,
  type CrmIdentityResolver,
} from "./core/auth/resolveCrmIdentity";

import {
  getTenantContext,
} from "./core/tenant/tenantContext";

import {
  authorize,
} from "./core/permissions/authorize";

import {
  errorHandler,
} from "./core/errors/errorHandler";

export const CRM_API_PREFIX = "/api/v1/crm";

export interface CrmAppDependencies {
  // Omitted in trusted Clerk mode, mandatory for the local session path.
  readonly sessionVerifier?: CustomerSessionVerifier;
  readonly identityResolver?: CrmIdentityResolver;
  readonly authMode?: "clerk";
  readonly trustedAuthBoundary?: RequestHandler;

  /**
   * Feature routers can be mounted here.
   *
   * Every business endpoint must independently
   * enforce its feature permission and record scope.
   */
  readonly protectedRoutes?: Router;
}

/**
 * Build the D-GATE CRM Express application.
 *
 * Authentication providers must be supplied
 * by the trusted server bootstrap.
 *
 * Development and production must use their
 * respective approved providers.
 *
 * No test identity, token or company is
 * automatically provisioned by this function.
 */
export function createCrmApp(
  dependencies: CrmAppDependencies
): Express {
  if (
    !dependencies ||
    typeof dependencies !== "object"
  ) {
    throw new Error(
      "CRM application dependencies are required"
    );
  }

  // Exactly ONE authentication boundary is selected by trusted server startup.
  // Local mode keeps the original verifier + resolver; production Clerk mode
  // uses the signed JWT + live provider session + SQL tenant boundary.
  const isClerk = dependencies.authMode === "clerk";
  if (isClerk) {
    if (typeof dependencies.trustedAuthBoundary !== "function" ||
        dependencies.sessionVerifier !== undefined ||
        dependencies.identityResolver !== undefined) {
      throw new Error("CRM_CLERK_AUTH_DEPENDENCIES_INVALID");
    }
  } else if (typeof dependencies.sessionVerifier !== "function" ||
             typeof dependencies.identityResolver !== "function" ||
             dependencies.trustedAuthBoundary !== undefined) {
    throw new Error("CRM_LOCAL_AUTH_DEPENDENCIES_INVALID");
  }
  const authHandlers: RequestHandler[] = isClerk
    ? [dependencies.trustedAuthBoundary!]
    : [
        createVerifyPlatformSession(dependencies.sessionVerifier!),
        createResolveCrmIdentity(dependencies.identityResolver!),
      ];

  const app = express();

  app.disable("x-powered-by");
  app.disable("etag");

  app.use(
    express.json({
      limit: "64kb",
      strict: true,
    })
  );

  /**
   * Liveness endpoint only.
   *
   * Does not expose credentials, tenant details
   * or internal database information.
   *
   * This does not prove database readiness.
   */
  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      service: "dgate-silver-crm",
    });
  });

  /**
   * Authentication boundary for all CRM routes.
   *
   * Middleware execution order:
   *
   * 1. Disable response caching
   * 2. Verify customer session
   * 3. Resolve CRM identity and entitlement
   * 4. Apply feature-level permission middleware
   * 5. Execute feature controllers/services
   */
  app.use(
    CRM_API_PREFIX,

    (_req, res, next) => {
      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      next();
    },

    ...authHandlers
  );

  /**
   * Authenticated CRM identity endpoint.
   *
   * Exposes only approved CRM context fields.
   *
   * Platform tokens, session identifiers and
   * internal provider responses are excluded.
   */
  app.get(
    `${CRM_API_PREFIX}/me`,

    authorize("dashboard.read"),

    (_req, res) => {
      const context = getTenantContext(res);

      res.status(200).json({
        success: true,

        data: {
          companyId: context.companyId,
          actorUserId: context.actorUserId,
          role: context.role,
          accessMode: context.accessMode,
        },
      });
    }
  );

  /**
   * Future feature routers execute behind the
   * same session and tenant middleware.
   *
   * Individual routes must additionally call
   * authorize() and enforce record ownership,
   * team scope and tenant-filtered queries.
   */
  if (dependencies.protectedRoutes) {
    app.use(
      CRM_API_PREFIX,
      dependencies.protectedRoutes
    );
  }

  app.use(errorHandler);

  return app;
}
