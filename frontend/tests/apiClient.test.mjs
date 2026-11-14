import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ApiClientError,
  createApiClient,
} from '../src/core/api/apiClient.ts'

const BASE = 'http://localhost:4300/api/'

function json(value, status = 200, contentType = 'application/json') {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': contentType },
  })
}

function mockedFetch(
  responder = () => json({ ok: true }),
) {
  const calls = []

  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return responder(url, options)
  }

  return { calls, fetchImpl }
}

function cookieClient(fetchImpl, baseUrl = BASE) {
  return createApiClient({
    baseUrl,
    auth: { mode: 'cookie' },
    fetchImpl,
  })
}

async function expectKind(
  action,
  expectedKind,
  expectedStatus,
) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof ApiClientError)
    assert.equal(error.kind, expectedKind)

    if (expectedStatus !== undefined) {
      assert.equal(error.status, expectedStatus)
    }

    return true
  })
}

test('01 - GET returns JSON and uses configured API path', async () => {
  const mock = mockedFetch(() => json({ items: [] }))
  const client = cookieClient(mock.fetchImpl)

  const result = await client.request({ path: 'leads' })

  assert.deepEqual(result, { items: [] })
  assert.equal(mock.calls.length, 1)
  assert.equal(mock.calls[0].url, `${BASE}leads`)
  assert.equal(mock.calls[0].options.method, 'GET')
})

test('02 - GET accepts a leading slash within the API base', async () => {
  const mock = mockedFetch()
  const client = cookieClient(mock.fetchImpl)

  await client.request({ path: '/leads' })

  assert.equal(mock.calls[0].url, `${BASE}leads`)
})

test('03 - GET preserves a query string', async () => {
  const mock = mockedFetch()
  const client = cookieClient(mock.fetchImpl)

  await client.request({
    path: 'leads?page=2',
  })

  assert.equal(
    mock.calls[0].url,
    `${BASE}leads?page=2`,
  )
})

test('04 - cookie mode includes credentials', async () => {
  const mock = mockedFetch()
  const client = cookieClient(mock.fetchImpl)

  await client.request({ path: 'leads' })

  assert.equal(
    mock.calls[0].options.credentials,
    'include',
  )
  assert.equal(
    mock.calls[0].options.headers.has('Authorization'),
    false,
  )
})

test('05 - requests disable caching and redirects', async () => {
  const mock = mockedFetch()
  const client = cookieClient(mock.fetchImpl)

  await client.request({ path: 'leads' })

  assert.equal(mock.calls[0].options.cache, 'no-store')
  assert.equal(mock.calls[0].options.redirect, 'error')
})

test('06 - POST serializes JSON body', async () => {
  const mock = mockedFetch(() => json({ id: 10 }, 201))
  const client = cookieClient(mock.fetchImpl)

  const result = await client.request({
    path: 'leads',
    method: 'POST',
    body: { title: 'Example' },
  })

  assert.deepEqual(result, { id: 10 })
  assert.equal(mock.calls[0].options.method, 'POST')
  assert.equal(
    mock.calls[0].options.body,
    '{"title":"Example"}',
  )
  assert.equal(
    mock.calls[0].options.headers.get('Content-Type'),
    'application/json',
  )
})

test('07 - PATCH sends JSON updates', async () => {
  const mock = mockedFetch()
  const client = cookieClient(mock.fetchImpl)

  await client.request({
    path: 'leads/10',
    method: 'PATCH',
    body: { title: 'Updated' },
  })

  assert.equal(mock.calls[0].options.method, 'PATCH')
  assert.equal(
    mock.calls[0].options.body,
    '{"title":"Updated"}',
  )
})

test('08 - DELETE supports HTTP 204', async () => {
  const mock = mockedFetch(
    () => new Response(null, { status: 204 }),
  )

  const client = cookieClient(mock.fetchImpl)

  const result = await client.request({
    path: 'leads/10',
    method: 'DELETE',
  })

  assert.equal(result, null)
})

test('09 - HTTP 205 returns null', async () => {
  const mock = mockedFetch(
    () => new Response(null, { status: 205 }),
  )

  const client = cookieClient(mock.fetchImpl)
  const result = await client.request({ path: 'leads' })

  assert.equal(result, null)
})

test('10 - bearer mode sends authorization header', async () => {
  const mock = mockedFetch()

  const client = createApiClient({
    baseUrl: BASE,
    auth: {
      mode: 'bearer',
      getToken: () => 'local-test-token',
    },
    fetchImpl: mock.fetchImpl,
  })

  await client.request({ path: 'leads' })

  assert.equal(
    mock.calls[0].options.headers.get('Authorization'),
    'Bearer local-test-token',
  )
  assert.equal(
    mock.calls[0].options.credentials,
    'omit',
  )
})

test('11 - bearer mode supports asynchronous token provider', async () => {
  const mock = mockedFetch()

  const client = createApiClient({
    baseUrl: BASE,
    auth: {
      mode: 'bearer',
      getToken: async () => 'async-test-token',
    },
    fetchImpl: mock.fetchImpl,
  })

  await client.request({ path: 'leads' })

  assert.equal(
    mock.calls[0].options.headers.get('Authorization'),
    'Bearer async-test-token',
  )
})

