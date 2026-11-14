/**
 * D-GATE Silver CRM shared frontend API client.
 *
 * No hardcoded backend endpoints, authentication
 * credentials, customer records or live API calls.
 */

export type ApiAuth =
  | {
      mode: 'bearer'
      getToken: () => string | null | Promise<string | null>
    }
  | {
      mode: 'cookie'
    }

export type ApiMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'

export type ApiClientOptions = {
  baseUrl: string
  auth: ApiAuth
  fetchImpl?: typeof fetch
}

export type ApiRequestOptions = {
  path: string
  method?: ApiMethod
  body?: unknown
  signal?: AbortSignal
  headers?: Readonly<Record<string, string>>
}

export type ApiErrorKind =
  | 'configuration'
  | 'authentication'
  | 'authorization'
  | 'network'
  | 'http'
  | 'response'
  | 'aborted'

export class ApiClientError extends Error {
  readonly kind: ApiErrorKind
  readonly status?: number

  constructor(
    kind: ApiErrorKind,
    message: string,
    status?: number,
  ) {
    super(message)
    this.name = 'ApiClientError'
    this.kind = kind
    this.status = status
  }
}

export type ApiClient = {
  request<T = unknown>(
    options: ApiRequestOptions,
  ): Promise<T | null>
}

function normalizeBaseUrl(value: string): URL {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim()
  ) {
    throw new ApiClientError(
      'configuration',
      'A valid API base URL is required.',
    )
  }

  let url: URL

  try {
    url = new URL(value)
  } catch {
    throw new ApiClientError(
      'configuration',
      'Invalid API base URL.',
    )
  }

  const localHosts = [
    'localhost',
    '127.0.0.1',
    '[::1]',
  ]

  const localHttp =
    url.protocol === 'http:' &&
    localHosts.includes(url.hostname)

  if (url.protocol !== 'https:' && !localHttp) {
    throw new ApiClientError(
      'configuration',
      'HTTPS is required outside localhost.',
    )
  }

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ApiClientError(
      'configuration',
      'API base URL must not contain credentials, query or fragment.',
    )
  }

  if (!url.pathname.endsWith('/')) {
    url.pathname += '/'
  }

  return url
}

function resolvePath(
  baseUrl: URL,
  path: string,
): string {
  if (
    typeof path !== 'string' ||
    !path.trim() ||
    path !== path.trim() ||
    path.includes('\\') ||
    path.includes('#') ||
    path.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/i.test(path)
  ) {
    throw new ApiClientError(
      'configuration',
      'A valid relative API path is required.',
    )
  }

  let url: URL

  try {
    url = new URL(
      path.replace(/^\/+/, ''),
      baseUrl,
    )
  } catch {
    throw new ApiClientError(
      'configuration',
      'Invalid API request path.',
    )
  }

  if (
    url.origin !== baseUrl.origin ||
    !url.pathname.startsWith(baseUrl.pathname)
  ) {
    throw new ApiClientError(
      'configuration',
      'Request path is outside the configured API base.',
    )
  }

  return url.toString()
}

function isJsonResponse(
  response: Response,
): boolean {
  const contentType =
    response.headers.get('content-type') ?? ''

  const mime = contentType
    .split(';')[0]
    .trim()
    .toLowerCase()

  return (
    mime === 'application/json' ||
    (
      mime.startsWith('application/') &&
      mime.endsWith('+json')
    )
  )
}

function createHeaders(
  request: ApiRequestOptions,
): Headers {
  const headers = new Headers()

  for (const [name, value] of Object.entries(
    request.headers ?? {},
  )) {
    if (
      /^(authorization|cookie|host|accept|content-type)$/i.test(
        name,
      )
    ) {
      throw new ApiClientError(
        'configuration',
        'Reserved HTTP headers cannot be overridden.',
      )
    }

    try {
      headers.set(name, value)
    } catch {
      throw new ApiClientError(
        'configuration',
        'Invalid custom HTTP header.',
      )
    }
  }

  headers.set('Accept', 'application/json')

  return headers
}

