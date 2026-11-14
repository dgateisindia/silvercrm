/**
 * D-GATE Silver CRM Leads Read API.
 *
 * Contract source: Ashwin's supplied backend ZIP.
 *
 * GET /api/v1/crm/leads
 * GET /api/v1/crm/leads/:id
 *
 * Uses the existing shared authenticated API client.
 *
 * Read-only. No automatic network requests.
 * No hardcoded server URLs or credentials.
 */

import {
  ApiClientError,
  type ApiClient,
} from '../../core/api/apiClient'

const MAX_ID = 18446744073709551615n
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

export interface LeadApiRecord {
  readonly id: string
  readonly contactId: string | null
  readonly accountId: string | null
  readonly title: string
  readonly sourceKey: string | null
  readonly status: string
  readonly priority: string
  readonly createdByUserId: string
  readonly ownerUserId: string
  readonly assignedAt: string | null
  readonly nextFollowupAt: string | null
  readonly description: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface LeadsListOptions {
  readonly limit?: number
  readonly beforeId?: string
  readonly signal?: AbortSignal
}

export interface LeadsListResult {
  readonly items: readonly LeadApiRecord[]
  readonly pagination: Readonly<{
    limit: number
    nextCursor: string | null
  }>
}

export interface LeadsReadApi {
  readonly list: (
    options?: LeadsListOptions
  ) => Promise<LeadsListResult>

  readonly getById: (
    leadId: string,
    signal?: AbortSignal
  ) => Promise<LeadApiRecord>
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  )
}

function isValidId(
  value: unknown,
): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,19}$/.test(value) &&
    BigInt(value) <= MAX_ID
  )
}

function invalidConfiguration(
  message: string,
): never {
  throw new ApiClientError(
    'configuration',
    message,
  )
}

function invalidResponse(): never {
  throw new ApiClientError(
    'response',
    'Invalid CRM Leads API response.',
  )
}

function requireRequestId(
  value: unknown,
): string {
  if (!isValidId(value)) {
    return invalidConfiguration(
      'A valid positive CRM record ID is required.',
    )
  }

  return value
}

function requireResponseId(
  value: unknown,
): string {
  if (!isValidId(value)) {
    return invalidResponse()
  }

  return value
}

function optionalResponseId(
  value: unknown,
): string | null {
  if (value === null) {
    return null
  }

  return requireResponseId(value)
}

function requireText(
  value: unknown,
): string {
  if (typeof value !== 'string') {
    return invalidResponse()
  }

  return value
}

function optionalText(
  value: unknown,
): string | null {
  if (value === null) {
    return null
  }

  return requireText(value)
}

/**
 * Preserve backend BIGINT IDs as strings.
 * Never convert identifiers to JS numbers.
 */
function parseLead(
  value: unknown,
): LeadApiRecord {
  if (!isRecord(value)) {
    return invalidResponse()
  }

  return Object.freeze({
    id: requireResponseId(value.id),

    contactId: optionalResponseId(
      value.contactId,
    ),

    accountId: optionalResponseId(
      value.accountId,
    ),

    title: requireText(value.title),

    sourceKey: optionalText(
      value.sourceKey,
    ),

    status: requireText(value.status),

    priority: requireText(value.priority),

    createdByUserId: requireResponseId(
      value.createdByUserId,
    ),

    ownerUserId: requireResponseId(
      value.ownerUserId,
    ),

    assignedAt: optionalText(
      value.assignedAt,
    ),

    nextFollowupAt: optionalText(
      value.nextFollowupAt,
    ),

    description: optionalText(
      value.description,
    ),

    createdAt: requireText(
      value.createdAt,
    ),

    updatedAt: requireText(
      value.updatedAt,
    ),
  })
}

function normalizeLimit(
  limit: number | undefined,
): number {
  const selected = limit ?? DEFAULT_LIMIT

  if (
    !Number.isSafeInteger(selected) ||
    selected < 1 ||
    selected > MAX_LIMIT
  ) {
    return invalidConfiguration(
      'CRM Leads limit must be an integer from 1 to 100.',
    )
  }

  return selected
}

/**
 * Validate the backend's list response.
 *
 * The cursor may refer to a scanned record
 * that is not visible in the current page.
 *
 * Do not derive pagination from visible rows.
 */
function parseListResponse(
  value: unknown,
  expectedLimit: number,
): LeadsListResult {
  if (
    !isRecord(value) ||
    value.success !== true ||
    !Array.isArray(value.data) ||
    !isRecord(value.pagination)
  ) {
    return invalidResponse()
  }

  const pagination = value.pagination

  if (pagination.limit !== expectedLimit) {
    return invalidResponse()
  }

  /*
   * TS2322 FIX:
   *
   * Explicitly validate the unknown value
   * before constructing the typed response.
   *
   * This ensures nextCursor is string | null,
   * never unknown.
   */
  const nextCursor: string | null =
    pagination.nextCursor === null
      ? null
      : requireResponseId(
          pagination.nextCursor,
        )

  const items: LeadApiRecord[] =
    value.data.map(parseLead)

  if (items.length > expectedLimit) {
    return invalidResponse()
  }

  return Object.freeze({
    items: Object.freeze(items),

    pagination: Object.freeze({
      limit: expectedLimit,
      nextCursor,
    }),
  })
}

function parseDetailResponse(
  value: unknown,
  requestedId: string,
): LeadApiRecord {
  if (
    !isRecord(value) ||
    value.success !== true
  ) {
    return invalidResponse()
  }

  const lead = parseLead(value.data)

  if (lead.id !== requestedId) {
    return invalidResponse()
  }

  return lead
}

/**
 * Read-only Leads API adapter.
 *
 * The authenticated backend is responsible
 * for company, role and record permissions.
 */
export function createLeadsReadApi(
  client: ApiClient,
): LeadsReadApi {
  if (
    !client ||
    typeof client.request !== 'function'
  ) {
    return invalidConfiguration(
      'An authenticated CRM API client is required.',
    )
  }

  return Object.freeze({
    async list(
      options: LeadsListOptions = {},
    ): Promise<LeadsListResult> {
      if (
        !options ||
        typeof options !== 'object'
      ) {
        return invalidConfiguration(
          'Invalid CRM Leads list options.',
        )
      }

      const limit = normalizeLimit(
        options.limit,
      )

      const query = new URLSearchParams({
        limit: String(limit),
      })

      if (options.beforeId !== undefined) {
        query.set(
          'beforeId',
          requireRequestId(
            options.beforeId,
          ),
        )
      }

      const response =
        await client.request<unknown>({
          path: `leads?${query.toString()}`,
          method: 'GET',
          signal: options.signal,
        })

      return parseListResponse(
        response,
        limit,
      )
    },

    async getById(
      leadId: string,
      signal?: AbortSignal,
    ): Promise<LeadApiRecord> {
      const id = requireRequestId(leadId)

      const response =
        await client.request<unknown>({
          path: `leads/${id}`,
          method: 'GET',
          signal,
        })

      return parseDetailResponse(
        response,
        id,
      )
    },
  })
}