test('12 - missing bearer token prevents network request', async () => {
  const mock = mockedFetch()

  const client = createApiClient({
    baseUrl: BASE,
    auth: {
      mode: 'bearer',
      getToken: () => null,
    },
    fetchImpl: mock.fetchImpl,
  })

  await expectKind(
    () => client.request({ path: 'leads' }),
    'authentication',
  )

  assert.equal(mock.calls.length, 0)
})

test('13 - whitespace bearer token is rejected', async () => {
  const mock = mockedFetch()

  const client = createApiClient({
    baseUrl: BASE,
    auth: {
      mode: 'bearer',
      getToken: () => 'bad token',
    },
    fetchImpl: mock.fetchImpl,
  })

  await expectKind(
    () => client.request({ path: 'leads' }),
    'authentication',
  )

  assert.equal(mock.calls.length, 0)
})

test('14 - token provider failures are classified', async () => {
  const mock = mockedFetch()

  const client = createApiClient({
    baseUrl: BASE,
    auth: {
      mode: 'bearer',
      getToken: async () => {
        throw new Error('private auth failure')
      },
    },
    fetchImpl: mock.fetchImpl,
  })

  await expectKind(
    () => client.request({ path: 'leads' }),
    'authentication',
  )

  assert.equal(mock.calls.length, 0)
})

test('15 - missing authentication configuration is rejected', () => {
  assert.throws(
    () => createApiClient({
      baseUrl: BASE,
      auth: null,
      fetchImpl: mockedFetch().fetchImpl,
    }),
    (error) => (
      error instanceof ApiClientError &&
      error.kind === 'configuration'
    ),
  )
})

test('16 - invalid bearer configuration is rejected', () => {
  assert.throws(
    () => createApiClient({
      baseUrl: BASE,
      auth: { mode: 'bearer' },
      fetchImpl: mockedFetch().fetchImpl,
    }),
    (error) => (
      error instanceof ApiClientError &&
      error.kind === 'configuration'
    ),
  )
})

test('17 - missing API base URL is rejected', () => {
  assert.throws(
    () => cookieClient(mockedFetch().fetchImpl, ''),
    (error) => (
      error instanceof ApiClientError &&
      error.kind === 'configuration'
    ),
  )
})

test('18 - remote HTTP base URL is rejected', () => {
  assert.throws(
    () => cookieClient(
      mockedFetch().fetchImpl,
      'http://api.example.com/v1/',
    ),
    (error) => (
      error instanceof ApiClientError &&
      error.kind === 'configuration'
    ),
  )
})

test('19 - HTTPS API base URL is accepted', async () => {
  const mock = mockedFetch()

  const client = cookieClient(
    mock.fetchImpl,
    'https://api.example.com/v1/',
  )

  await client.request({ path: 'leads' })

  assert.equal(
    mock.calls[0].url,
    'https://api.example.com/v1/leads',
  )
})

test('20 - credentials in API base URL are rejected', () => {
  assert.throws(
    () => cookieClient(
      mockedFetch().fetchImpl,
      'https://user:secret@api.example.com/v1/',
    ),
    (error) => (
      error instanceof ApiClientError &&
      error.kind === 'configuration'
    ),
  )
})

test('21 - absolute request URL is rejected', async () => {
  const mock = mockedFetch()
  const client = cookieClient(mock.fetchImpl)

  await expectKind(
    () => client.request({
      path: 'https://another.example.com/leads',
    }),
    'configuration',
  )

  assert.equal(mock.calls.length, 0)
})

test('22 - protocol-relative request URL is rejected', async () => {
  const mock = mockedFetch()
  const client = cookieClient(mock.fetchImpl)

  await expectKind(
    () => client.request({
      path: '//another.example.com/leads',
    }),
    'configuration',
  )

  assert.equal(mock.calls.length, 0)
})

test('23 - path traversal outside API base is rejected', async () => {
  const mock = mockedFetch()
  const client = cookieClient(mock.fetchImpl)

  await expectKind(
    () => client.request({
      path: '../private',
    }),
    'configuration',
  )

  assert.equal(mock.calls.length, 0)
})

test('24 - request path containing backslashes is rejected', async () => {
  const mock = mockedFetch()
  const client = cookieClient(mock.fetchImpl)

  await expectKind(
    () => client.request({
      path: 'leads\\private',
    }),
    'configuration',
  )

  assert.equal(mock.calls.length, 0)
})

test('25 - GET request bodies are rejected', async () => {
  const mock = mockedFetch()
  const client = cookieClient(mock.fetchImpl)

  await expectKind(
    () => client.request({
      path: 'leads',
      method: 'GET',
      body: { id: 1 },
    }),
    'configuration',
  )

  assert.equal(mock.calls.length, 0)
})

