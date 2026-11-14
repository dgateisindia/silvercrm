import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

import {
  ApiClientError,
} from '../src/core/api/apiClient.ts'

/*
 * Test the real TypeScript modules in memory.
 *
 * Vite normally resolves extensionless imports and
 * provides import.meta.env. The test harness replaces
 * those imports and environment flags in memory only.
 *
 * No project files, environment files, real tokens,
 * or backend services are modified.
 */

function readSource(relativePath) {
  return readFileSync(
    new URL(relativePath, import.meta.url),
    'utf8',
  )
}

function compile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
}

function dataUrl(source) {
  return (
    'data:text/javascript;base64,' +
    Buffer.from(source).toString('base64')
  )
}

function replaceImport(source, specifier, destination) {
  const single = `from '${specifier}'`
  const double = `from "${specifier}"`

  assert.ok(
    source.includes(single) || source.includes(double),
    `Missing expected import: ${specifier}`,
  )

  return source
    .replaceAll(single, `from '${destination}'`)
    .replaceAll(double, `from '${destination}'`)
}

const apiClientUrl = new URL(
  '../src/core/api/apiClient.ts',
  import.meta.url,
).href

const configSource = readSource(
  '../src/core/api/apiConfig.ts',
)

assert.ok(
  configSource.includes('import.meta.env'),
)

const configJavaScript = `
let __browserEnvironment = {}
export function __setBrowserEnvironment(value) {
  __browserEnvironment = value
}
${compile(
  configSource.replaceAll(
    'import.meta.env',
    '__browserEnvironment',
  ),
)}
`

const configUrl = dataUrl(configJavaScript)

const {
  __setBrowserEnvironment,
} = await import(configUrl)

let factoryJavaScript = compile(
  readSource(
    '../src/core/api/crmApiClientFactory.ts',
  ),
)

factoryJavaScript = replaceImport(
  factoryJavaScript,
  './apiClient',
  apiClientUrl,
)

factoryJavaScript = replaceImport(
  factoryJavaScript,
  './apiConfig',
  configUrl,
)

const factoryUrl = dataUrl(factoryJavaScript)

const localAuthSource = readSource(
  '../src/core/auth/localDevAuth.ts',
)

assert.ok(
  localAuthSource.includes('import.meta.env.DEV'),
)

const authJavaScript = `
let __authDevelopment = true
export function __setAuthDevelopment(value) {
  __authDevelopment = value
}
${compile(
  localAuthSource.replaceAll(
    'import.meta.env.DEV',
    '__authDevelopment',
  ),
)}
`

const authUrl = dataUrl(authJavaScript)

const {
  LocalDevAuthError,
  __setAuthDevelopment,
} = await import(authUrl)

const bridgeSource = readSource(
  '../src/core/auth/localDevApiBridge.ts',
)

assert.ok(
  bridgeSource.includes('import.meta.env.DEV'),
)

let bridgeJavaScript = compile(
  bridgeSource.replaceAll(
    'import.meta.env.DEV',
    '__bridgeDevelopment',
  ),
)

bridgeJavaScript = replaceImport(
  bridgeJavaScript,
  '../api/apiClient',
  apiClientUrl,
)

bridgeJavaScript = replaceImport(
  bridgeJavaScript,
  '../api/apiConfig',
  configUrl,
)

bridgeJavaScript = replaceImport(
  bridgeJavaScript,
  '../api/crmApiClientFactory',
  factoryUrl,
)

bridgeJavaScript = replaceImport(
  bridgeJavaScript,
  './localDevAuth',
  authUrl,
)

const bridgeUrl = dataUrl(`
let __bridgeDevelopment = true
export function __setBridgeDevelopment(value) {
  __bridgeDevelopment = value
}
${bridgeJavaScript}
`)

const {
  createLocalDevApiBridge,
  createBrowserLocalDevApiBridge,
  __setBridgeDevelopment,
} = await import(bridgeUrl)