export function createApiClient(
  options: ApiClientOptions,
): ApiClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const auth = options.auth
  const fetcher = options.fetchImpl ?? fetch

  if (
    !auth ||
    (
      auth.mode !== 'bearer' &&
      auth.mode !== 'cookie'
    )
  ) {
    throw new ApiClientError(
      'configuration',
      'Authentication configuration is required.',
    )
  }

  if (
    auth.mode === 'bearer' &&
    typeof auth.getToken !== 'function'
  ) {
    throw new ApiClientError(
      'configuration',
      'Bearer authentication requires a token provider.',
    )
  }

  if (typeof fetcher !== 'function') {
    throw new ApiClientError(
      'configuration',
      'A valid fetch implementation is required.',
    )
  }

  return {
    async request<T = unknown>(
      request: ApiRequestOptions,
    ): Promise<T | null> {
      const method = request.method ?? 'GET'

      const allowedMethods: readonly string[] = [
        'GET',
        'POST',
        'PUT',
        'PATCH',
        'DELETE',
      ]

      if (!allowedMethods.includes(method)) {
        throw new ApiClientError(
          'configuration',
          'Unsupported HTTP method.',
        )
      }

      if (
        method === 'GET' &&
        request.body !== undefined
      ) {
        throw new ApiClientError(
          'configuration',
          'GET requests cannot contain a body.',
        )
      }

      if (request.signal?.aborted) {
        throw new ApiClientError(
          'aborted',
          'API request cancelled.',
        )
      }

      const url = resolvePath(
        baseUrl,
        request.path,
      )

      const headers = createHeaders(request)

      if (auth.mode === 'bearer') {
        let token: string | null

        try {
          token = await auth.getToken()
        } catch {
          throw new ApiClientError(
            'authentication',
            'Unable to retrieve an access token.',
          )
        }

        if (
          typeof token !== 'string' ||
          !token ||
          /\s/.test(token)
        ) {
          throw new ApiClientError(
            'authentication',
            'A valid access token is required.',
          )
        }

        headers.set(
          'Authorization',
          `Bearer ${token}`,
        )
      }

      let body: string | undefined

      if (request.body !== undefined) {
        try {
          body = JSON.stringify(request.body)
        } catch {
          throw new ApiClientError(
            'configuration',
            'Request body cannot be serialized.',
          )
        }

        if (body === undefined) {
          throw new ApiClientError(
            'configuration',
            'Request body must be JSON-compatible.',
          )
        }

        headers.set(
          'Content-Type',
          'application/json',
        )
      }

      if (request.signal?.aborted) {
        throw new ApiClientError(
          'aborted',
          'API request cancelled.',
        )
      }

      let response: Response

      try {
        response = await fetcher(url, {
          method,
          headers,
          body,
          signal: request.signal,
          credentials:
            auth.mode === 'cookie'
              ? 'include'
              : 'omit',
          cache: 'no-store',
          redirect: 'error',
        })
      } catch (error) {
        if (
          request.signal?.aborted ||
          (
            error instanceof Error &&
            error.name === 'AbortError'
          )
        ) {
          throw new ApiClientError(
            'aborted',
            'API request cancelled.',
          )
        }

        throw new ApiClientError(
          'network',
          'Unable to reach the CRM API.',
        )
      }

      if (!response.ok) {
        const kind: ApiErrorKind =
          response.status === 401
            ? 'authentication'
            : response.status === 403
              ? 'authorization'
              : 'http'

        throw new ApiClientError(
          kind,
          `CRM API request failed (HTTP ${response.status}).`,
          response.status,
        )
      }

      if (
        response.status === 204 ||
        response.status === 205
      ) {
        return null
      }

      if (!isJsonResponse(response)) {
        throw new ApiClientError(
          'response',
          'CRM API returned an unsupported response type.',
          response.status,
        )
      }

      try {
        return (await response.json()) as T
      } catch {
        throw new ApiClientError(
          'response',
          'CRM API returned invalid JSON.',
          response.status,
        )
      }
    },
  }
}