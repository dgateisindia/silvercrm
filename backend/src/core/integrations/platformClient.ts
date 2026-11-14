import { z } from "zod";

import { env } from "../../config/env";
import { AppError } from "../errors/AppError";

export interface PlatformClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly transport?: typeof fetch;
}

export interface PlatformJsonRequest<T> {
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly schema: z.ZodType<T>;
  readonly bearerToken?: string;
  readonly body?: unknown;
}

export interface PlatformClient {
  requestJson<T>(
    request: PlatformJsonRequest<T>
  ): Promise<T>;
}

const MAX_RESPONSE_BYTES = 65536;

function validateBaseUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Platform base URL");
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid Platform base URL");
  }

  const loopback = [
    "localhost",
    "127.0.0.1",
    "[::1]",
  ].includes(url.hostname);

  if (url.protocol === "http:") {
    if (
      env.NODE_ENV === "production" ||
      !loopback
    ) {
      throw new Error(
        "Platform HTTP connections require local development"
      );
    }
  }

  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }

  return url;
}

function validatePath(path: string): void {
  if (
    typeof path !== "string" ||
    !/^[a-z][a-z0-9/_-]{0,127}$/.test(path) ||
    path.includes("//")
  ) {
    throw new Error("Invalid Platform endpoint path");
  }
}

function validateBearerToken(
  token: string | undefined
): void {
  if (token === undefined) {
    return;
  }

  if (
    typeof token !== "string" ||
    !/^[A-Za-z0-9._~+/-]{8,4096}={0,2}$/.test(
      token
    )
  ) {
    throw AppError.unauthenticated();
  }
}

/**
 * Shared HTTP client for D-GATE Platform.
 *
 * This is a transport layer only.
 *
 * A successful HTTP response does NOT itself
 * prove CRM membership or authorization.
 *
 * Callers must validate the approved Platform
 * response contract and resolve CRM identity
 * through trusted server-side services.
 */
export function createPlatformClient(
  options: PlatformClientOptions
): PlatformClient {
  const baseUrl = validateBaseUrl(
    options.baseUrl
  );

  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1000 ||
    options.timeoutMs > 30000
  ) {
    throw new Error("Invalid Platform timeout");
  }

  const transport =
    options.transport ?? fetch;

  if (typeof transport !== "function") {
    throw new Error("Invalid Platform transport");
  }

  return {
    async requestJson<T>(
      request: PlatformJsonRequest<T>
    ): Promise<T> {
      validatePath(request.path);
      validateBearerToken(request.bearerToken);

      if (
        request.method !== "GET" &&
        request.method !== "POST"
      ) {
        throw new Error("Unsupported Platform HTTP method");
      }

      if (
        request.method === "GET" &&
        request.body !== undefined
      ) {
        throw new Error(
          "GET requests cannot contain a body"
        );
      }

      const endpoint = new URL(
        request.path,
        baseUrl
      );

      // Prevent requests from escaping the
      // configured Platform API boundary.
      if (
        endpoint.origin !== baseUrl.origin ||
        !endpoint.pathname.startsWith(
          baseUrl.pathname
        )
      ) {
        throw new Error(
          "Platform endpoint is outside the approved API boundary"
        );
      }

      const headers: Record<string, string> = {
        Accept: "application/json",
      };

      if (request.bearerToken !== undefined) {
        headers.Authorization =
          `Bearer ${request.bearerToken}`;
      }

      let serializedBody: string | undefined;

      if (request.body !== undefined) {
        try {
          serializedBody = JSON.stringify(
            request.body
          );

          if (
            typeof serializedBody !== "string"
          ) {
            throw new Error("Invalid JSON");
          }
        } catch {
          throw AppError.badRequest(
            "Invalid Platform request payload"
          );
        }

        headers["Content-Type"] =
          "application/json";
      }

      let response: Response;

      try {
        response = await transport(
          endpoint.toString(),
          {
            method: request.method,
            headers,
            body: serializedBody,

            redirect: "error",
            cache: "no-store",
            credentials: "omit",

            signal: AbortSignal.timeout(
              options.timeoutMs
            ),
          }
        );
      } catch {
        // Never expose token, provider URL,
        // networking details or private errors.
        throw AppError.serviceUnavailable();
      }

      if (response.status === 401) {
        throw AppError.unauthenticated();
      }

      if (response.status === 403) {
        throw AppError.forbidden();
      }

      if (response.status === 429) {
        throw AppError.rateLimited();
      }

      if (!response.ok) {
        throw AppError.serviceUnavailable();
      }

      const contentType =
        response.headers.get("content-type") ?? "";

      if (
        !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i
          .test(contentType)
      ) {
        throw AppError.serviceUnavailable();
      }

      const contentLength = Number(
        response.headers.get("content-length") ?? 0
      );

      if (
        contentLength > MAX_RESPONSE_BYTES
      ) {
        throw AppError.serviceUnavailable();
      }

      let payload: unknown;

      try {
        const raw = await response.text();

        if (
          Buffer.byteLength(raw, "utf8") >
          MAX_RESPONSE_BYTES
        ) {
          throw new Error("Oversized response");
        }

        payload = JSON.parse(raw);
      } catch {
        throw AppError.serviceUnavailable();
      }

      const parsed = request.schema.safeParse(
        payload
      );

      if (!parsed.success) {
        throw AppError.serviceUnavailable();
      }

      return parsed.data;
    },
  };
}

/**
 * Construct the client using validated
 * backend environment configuration.
 *
 * No Platform call is made during creation.
 */
export function createConfiguredPlatformClient():
  PlatformClient {
  if (!env.PLATFORM_API_BASE_URL) {
    throw AppError.serviceUnavailable();
  }

  return createPlatformClient({
    baseUrl: env.PLATFORM_API_BASE_URL,
    timeoutMs: env.PLATFORM_TIMEOUT_MS,
  });
}