const BASE = 'http://localhost:4300/api/'

function configured(
  authMode = 'bearer',
  baseUrl = BASE,
) {
  return {
    status: 'configured',
    authMode,
    baseUrl,
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

function mockFetch(
  responder = () => json({ ok: true }),
) {
  const calls = []

  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return responder(url, options)
  }

  return {
    calls,
    fetchImpl,
  }
}

function makeBridge(mock, configuration = configured()) {
  return createLocalDevApiBridge({
    configuration,
    fetchImpl: mock.fetchImpl,
  })
}

function expectConfigurationError(action) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof ApiClientError)
    assert.equal(error.kind, 'configuration')
    return true
  })
}

async function expectApiError(action, kind, status) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof ApiClientError)
    assert.equal(error.kind, kind)

    if (status !== undefined) {
      assert.equal(error.status, status)
    }

    return true
  })
}

test('01 - unconfigured bridge returns null', () => {
  const mock = mockFetch()

  const bridge = makeBridge(mock, {
    status: 'unconfigured',
  })

  assert.equal(bridge, null)
  assert.equal(mock.calls.length, 0)
})

test('02 - unconfigured browser adapter returns null', () => {
  const mock = mockFetch()

  __setBrowserEnvironment({})

  const bridge = createBrowserLocalDevApiBridge(
    mock.fetchImpl,
  )

  assert.equal(bridge, null)
  assert.equal(mock.calls.length, 0)
})

test('03 - undefined options are rejected', () => {
  expectConfigurationError(
    () => createLocalDevApiBridge(undefined),
  )
})

test('04 - null options are rejected', () => {
  expectConfigurationError(
    () => createLocalDevApiBridge(null),
  )
})

test('05 - missing API configuration is rejected', () => {
  expectConfigurationError(
    () => createLocalDevApiBridge({}),
  )
})

test('06 - null API configuration is rejected', () => {
  expectConfigurationError(
    () => createLocalDevApiBridge({
      configuration: null,
    }),
  )
})

test('07 - invalid configuration status is rejected', () => {
  expectConfigurationError(
    () => createLocalDevApiBridge({
      configuration: {
        status: 'unknown',
      },
    }),
  )
})

test('08 - cookie configuration is rejected', () => {
  const mock = mockFetch()

  expectConfigurationError(
    () => makeBridge(mock, configured('cookie')),
  )

  assert.equal(mock.calls.length, 0)
})

test('09 - anonymous authentication mode is rejected', () => {
  const mock = mockFetch()

  expectConfigurationError(
    () => makeBridge(mock, configured('anonymous')),
  )

  assert.equal(mock.calls.length, 0)
})

test('10 - insecure remote API base is rejected', () => {
  const mock = mockFetch()

  expectConfigurationError(
    () => makeBridge(
      mock,
      configured(
        'bearer',
        'http://api.example.com/v1/',
      ),
    ),
  )

  assert.equal(mock.calls.length, 0)
})

test('11 - configured bridge exposes frozen interface', () => {
  const mock = mockFetch()
  const bridge = makeBridge(mock)

  assert.ok(bridge)
  assert.ok(Object.isFrozen(bridge))
  assert.ok(bridge.auth)
  assert.equal(
    typeof bridge.client.request,
    'function',
  )
  assert.equal(mock.calls.length, 0)
})

test('12 - new bridge has no developer token', async () => {
  const bridge = makeBridge(mockFetch())

  assert.equal(bridge.auth.hasToken(), false)
  assert.equal(await bridge.auth.getToken(), null)
})

test('13 - request without token blocks fetch', async () => {
  const mock = mockFetch()
  const bridge = makeBridge(mock)

  await expectApiError(
    () => bridge.client.request({ path: 'leads' }),
    'authentication',
  )

  assert.equal(mock.calls.length, 0)
})

