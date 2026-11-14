import { env } from "../../config/env";

import { AppError } from "../errors/AppError";

import type {
  VerifiedCrmIdentity,
} from "../tenant/tenantContext";

import type {
  CrmIdentityResolver,
} from "./resolveCrmIdentity";

export interface DevIdentityStore {
  readonly resolver: CrmIdentityResolver;

  registerIdentity(
    platformUserId: string,
    identity: VerifiedCrmIdentity
  ): void;

  updateIdentity(
    platformUserId: string,
    identity: VerifiedCrmIdentity
  ): void;

  revokeIdentity(
    platformUserId: string
  ): boolean;

  clearIdentities(): void;
}

const LOOPBACK_HOSTS = [
  "127.0.0.1",
  "localhost",
  "::1",
];

const MAX_UNSIGNED_BIGINT =
  18446744073709551615n;

function assertDevelopmentMode(): void {
  if (
    env.NODE_ENV === "production" ||
    env.AUTH_MODE !== "local" ||
    !LOOPBACK_HOSTS.includes(env.HOST)
  ) {
    throw AppError.forbidden();
  }
}

function validPlatformUserId(
  value: unknown
): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9._:-]{1,160}$/.test(value)
  );
}

function validDatabaseId(
  value: unknown
): value is string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value)
  ) {
    return false;
  }

  return BigInt(value) <= MAX_UNSIGNED_BIGINT;
}

function validateIdentity(
  identity: VerifiedCrmIdentity
): VerifiedCrmIdentity {
  if (
    !identity ||
    typeof identity !== "object" ||
    !validDatabaseId(identity.companyId) ||
    !validDatabaseId(identity.actorUserId)
  ) {
    throw new Error(
      "Invalid development CRM identity"
    );
  }

  if (
    identity.role !== "OWNER" &&
    identity.role !== "MANAGER" &&
    identity.role !== "EMPLOYEE"
  ) {
    throw new Error(
      "Invalid development CRM role"
    );
  }

  if (
    identity.membershipStatus !== "ACTIVE" &&
    identity.membershipStatus !== "INACTIVE"
  ) {
    throw new Error(
      "Invalid development membership status"
    );
  }

  if (
    identity.accessMode !== "FULL" &&
    identity.accessMode !== "READ_ONLY" &&
    identity.accessMode !== "DENIED"
  ) {
    throw new Error(
      "Invalid development entitlement"
    );
  }

  // Store only approved fields.
  // Ignore unexpected properties.
  return Object.freeze({
    companyId: identity.companyId,
    actorUserId: identity.actorUserId,
    role: identity.role,
    membershipStatus: identity.membershipStatus,
    accessMode: identity.accessMode,
  });
}

/**
 * Development-only CRM identity registry.
 *
 * Connects locally verified customer sessions
 * to explicitly registered CRM test identities.
 *
 * - No automatic user provisioning
 * - No browser-controlled company selection
 * - No anonymous company access
 * - No real Platform or Clerk calls
 * - No database writes
 *
 * Each test principal has one selected CRM
 * company in this local adapter.
 *
 * Multi-company workspace selection requires
 * a separate verified Platform flow later.
 *
 * Never expose registry management methods
 * through public HTTP endpoints.
 */
export function createDevIdentityStore():
  DevIdentityStore {
  assertDevelopmentMode();

  const identities = new Map<
    string,
    VerifiedCrmIdentity
  >();

  function validateUserId(
    platformUserId: string
  ): void {
    if (!validPlatformUserId(platformUserId)) {
      throw new Error(
        "Invalid development platform user"
      );
    }
  }

  return {
    registerIdentity(
      platformUserId,
      identity
    ): void {
      assertDevelopmentMode();
      validateUserId(platformUserId);

      if (identities.has(platformUserId)) {
        throw new Error(
          "Development CRM identity already registered"
        );
      }

      const validated = validateIdentity(identity);

      identities.set(
        platformUserId,
        validated
      );
    },

    updateIdentity(
      platformUserId,
      identity
    ): void {
      assertDevelopmentMode();
      validateUserId(platformUserId);

      if (!identities.has(platformUserId)) {
        throw new Error(
          "Development CRM identity not registered"
        );
      }

      const validated = validateIdentity(identity);

      identities.set(
        platformUserId,
        validated
      );
    },

    revokeIdentity(
      platformUserId
    ): boolean {
      assertDevelopmentMode();
      validateUserId(platformUserId);

      return identities.delete(platformUserId);
    },

    clearIdentities(): void {
      assertDevelopmentMode();
      identities.clear();
    },

    resolver: async session => {
      assertDevelopmentMode();

      if (
        !session ||
        !validPlatformUserId(
          session.platformUserId
        ) ||
        typeof session.platformSessionId !== "string" ||
        !/^[A-Za-z0-9._:-]{1,160}$/.test(
          session.platformSessionId
        )
      ) {
        return null;
      }

      const identity = identities.get(
        session.platformUserId
      );

      if (!identity) {
        return null;
      }

      // Resolve current membership on each
      // request, rather than caching permission
      // inside the session token.
      return Object.freeze({
        companyId: identity.companyId,
        actorUserId: identity.actorUserId,
        role: identity.role,
        membershipStatus:
          identity.membershipStatus,
        accessMode: identity.accessMode,
      });
    },
  };
}
