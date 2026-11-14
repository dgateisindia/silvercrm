import type {
  RequestHandler,
  Response,
} from "express";

import { AppError } from "../errors/AppError";

/**
 * Verified CUSTOMER-realm session identity.
 *
 * This is not a CRM membership or role.
 * CRM company, role and entitlement are
 * resolved separately after authentication.
 */
export interface VerifiedCustomerSession {
  readonly platformUserId: string;
  readonly platformSessionId?: string | null;
}

/**
 * Trusted session verification adapter.
 *
 * Production:
 * Must verify the session using the approved
 * D-GATE customer Platform / Clerk contract.
 *
 * Development:
 * May use a separate test-only adapter.
 *
 * Never accept arbitrary browser-supplied
 * user identities as verification.
 */
export type CustomerSessionVerifier = (
  token: string
) => Promise<VerifiedCustomerSession | null>;

const issuedSessions =
  new WeakSet<VerifiedCustomerSession>();

function isValidIdentifier(
  value: unknown
): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9._:-]{1,160}$/.test(value)
  );
}

/**
 * Extract one Bearer token from Authorization.
 *
 * Never read identity from X-User-ID,
 * X-Company-ID, X-CRM-Role or request body.
 */
function extractBearerToken(
  authorization: unknown
): string {
  if (typeof authorization !== "string") {
    throw AppError.unauthenticated();
  }

  const match =
    /^Bearer ([A-Za-z0-9._~+/-]{8,4096}={0,2})$/i.exec(
      authorization
    );

  if (!match?.[1]) {
    throw AppError.unauthenticated();
  }

  return match[1];
}

/**
 * Express customer session middleware.
 *
 * The verifier MUST be a trusted server-side
 * implementation.
 *
 * This layer verifies only the authenticated
 * customer principal.
 *
 * It does not grant any CRM permissions.
 */
export function createVerifyPlatformSession(
  verifier: CustomerSessionVerifier
): RequestHandler {
  if (typeof verifier !== "function") {
    throw new Error(
      "A trusted session verifier is required"
    );
  }

  return (req, res, next): void => {
    void (async () => {
      if (
        res.locals.verifiedPlatformSession !== undefined
      ) {
        throw AppError.forbidden();
      }

      const token = extractBearerToken(
        req.headers.authorization
      );

      let verified: VerifiedCustomerSession | null;

      try {
        verified = await verifier(token);
      } catch {
        // Never expose Platform provider errors,
        // tokens or private verification details.
        throw AppError.serviceUnavailable();
      }

      if (
        !verified ||
        !isValidIdentifier(verified.platformUserId)
      ) {
        throw AppError.unauthenticated();
      }

      if (
        verified.platformSessionId != null &&
        !isValidIdentifier(
          verified.platformSessionId
        )
      ) {
        throw AppError.unauthenticated();
      }

      // Copy only explicitly approved identity fields.
      // Ignore provider extras such as role/company.
      const session: VerifiedCustomerSession =
        Object.freeze({
          platformUserId:
            verified.platformUserId,

          platformSessionId:
            verified.platformSessionId ?? null,
        });

      issuedSessions.add(session);

      res.locals.verifiedPlatformSession = session;
    })().then(
      () => next(),
      (error: unknown) => next(error)
    );
  };
}

/**
 * Read a verified session established by
 * createVerifyPlatformSession().
 *
 * Reject arbitrary objects inserted into locals.
 */
export function getVerifiedPlatformSession(
  res: Response
): VerifiedCustomerSession {
  const session: unknown =
    res.locals.verifiedPlatformSession;

  if (
    !session ||
    typeof session !== "object" ||
    !issuedSessions.has(
      session as VerifiedCustomerSession
    )
  ) {
    throw AppError.unauthenticated();
  }

  return session as VerifiedCustomerSession;
}