test('14 - stored token is attached to request', async () => {
  const mock = mockFetch()
  const bridge = makeBridge(mock)

  bridge.auth.setToken('test-only-token')

  const result = await bridge.client.request({
    path: 'leads',
  })

  assert.deepEqual(result, { ok: true })
  assert.equal(mock.calls.length, 1)
  assert.equal(mock.calls[0].url, `${BASE}leads`)

  assert.equal(
    mock.calls[0].options.headers.get('Authorization'),
    'Bearer test-only-token',
  )
})

test('15 - bearer requests omit browser cookies', async () => {
  const mock = mockFetch()
  const bridge = makeBridge(mock)

  bridge.auth.setToken('test-token')

  await bridge.client.request({ path: 'leads' })

  assert.equal(
    mock.calls[0].options.credentials,
    'omit',
  )
  assert.equal(
    mock.calls[0].options.cache,
    'no-store',
  )
})

test('16 - request URL includes query parameters', async () => {
  const mock = mockFetch()
  const bridge = makeBridge(mock)

  bridge.auth.setToken('test-token')

  await bridge.client.request({
    path: '/leads?page=2',
  })

  assert.equal(
    mock.calls[0].url,
    `${BASE}leads?page=2`,
  )
})

test('17 - authenticated POST sends JSON', async () => {
  const mock = mockFetch(
    () => json({ id: 'mock-1' }, 201),
  )

  const bridge = makeBridge(mock)
  bridge.auth.setToken('test-token')

  const result = await bridge.client.request({
    path: 'leads',
    method: 'POST',
    body: { title: 'Example lead' },
  })

  assert.deepEqual(result, { id: 'mock-1' })
  assert.equal(
    mock.calls[0].options.body,
    '{"title":"Example lead"}',
  )
  assert.equal(
    mock.calls[0].options.headers.get('Content-Type'),
    'application/json',
  )
})

test('18 - authenticated PATCH sends changes', async () => {
  const mock = mockFetch()
  const bridge = makeBridge(mock)

  bridge.auth.setToken('test-token')

  await bridge.client.request({
    path: 'leads/1',
    method: 'PATCH',
    body: { title: 'Updated lead' },
  })

  assert.equal(mock.calls[0].options.method, 'PATCH')
  assert.equal(
    mock.calls[0].options.body,
    '{"title":"Updated lead"}',
  )
})

test('19 - authenticated DELETE handles HTTP 204', async () => {
  const mock = mockFetch(
    () => new Response(null, { status: 204 }),
  )

  const bridge = makeBridge(mock)
  bridge.auth.setToken('test-token')

  const result = await bridge.client.request({
    path: 'leads/1',
    method: 'DELETE',
  })

  assert.equal(result, null)
})

test('20 - HTTP 401 remains authentication error', async () => {
  const mock = mockFetch(
    () => new Response(null, { status: 401 }),
  )

  const bridge = makeBridge(mock)
  bridge.auth.setToken('test-token')

  await expectApiError(
    () => bridge.client.request({ path: 'leads' }),
    'authentication',
    401,
  )
})

test('21 - HTTP 403 remains authorization error', async () => {
  const mock = mockFetch(
    () => new Response(null, { status: 403 }),
  )

  const bridge = makeBridge(mock)
  bridge.auth.setToken('test-token')

  await expectApiError(
    () => bridge.client.request({ path: 'leads' }),
    'authorization',
    403,
  )
})

test('22 - HTTP 409 is classified', async () => {
  const mock = mockFetch(
    () => new Response(null, { status: 409 }),
  )

  const bridge = makeBridge(mock)
  bridge.auth.setToken('test-token')

  await expectApiError(
    () => bridge.client.request({ path: 'leads' }),
    'http',
    409,
  )
})

test('23 - malformed JSON response is rejected', async () => {
  const mock = mockFetch(
    () => new Response('{bad', {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    }),
  )

  const bridge = makeBridge(mock)
  bridge.auth.setToken('test-token')

  await expectApiError(
    () => bridge.client.request({ path: 'leads' }),
    'response',
    200,
  )
})

