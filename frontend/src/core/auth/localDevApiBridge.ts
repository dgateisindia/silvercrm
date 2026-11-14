/**
 * D-GATE Silver CRM — Development Authentication/API Bridge.
 *
 * Connects the existing in-memory development token session
 * to the existing CRM API client factory.
 *
 * - Development mode only.
 * - Bearer authentication only.
 * - No credential persistence.
 * - No generated or hardcoded credentials.
 * - No implicit network requests.
 * - No backend authorization bypass.
 */

import {
  ApiClientError,
  type ApiClient,
} from '../api/apiClient'

import {
  getCrmApiConfiguration,
  type CrmApiConfiguration,
} from '../api/apiConfig'

import {
  createCrmApiClient,
} from '../api/crmApiClientFactory'

import {
  createLocalDevAuthSession,
  LocalDevAuthError,
  type LocalDevAuthSession,
} from './localDevAuth'

export type LocalDevApiBridge = Readonly<{
  auth: LocalDevAuthSession
  client: ApiClient
}>

export type LocalDevApiBridgeOptions = Readonly<{
  configuration: CrmApiConfiguration
  fetchImpl?: typeof fetch
}>

function requireDevelopmentMode(): void {
  if (import.meta.env.DEV !== true) {
    throw new LocalDevAuthError(
      'Development API authentication is not available in production.',
    )
  }
}

/**
 * Creates an isolated development session and API client.
 *
 * Returns null when API integration is unconfigured.
 * Does not create a token, authenticate a user,
 * or send any network request.
 */
export function createLocalDevApiBridge(
  options: LocalDevApiBridgeOptions,
): LocalDevApiBridge | null {
  requireDevelopmentMode()

  if (!options || typeof options !== 'object') {
    throw new ApiClientError(
      'configuration',
      'Development API bridge options are required.',
    )
  }

  const configuration = options.configuration

  if (
    !configuration ||
    typeof configuration !== 'object'
  ) {
    throw new ApiClientError(
      'configuration',
      'CRM API configuration is required.',
    )
  }

  if (configuration.status === 'unconfigured') {
    return null
  }

  if (configuration.status !== 'configured') {
    throw new ApiClientError(
      'configuration',
      'Unsupported CRM API configuration status.',
    )
  }

  if (configuration.authMode !== 'bearer') {
    throw new ApiClientError(
      'configuration',
      'Development token authentication requires bearer mode.',
    )
  }

  const auth = createLocalDevAuthSession()

  const client = createCrmApiClient({
    configuration,
    getToken: auth.getToken,
    fetchImpl: options.fetchImpl,
  })

  if (client === null) {
    throw new ApiClientError(
      'configuration',
      'CRM API client could not be created.',
    )
  }

  return Object.freeze({
    auth,
    client,
  })
}

/**
 * Browser adapter using the existing Vite API configuration.
 *
 * Configuration must be enabled explicitly.
 * The caller must supply a developer-authorized token
 * through bridge.auth.setToken(...) before requests.
 *
 * The backend remains responsible for verifying the
 * token and enforcing user access permissions.
 */
export function createBrowserLocalDevApiBridge(
  fetchImpl?: typeof fetch,
): LocalDevApiBridge | null {
  requireDevelopmentMode()

  return createLocalDevApiBridge({
    configuration: getCrmApiConfiguration(),
    fetchImpl,
  })
}