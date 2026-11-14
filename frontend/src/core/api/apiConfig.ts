/**
 * D-GATE Silver CRM frontend API configuration.
 *
 * API addresses and authentication modes are public
 * browser configuration, never credentials.
 *
 * Required when enabling API integration:
 * VITE_CRM_API_BASE_URL
 * VITE_CRM_AUTH_MODE
 *
 * Both omitted: API integration remains unconfigured.
 * Exactly one provided: configuration error.
 *
 * Never place tokens, passwords, or secrets in VITE_
 * environment variables. Vite exposes these to browsers.
 */

export type CrmApiAuthMode = 'bearer' | 'cookie'

export type CrmApiConfiguration =
  | {
      readonly status: 'unconfigured'
    }
  | {
      readonly status: 'configured'
      readonly baseUrl: string
      readonly authMode: CrmApiAuthMode
    }

export class CrmApiConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CrmApiConfigurationError'
  }
}

function readOptionalText(
  environment: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  const value = environment[name]

  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return undefined
  }

  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value !== value.trim()
  ) {
    throw new CrmApiConfigurationError(
      `Invalid CRM API configuration: ${name}.`,
    )
  }

  return value
}

function normalizeApiBaseUrl(value: string): string {
  let url: URL

  try {
    url = new URL(value)
  } catch {
    throw new CrmApiConfigurationError(
      'CRM API base URL is invalid.',
    )
  }

  const localHosts: readonly string[] = [
    'localhost',
    '127.0.0.1',
    '[::1]',
  ]

  const isLocalHttp =
    url.protocol === 'http:' &&
    localHosts.includes(url.hostname)

  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new CrmApiConfigurationError(
      'CRM API requires HTTPS outside localhost.',
    )
  }

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new CrmApiConfigurationError(
      'CRM API base URL cannot include credentials, query, or fragment.',
    )
  }

  if (!url.pathname.endsWith('/')) {
    url.pathname += '/'
  }

  return url.toString()
}

/**
 * Pure configuration parser.
 *
 * Does not read files, access the network,
 * retrieve tokens, or connect to the backend.
 */
export function parseCrmApiConfiguration(
  environment: Readonly<Record<string, unknown>>,
): CrmApiConfiguration {
  if (
    !environment ||
    typeof environment !== 'object'
  ) {
    throw new CrmApiConfigurationError(
      'CRM API environment is invalid.',
    )
  }

  const baseUrl = readOptionalText(
    environment,
    'VITE_CRM_API_BASE_URL',
  )

  const authMode = readOptionalText(
    environment,
    'VITE_CRM_AUTH_MODE',
  )

  if (!baseUrl && !authMode) {
    return {
      status: 'unconfigured',
    }
  }

  if (!baseUrl || !authMode) {
    throw new CrmApiConfigurationError(
      'Both CRM API base URL and authentication mode must be configured.',
    )
  }

  if (
    authMode !== 'bearer' &&
    authMode !== 'cookie'
  ) {
    throw new CrmApiConfigurationError(
      'CRM API authentication mode must be bearer or cookie.',
    )
  }

  return {
    status: 'configured',
    baseUrl: normalizeApiBaseUrl(baseUrl),
    authMode,
  }
}

/**
 * Vite browser configuration adapter.
 *
 * This function intentionally does not create an API
 * client or make network requests.
 */
export function getCrmApiConfiguration(): CrmApiConfiguration {
  return parseCrmApiConfiguration({
    VITE_CRM_API_BASE_URL:
      import.meta.env.VITE_CRM_API_BASE_URL,
    VITE_CRM_AUTH_MODE:
      import.meta.env.VITE_CRM_AUTH_MODE,
  })
}