test('24 - network failure is classified', async () => {
  const mock = mockFetch(async () => {
    throw new TypeError('test network failure')
  })

  const bridge = makeBridge(mock)
  bridge.auth.setToken('test-token')

  await expectApiError(
    () => bridge.client.request({ path: 'leads' }),
    'network',
  )
})

test('25 - aborted request never reaches fetch', async () => {
  const mock = mockFetch()
  const bridge = makeBridge(mock)

  bridge.auth.setToken('test-token')

  const controller = new AbortController()
  controller.abort()

  await expectApiError(
    () => bridge.client.request({
      path: 'leads',
      signal: controller.signal,
    }),
    'aborted',
  )

  assert.equal(mock.calls.length, 0)
})

test('26 - clearing token blocks later requests', async () => {
  const mock = mockFetch()
  const bridge = makeBridge(mock)

  bridge.auth.setToken('test-token')
  bridge.auth.clearToken()

  assert.equal(bridge.auth.hasToken(), false)

  await expectApiError(
    () => bridge.client.request({ path: 'leads' }),
    'authentication',
  )

  assert.equal(mock.calls.length, 0)
})

test('27 - replacing token changes authorization', async () => {
  const mock = mockFetch()
  const bridge = makeBridge(mock)

  bridge.auth.setToken('first-test-token')
  await bridge.client.request({ path: 'leads' })

  bridge.auth.setToken('second-test-token')
  await bridge.client.request({ path: 'contacts' })

  assert.equal(mock.calls.length, 2)

  assert.equal(
    mock.calls[0].options.headers.get('Authorization'),
    'Bearer first-test-token',
  )

  assert.equal(
    mock.calls[1].options.headers.get('Authorization'),
    'Bearer second-test-token',
  )
})

test('28 - bridge sessions are isolated', async () => {
  const mock = mockFetch()

  const first = makeBridge(mock)
  const second = makeBridge(mock)

  first.auth.setToken('first-test-token')

  assert.equal(first.auth.hasToken(), true)
  assert.equal(second.auth.hasToken(), false)

  await expectApiError(
    () => second.client.request({ path: 'leads' }),
    'authentication',
  )

  assert.equal(mock.calls.length, 0)

  await first.client.request({ path: 'leads' })

  assert.equal(mock.calls.length, 1)
  assert.equal(
    mock.calls[0].options.headers.get('Authorization'),
    'Bearer first-test-token',
  )
})

test('29 - production mode blocks both bridge factories', () => {
  const mock = mockFetch()

  __setBridgeDevelopment(false)

  try {
    assert.throws(
      () => makeBridge(mock),
      (error) => error instanceof LocalDevAuthError,
    )

    assert.throws(
      () => createBrowserLocalDevApiBridge(mock.fetchImpl),
      (error) => error instanceof LocalDevAuthError,
    )

    assert.equal(mock.calls.length, 0)
  } finally {
    __setBridgeDevelopment(true)
    __setAuthDevelopment(true)
  }
})

test('30 - browser adapter uses explicit development configuration', async () => {
  const mock = mockFetch()

  __setBrowserEnvironment({
    VITE_CRM_API_BASE_URL: BASE,
    VITE_CRM_AUTH_MODE: 'bearer',
  })

  try {
    const bridge = createBrowserLocalDevApiBridge(
      mock.fetchImpl,
    )

    assert.ok(bridge)
    assert.equal(mock.calls.length, 0)
    assert.equal(await bridge.auth.getToken(), null)

    bridge.auth.setToken('browser-test-token')

    await bridge.client.request({
      path: 'leads',
    })

    assert.equal(mock.calls.length, 1)
    assert.equal(
      mock.calls[0].options.headers.get('Authorization'),
      'Bearer browser-test-token',
    )
  } finally {
    __setBrowserEnvironment({})
  }
})