test('26 - circular JSON body is rejected', async () => {
  const mock = mockedFetch()
  const client = cookieClient(mock.fetchImpl)

  const payload = {}
  payload.self = payload

  await expectKind(
    () => client.request({
      path: 'leads',
      method: 'POST',
      body: payload,
    }),
    'configuration',
  )

  assert.equal(mock.calls.length, 0)
})

test('27 - caller cannot override authorization header', async () => {
  const mock = mockedFetch()
  const client = cookieClient(mock.fetchImpl)

  await expectKind(
    () => client.request({
      path: 'leads',
      headers: {
        Authorization: 'Bearer caller-token',
      },
    }),
    'configuration',
  )

  assert.equal(mock.calls.length, 0)
})

test('28 - caller cannot override content-type', async () => {
  const mock = mockedFetch()
  const client = cookieClient(mock.fetchImpl)

  await expectKind(
    () => client.request({
      path: 'leads',
      headers: {
        'Content-Type': 'text/plain',
      },
    }),
    'configuration',
  )

  assert.equal(mock.calls.length, 0)
})

test('29 - custom nonreserved headers are supported', async () => {
  const mock = mockedFetch()
  const client = cookieClient(mock.fetchImpl)

  await client.request({
    path: 'leads',
    headers: {
      'X-Request-Source': 'crm-frontend',
    },
  })

  assert.equal(
    mock.calls[0].options.headers.get('X-Request-Source'),
    'crm-frontend',
  )
  assert.equal(
    mock.calls[0].options.headers.get('Accept'),
    'application/json',
  )
})

test('30 - HTTP 401 is an authentication error', async () => {
  const mock = mockedFetch(
    () => new Response(null, { status: 401 }),
  )

  const client = cookieClient(mock.fetchImpl)

  await expectKind(
    () => client.request({ path: 'leads' }),
    'authentication',
    401,
  )
})

test('31 - HTTP 403 is an authorization error', async () => {
  const mock = mockedFetch(
    () => new Response(null, { status: 403 }),
  )

  const client = cookieClient(mock.fetchImpl)

  await expectKind(
    () => client.request({ path: 'leads' }),
    'authorization',
    403,
  )
})

test('32 - HTTP 409 is a general HTTP error', async () => {
  const mock = mockedFetch(
    () => new Response(null, { status: 409 }),
  )

  const client = cookieClient(mock.fetchImpl)

  await expectKind(
    () => client.request({ path: 'leads' }),
    'http',
    409,
  )
})

test('33 - application/problem+json is accepted', async () => {
  const mock = mockedFetch(
    () => json(
      { result: 'ok' },
      200,
      'application/problem+json',
    ),
  )

  const client = cookieClient(mock.fetchImpl)

  assert.deepEqual(
    await client.request({ path: 'leads' }),
    { result: 'ok' },
  )
})

test('34 - successful non-JSON responses are rejected', async () => {
  const mock = mockedFetch(
    () => new Response('plain text', {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
      },
    }),
  )

  const client = cookieClient(mock.fetchImpl)

  await expectKind(
    () => client.request({ path: 'leads' }),
    'response',
    200,
  )
})

test('35 - malformed JSON is rejected', async () => {
  const mock = mockedFetch(
    () => new Response('{broken', {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    }),
  )

  const client = cookieClient(mock.fetchImpl)

  await expectKind(
    () => client.request({ path: 'leads' }),
    'response',
    200,
  )
})

test('36 - network failure is classified', async () => {
  const mock = mockedFetch(async () => {
    throw new TypeError('network unavailable')
  })

  const client = cookieClient(mock.fetchImpl)

  await expectKind(
    () => client.request({ path: 'leads' }),
    'network',
  )
})

test('37 - cancellation before request prevents fetching', async () => {
  const controller = new AbortController()
  controller.abort()

  const mock = mockedFetch()
  const client = cookieClient(mock.fetchImpl)

  await expectKind(
    () => client.request({
      path: 'leads',
      signal: controller.signal,
    }),
    'aborted',
  )

  assert.equal(mock.calls.length, 0)
})

test('38 - cancellation during token retrieval prevents fetching', async () => {
  const controller = new AbortController()
  const mock = mockedFetch()

  const client = createApiClient({
    baseUrl: BASE,
    auth: {
      mode: 'bearer',
      getToken: async () => {
        controller.abort()
        return 'local-test-token'
      },
    },
    fetchImpl: mock.fetchImpl,
  })

  await expectKind(
    () => client.request({
      path: 'leads',
      signal: controller.signal,
    }),
    'aborted',
  )

  assert.equal(mock.calls.length, 0)
})

test('39 - aborted fetch is classified', async () => {
  const mock = mockedFetch(async () => {
    const error = new Error('Request aborted')
    error.name = 'AbortError'
    throw error
  })

  const client = cookieClient(mock.fetchImpl)

  await expectKind(
    () => client.request({ path: 'leads' }),
    'aborted',
  )
})

test('40 - unsupported method is rejected', async () => {
  const mock = mockedFetch()
  const client = cookieClient(mock.fetchImpl)

  await expectKind(
    () => client.request({
      path: 'leads',
      method: 'TRACE',
    }),
    'configuration',
  )

  assert.equal(mock.calls.length, 0)
})