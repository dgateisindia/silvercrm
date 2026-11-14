/**
 * D-GATE Silver CRM — frontend API client factory.
 *
 * This module connects existing API configuration
 * with the shared HTTP client.
 *
 * It does not create sessions, retrieve credentials,
 * make requests or modify backend data.
 */

import {
  ApiClientError,
  createApiClient,
  type ApiClient,
} from './apiClient'

import {
  getCrmApiConfiguration,
  type CrmApiConfiguration,
} from './apiConfig'

export type CrmTokenProvider = (
) => string | null | Promise<string | null>

export type CrmApiClientFactoryOptions = {
  readonly configuration: CrmApiConfiguration
  readonly getToken?: CrmTokenProvider
  readonly fetchImpl?: typeof fetch
}

export type BrowserCrmApiClientOptions = {
  readonly getToken?: CrmTokenProvider
  readonly fetchImpl?: typeof fetch
}

/**
 * Creates a CRM API client from an explicit configuration.
 *
 * Returns null when integration is not configured.
 * No fallback credentials or endpoints are supplied.
 */
export function createCrmApiClient(
  options: CrmApiClientFactoryOptions,
): ApiClient | null {
  if (
    !options ||
    typeof options !== 'object'
  ) {
    throw new ApiClientError(
      'configuration',
      'CRM API factory options are required.',
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

  if (configuration.authMode === 'bearer') {
    if (typeof options.getToken !== 'function') {
      throw new ApiClientError(
        'configuration',
        'Bearer mode requires a token provider.',
      )
    }

    return createApiClient({
      baseUrl: configuration.baseUrl,
      auth: {
        mode: 'bearer',
        getToken: options.getToken,
      },
      fetchImpl: options.fetchImpl,
    })
  }

  if (configuration.authMode === 'cookie') {
    if (options.getToken !== undefined) {
      throw new ApiClientError(
        'configuration',
        'Cookie mode must not receive a bearer token provider.',
      )
    }

    return createApiClient({
      baseUrl: configuration.baseUrl,
      auth: {
        mode: 'cookie',
      },
      fetchImpl: options.fetchImpl,
    })
  }

  throw new ApiClientError(
    'configuration',
    'Unsupported CRM API authentication mode.',
  )
}

/**
 * Browser adapter for Vite configuration.
 *
 * Safe to call without configuration: returns null.
 * No request is made until the caller invokes
 * client.request(...) with an approved API path.
 */
export function createBrowserCrmApiClient(
  options: BrowserCrmApiClientOptions = {},
): ApiClient | null {
  return createCrmApiClient({
    configuration: getCrmApiConfiguration(),
    getToken: options.getToken,
    fetchImpl: options.fetchImpl,
  })
}