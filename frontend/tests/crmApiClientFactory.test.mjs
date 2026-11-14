import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

import { ApiClientError } from '../src/core/api/apiClient.ts'

/*
 * Load the actual factory source for Node-based tests.
 *
 * Vite resolves extensionless TypeScript imports, whereas
 * native Node ESM requires explicit extensions.
 *
 * This in-memory transformation changes only import
 * resolution for the test runner. No project source
 * files are modified or copied.
 */

const factoryUrl = new URL(
  '../src/core/api/crmApiClientFactory.ts',
  import.meta.url,
)

const clientUrl = new URL(
  '../src/core/api/apiClient.ts',
  import.meta.url,
)

const configUrl = new URL(
  '../src/core/api/apiConfig.ts',
  import.meta.url,
)

const factorySource = readFileSync(factoryUrl, 'utf8')

let factoryJavaScript = ts.transpileModule(
  factorySource,
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText

const clientImport = /from\s+['"]\.\/apiClient['"]/g
const configImport = /from\s+['"]\.\/apiConfig['"]/g

assert.match(factoryJavaScript, clientImport)
assert.match(factoryJavaScript, configImport)

factoryJavaScript = factoryJavaScript
  .replace(
    clientImport,
    () => `from '${clientUrl.href}'`,
  )
  .replace(
    configImport,
    () => `from '${configUrl.href}'`,
  )

const factoryModuleUrl =
  'data:text/javascript;base64,' +
  Buffer.from(factoryJavaScript).toString('base64')

const {
  createCrmApiClient,
} = await import(factoryModuleUrl)

const BASE = 'http://localhost:4300/api/'

function configuration(mode = 'cookie', baseUrl = BASE) {
  return {
    status: 'configured',
    baseUrl,
    authMode: mode,
  }
}

function responseJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

function createMockFetch(
  responder = () => responseJson({ ok: true }),
) {
  const calls = []

  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return responder(url, options)
  }

  return { calls, fetchImpl }
}

function cookieClient(mock, extra = {}) {
  return createCrmApiClient({
    configuration: configuration('cookie'),
    fetchImpl: mock.fetchImpl,
    ...extra,
  })
}

function bearerClient(
  mock,
  getToken = () => 'test-only-token',
) {
  return createCrmApiClient({
    configuration: configuration('bearer'),
    getToken,
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

async function expectErrorKind(
  action,
  kind,
  status,
) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof ApiClientError)
    assert.equal(error.kind, kind)

    if (status !== undefined) {
      assert.equal(error.status, status)
    }

    return true
  })
}

test('01 - unconfigured API returns null', () => {
  const client = createCrmApiClient({
    configuration: { status: 'unconfigured' },
  })

  assert.equal(client, null)
})

test('02 - unconfigured API does not invoke token provider', () => {
  let tokenCalls = 0

  const client = createCrmApiClient({
    configuration: { status: 'unconfigured' },
    getToken: () => {
      tokenCalls++
      return 'unused-test-token'
    },
  })

  assert.equal(client, null)
  assert.equal(tokenCalls, 0)
})

test('03 - unconfigured API never calls fetch', () => {
  const mock = createMockFetch()

  const client = createCrmApiClient({
    configuration: { status: 'unconfigured' },
    fetchImpl: mock.fetchImpl,
  })

  assert.equal(client, null)
  assert.equal(mock.calls.length, 0)
})

test('04 - missing factory options are rejected', () => {
  expectConfigurationError(
    () => createCrmApiClient(undefined),
  )
})

test('05 - null factory options are rejected', () => {
  expectConfigurationError(
    () => createCrmApiClient(null),
  )
})

test('06 - missing configuration is rejected', () => {
  expectConfigurationError(
    () => createCrmApiClient({}),
  )
})

test('07 - null configuration is rejected', () => {
  expectConfigurationError(
    () => createCrmApiClient({
      configuration: null,
    }),
  )
})

test('08 - unsupported configuration status is rejected', () => {
  expectConfigurationError(
    () => createCrmApiClient({
      configuration: {
        status: 'unknown',
      },
    }),
  )
})

test('09 - bearer mode requires a token provider', () => {
  expectConfigurationError(
    () => createCrmApiClient({
      configuration: configuration('bearer'),
      fetchImpl: createMockFetch().fetchImpl,
    }),
  )
})

test('10 - bearer mode rejects invalid token provider', () => {
  expectConfigurationError(
    () => createCrmApiClient({
      configuration: configuration('bearer'),
      getToken: 'not-a-function',
      fetchImpl: createMockFetch().fetchImpl,
    }),
  )
})

test('11 - synchronous bearer token is attached', async () => {
  const mock = createMockFetch()
  const client = bearerClient(
    mock,
    () => 'synchronous-test-token',
  )

  const result = await client.request({
    path: 'leads',
  })

  assert.deepEqual(result, { ok: true })
  assert.equal(mock.calls.length, 1)
  assert.equal(mock.calls[0].url, `${BASE}leads`)

  assert.equal(
    mock.calls[0].options.headers.get('Authorization'),
    'Bearer synchronous-test-token',
  )
})

test('12 - asynchronous bearer token is attached', async () => {
  const mock = createMockFetch()
  const client = bearerClient(
    mock,
    async () => 'asynchronous-test-token',
  )

  await client.request({ path: 'leads' })

  assert.equal(
    mock.calls[0].options.headers.get('Authorization'),
    'Bearer asynchronous-test-token',
  )
})

test('13 - bearer request omits cookies', async () => {
  const mock = createMockFetch()
  const client = bearerClient(mock)

  await client.request({ path: '/leads?page=2' })

  assert.equal(
    mock.calls[0].options.credentials,
    'omit',
  )
  assert.equal(
    mock.calls[0].url,
    `${BASE}leads?page=2`,
  )
  assert.equal(
    mock.calls[0].options.cache,
    'no-store',
  )
})

test('14 - missing bearer token blocks network', async () => {
  const mock = createMockFetch()
  const client = bearerClient(mock, () => null)

  await expectErrorKind(
    () => client.request({ path: 'leads' }),
    'authentication',
  )

  assert.equal(mock.calls.length, 0)
})

test('15 - whitespace bearer token blocks network', async () => {
  const mock = createMockFetch()
  const client = bearerClient(mock, () => 'bad token')

  await expectErrorKind(
    () => client.request({ path: 'leads' }),
    'authentication',
  )

  assert.equal(mock.calls.length, 0)
})

test('16 - failed token provider is classified safely', async () => {
  const mock = createMockFetch()

  const client = bearerClient(mock, async () => {
    throw new Error('private token provider failure')
  })

  await expectErrorKind(
    () => client.request({ path: 'leads' }),
    'authentication',
  )

  assert.equal(mock.calls.length, 0)
})

test('17 - bearer token provider runs per request', async () => {
  const mock = createMockFetch()
  let tokenCalls = 0

  const client = bearerClient(mock, () => {
    tokenCalls++
    return `test-token-${tokenCalls}`
  })

  await client.request({ path: 'leads' })
  await client.request({ path: 'contacts' })

  assert.equal(tokenCalls, 2)
  assert.equal(mock.calls.length, 2)

  assert.equal(
    mock.calls[0].options.headers.get('Authorization'),
    'Bearer test-token-1',
  )

  assert.equal(
    mock.calls[1].options.headers.get('Authorization'),
    'Bearer test-token-2',
  )
})

test('18 - bearer HTTP 401 is authentication error', async () => {
  const mock = createMockFetch(
    () => new Response(null, { status: 401 }),
  )

  const client = bearerClient(mock)

  await expectErrorKind(
    () => client.request({ path: 'leads' }),
    'authentication',
    401,
  )
})

test('19 - bearer HTTP 403 is authorization error', async () => {
  const mock = createMockFetch(
    () => new Response(null, { status: 403 }),
  )

  const client = bearerClient(mock)

  await expectErrorKind(
    () => client.request({ path: 'leads' }),
    'authorization',
    403,
  )
})

test('20 - cookie mode includes credentials', async () => {
  const mock = createMockFetch()
  const client = cookieClient(mock)

  await client.request({ path: 'leads' })

  assert.equal(
    mock.calls[0].options.credentials,
    'include',
  )
})

test('21 - cookie mode does not attach bearer authorization', async () => {
  const mock = createMockFetch()
  const client = cookieClient(mock)

  await client.request({ path: 'leads' })

  assert.equal(
    mock.calls[0].options.headers.has('Authorization'),
    false,
  )
})

test('22 - cookie mode rejects token provider', () => {
  const mock = createMockFetch()

  expectConfigurationError(
    () => cookieClient(mock, {
      getToken: () => 'unneeded-test-token',
    }),
  )

  assert.equal(mock.calls.length, 0)
})

test('23 - cookie mode rejects explicitly null token provider', () => {
  const mock = createMockFetch()

  expectConfigurationError(
    () => cookieClient(mock, {
      getToken: null,
    }),
  )

  assert.equal(mock.calls.length, 0)
})

test('24 - cookie mode parses successful JSON response', async () => {
  const mock = createMockFetch(
    () => responseJson({
      items: [],
      total: 0,
    }),
  )

  const client = cookieClient(mock)

  assert.deepEqual(
    await client.request({ path: 'leads' }),
    {
      items: [],
      total: 0,
    },
  )
})

test('25 - cookie mode sends JSON POST data', async () => {
  const mock = createMockFetch(
    () => responseJson({ id: 'test-id' }, 201),
  )

  const client = cookieClient(mock)

  const result = await client.request({
    path: 'leads',
    method: 'POST',
    body: { title: 'Test lead' },
  })

  assert.deepEqual(result, { id: 'test-id' })

  assert.equal(
    mock.calls[0].options.body,
    '{"title":"Test lead"}',
  )

  assert.equal(
    mock.calls[0].options.headers.get('Content-Type'),
    'application/json',
  )
})

test('26 - cookie mode accepts HTTP 204', async () => {
  const mock = createMockFetch(
    () => new Response(null, { status: 204 }),
  )

  const client = cookieClient(mock)

  assert.equal(
    await client.request({
      path: 'leads/test-id',
      method: 'DELETE',
    }),
    null,
  )
})

test('27 - malformed JSON is classified', async () => {
  const mock = createMockFetch(
    () => new Response('{invalid', {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    }),
  )

  const client = cookieClient(mock)

  await expectErrorKind(
    () => client.request({ path: 'leads' }),
    'response',
    200,
  )
})

test('28 - cancellation prevents fetch request', async () => {
  const mock = createMockFetch()
  const controller = new AbortController()

  controller.abort()

  const client = cookieClient(mock)

  await expectErrorKind(
    () => client.request({
      path: 'leads',
      signal: controller.signal,
    }),
    'aborted',
  )

  assert.equal(mock.calls.length, 0)
})

test('29 - unsupported authentication mode is rejected', () => {
  const mock = createMockFetch()

  expectConfigurationError(
    () => createCrmApiClient({
      configuration: configuration('anonymous'),
      fetchImpl: mock.fetchImpl,
    }),
  )

  assert.equal(mock.calls.length, 0)
})

test('30 - insecure remote API URL is rejected', () => {
  const mock = createMockFetch()

  expectConfigurationError(
    () => createCrmApiClient({
      configuration: configuration(
        'cookie',
        'http://api.example.com/v1/',
      ),
      fetchImpl: mock.fetchImpl,
    }),
  )

  assert.equal(mock.calls.length, 0)
})