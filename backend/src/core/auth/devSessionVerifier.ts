import {
  createHash,
  randomBytes,
} from "node:crypto";

import { env } from "../../config/env";

import { AppError } from "../errors/AppError";

import type {
  CustomerSessionVerifier,
} from "./verifyPlatformSession";

interface StoredDevSession {
  readonly platformUserId: string;
  readonly platformSessionId: string;
  readonly expiresAt: number;
}

export interface DevSessionStore {
  readonly verifier: CustomerSessionVerifier;

  issueSession(
    platformUserId: string,
    ttlMs?: number
  ): string;

  revokeSession(token: string): boolean;

  clearSessions(): void;
}

export interface DevSessionOptions {
  readonly now?: () => number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

const LOOPBACK_HOSTS = [
  "127.0.0.1",
  "localhost",
  "::1",
];

function assertLocalMode(): void {
  if (
    env.NODE_ENV === "production" ||
    env.AUTH_MODE !== "local" ||
    !LOOPBACK_HOSTS.includes(env.HOST)
  ) {
    throw AppError.forbidden();
  }
}

function hashToken(token: string): string {
  return createHash("sha256")
    .update(token)
    .digest("hex");
}

function validPrincipal(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9._:-]{1,160}$/.test(value)
  );
}

function validToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{64}$/.test(value)
  );
}

/**
 * Development-only in-memory session provider.
 *
 * Tokens are generated using secure randomness.
 * Only SHA-256 token hashes are stored.
 *
 * Sessions:
 * - Exist only in this backend process
 * - Expire automatically when checked
 * - Can be revoked
 * - Disappear when the server restarts
 *
 * Never expose issueSession() through a
 * production or publicly accessible API.
 */
export function createDevSessionStore(
  options: DevSessionOptions = {}
): DevSessionStore {
  assertLocalMode();

  const now = options.now ?? Date.now;

  if (typeof now !== "function") {
    throw new Error("Invalid development clock");
  }

  const sessions = new Map<
    string,
    StoredDevSession
  >();

  function currentTime(): number {
    const value = now();

    if (
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new Error("Invalid development time");
    }

    return value;
  }

  return {
    issueSession(
      platformUserId: string,
      ttlMs = DEFAULT_TTL_MS
    ): string {
      assertLocalMode();

      if (!validPrincipal(platformUserId)) {
        throw new Error(
          "Invalid development user identifier"
        );
      }

      if (
        !Number.isSafeInteger(ttlMs) ||
        ttlMs < 1000 ||
        ttlMs > MAX_TTL_MS
      ) {
        throw new Error(
          "Invalid development session lifetime"
        );
      }

      const issuedAt = currentTime();
      const expiresAt = issuedAt + ttlMs;

      if (!Number.isSafeInteger(expiresAt)) {
        throw new Error("Invalid session expiration");
      }

      const token = randomBytes(32)
        .toString("hex");

      const sessionId =
        "devsess_" +
        randomBytes(16).toString("hex");

      sessions.set(hashToken(token), {
        platformUserId,
        platformSessionId: sessionId,
        expiresAt,
      });

      return token;
    },

    verifier: async (token: string) => {
      assertLocalMode();

      if (!validToken(token)) {
        return null;
      }

      const key = hashToken(token);
      const session = sessions.get(key);

      if (!session) {
        return null;
      }

      if (currentTime() >= session.expiresAt) {
        sessions.delete(key);
        return null;
      }

      return {
        platformUserId:
          session.platformUserId,

        platformSessionId:
          session.platformSessionId,
      };
    },

    revokeSession(token: string): boolean {
      assertLocalMode();

      if (!validToken(token)) {
        return false;
      }

      return sessions.delete(
        hashToken(token)
      );
    },

    clearSessions(): void {
      assertLocalMode();
      sessions.clear();
    },
  };
}
