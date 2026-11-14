import type { TrustedPlatformSnapshot } from './platformSnapshot';

/**
 * Versioned contract for the separately owned D-GATE Platform service.
 * CRM does not assume or hard-code a Platform endpoint path.
 *
 * POST { schemaVersion: '1', platformOrgId: 'org_...' }
 * Authorization: Bearer <service credential> (server-to-server only)
 * Reply { schemaVersion: '1', snapshot: TrustedPlatformSnapshot,
 *         revokedPlatformUserIds: string[] }
 *
 * Provider must authenticate and authorize the CRM service credential and must
 * ensure the returned organization is the organization requested.
 */
export interface PlatformSyncEnvelope {
  readonly snapshot: TrustedPlatformSnapshot;
  readonly revokedPlatformUserIds: readonly string[];
}

export interface PlatformSyncTransportOptions {
  readonly endpoint: string;
  readonly expectedHost: string;
  readonly serviceToken: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const ORG_ID = /^[a-zA-Z0-9_-]{2,128}$/;
const USER_ID = /^[a-zA-Z0-9._:-]{1,128}$/;
const VERSION = /^(0|[1-9][0-9]{0,19})$/;
const ISO_MILLIS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const MAX_RESPONSE_BYTES = 32768;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PLATFORM_SYNC_INVALID_RESPONSE');
  }
  return value as Record<string, unknown>;
}

function parseEnvelope(value: unknown, requestedOrg: string): PlatformSyncEnvelope {
  const response = object(value);
  if (response.schemaVersion !== '1') throw new Error('PLATFORM_SYNC_SCHEMA_MISMATCH');
  const source = object(response.snapshot);
  const expiresAt = source.expiresAt;
  const reason = source.reason;
  if (source.platformOrgId !== requestedOrg ||
      typeof source.version !== 'string' || !VERSION.test(source.version) ||
      BigInt(source.version) > 18446744073709551615n ||
      !['FULL', 'READ_ONLY', 'DENIED'].includes(String(source.accessMode)) ||
      !['active', 'suspended', 'provisioning', 'closed'].includes(String(source.companyStatus)) ||
      (source.companyStatus === 'active' && source.accessMode === 'DENIED') ||
      (reason !== null && (typeof reason !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(reason))) ||
      (expiresAt !== null && (typeof expiresAt !== 'string' || !ISO_MILLIS.test(expiresAt) ||
        !Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt).toISOString() !== expiresAt))) {
    throw new Error('PLATFORM_SYNC_INVALID_SNAPSHOT');
  }
  const revocations = response.revokedPlatformUserIds;
  if (!Array.isArray(revocations) || revocations.length > 100 ||
      !revocations.every((id: unknown) => typeof id === 'string' && USER_ID.test(id)) ||
      new Set(revocations).size !== revocations.length) {
    throw new Error('PLATFORM_SYNC_INVALID_MEMBERSHIPS');
  }
  return Object.freeze({
    snapshot: Object.freeze({
      platformOrgId: requestedOrg,
      version: source.version,
      accessMode: source.accessMode,
      companyStatus: source.companyStatus,
      reason,
      expiresAt,
    }) as TrustedPlatformSnapshot,
    revokedPlatformUserIds: Object.freeze([...revocations]) as readonly string[],
  });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error('PLATFORM_SYNC_PROVIDER_UNAVAILABLE');
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    throw new Error('PLATFORM_SYNC_INVALID_CONTENT_TYPE');
  }
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader !== null && Number(lengthHeader) > MAX_RESPONSE_BYTES) {
    throw new Error('PLATFORM_SYNC_RESPONSE_TOO_LARGE');
  }
  if (!response.body) throw new Error('PLATFORM_SYNC_EMPTY_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('PLATFORM_SYNC_RESPONSE_TOO_LARGE');
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('PLATFORM_SYNC_INVALID_JSON');
  }
}

export function createPlatformSyncTransport(options: PlatformSyncTransportOptions) {
  let url: URL;
  try { url = new URL(options.endpoint); }
  catch { throw new Error('PLATFORM_SYNC_ENDPOINT_INVALID'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
      url.hash || url.search || url.hostname.toLowerCase() !== options.expectedHost.toLowerCase() ||
      !/^[a-zA-Z0-9.-]{4,253}$/.test(options.expectedHost)) {
    throw new Error('PLATFORM_SYNC_ENDPOINT_INVALID');
  }
  if (typeof options.serviceToken !== 'string' || options.serviceToken.length < 32 ||
      options.serviceToken.length > 2048 || /\s/.test(options.serviceToken)) {
    throw new Error('PLATFORM_SYNC_SERVICE_TOKEN_INVALID');
  }
  const timeout = options.timeoutMs ?? 7000;
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 15000) {
    throw new Error('PLATFORM_SYNC_TIMEOUT_INVALID');
  }
  const request = options.fetchImpl ?? fetch;
  return Object.freeze({
    async fetchCompanySnapshot(platformOrgId: string): Promise<PlatformSyncEnvelope> {
      if (!ORG_ID.test(platformOrgId)) throw new Error('PLATFORM_SYNC_ORG_INVALID');
      let response: Response;
      try {
        response = await request(url.toString(), {
          method: 'POST',
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(timeout),
          headers: {
            Authorization: `Bearer ${options.serviceToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-DGATE-CRM-Sync-Version': '1',
          },
          body: JSON.stringify({ schemaVersion: '1', platformOrgId }),
        });
      } catch {
        throw new Error('PLATFORM_SYNC_PROVIDER_UNAVAILABLE');
      }
      return parseEnvelope(await readBoundedJson(response), platformOrgId);
    },
  });
}

/** Explicit production worker configuration only; never read secrets on module import. */
export function createProductionPlatformSyncTransport() {
  if (process.env.NODE_ENV !== 'production' || process.env.AUTH_MODE !== 'platform') {
    throw new Error('PLATFORM_SYNC_PRODUCTION_MODE_REQUIRED');
  }
  return createPlatformSyncTransport({
    endpoint: process.env.CRM_PLATFORM_SNAPSHOT_ENDPOINT ?? '',
    expectedHost: process.env.CRM_PLATFORM_SNAPSHOT_HOST ?? '',
    serviceToken: process.env.CRM_PLATFORM_SERVICE_TOKEN ?? '',
  });
}