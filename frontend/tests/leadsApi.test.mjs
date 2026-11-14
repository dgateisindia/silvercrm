import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'

// Compile the real frontend TS source in memory, with only its API error
// dependency mocked. No Node/browser network functions are exposed.
const require = createRequire(import.meta.url)
const ts = require('typescript')
const sourceFile = fileURLToPath(new URL('../src/features/leads/leadsApi.ts', import.meta.url))
const tsSource = readFileSync(sourceFile, 'utf8')
const output = ts.transpileModule(tsSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
  reportDiagnostics: true,
})
const diagnostics = output.diagnostics ?? []
assert.equal(diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)

class MockApiClientError extends Error {
  constructor(kind, message) {
    super(message)
    this.name = 'ApiClientError'
    this.kind = kind
  }
}

const moduleBox = { exports: {} }
const isolatedRequire = specifier => {
  if (specifier !== '../../core/api/apiClient') {
    throw new Error('Unexpected dependency loaded by Leads API adapter')
  }
  return { ApiClientError: MockApiClientError }
}

vm.runInNewContext(output.outputText, {
  module: moduleBox,
  exports: moduleBox.exports,
  require: isolatedRequire,
  URLSearchParams,
  AbortController,
  AbortSignal,
}, {
  filename: sourceFile,
  timeout: 2000,
})

const { createLeadsReadApi } = moduleBox.exports
assert.equal(typeof createLeadsReadApi, 'function')

const lead = Object.freeze({
  id: '10', contactId: null, accountId: null,
  title: 'Example lead', sourceKey: null,
  status: 'new', priority: 'normal',
  createdByUserId: '1', ownerUserId: '2',
  assignedAt: null, nextFollowupAt: null,
  description: null,
  createdAt: '2026-11-12T04:00:00.000Z',
  updatedAt: '2026-11-12T04:00:00.000Z',
})
const listEnvelope = (data = [lead], nextCursor = null, limit = 25) => ({
  success: true,
  data,
  pagination: { limit, nextCursor },
})
const detailEnvelope = (data = lead) => ({ success: true, data })

function mockClient(response, error) {
  const calls = []
  const client = {
    async request(options) {
      calls.push(options)
      if (error) throw error
      return typeof response === 'function' ? response(options) : response
    },
  }
  return { client, calls, api: createLeadsReadApi(client) }
}

function expectKind(kind) {
  return error => error instanceof MockApiClientError && error.kind === kind
}

// 01â€“08: basic behavior, request shape, pagination and abort signals.
test('01 creates adapter without any request', () => {
  const { calls } = mockClient(listEnvelope())
  assert.equal(calls.length, 0)
})
test('02 exposes frozen API object', () => {
  const { api } = mockClient(listEnvelope())
  assert.equal(Object.isFrozen(api), true)
})
test('03 sends default limit=25 GET list', async () => {
  const { api, calls } = mockClient(listEnvelope())
  const result = await api.list()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].path, 'leads?limit=25')
  assert.equal(result.pagination.limit, 25)
})
test('04 supports minimum page size=1', async () => {
  const { api, calls } = mockClient(listEnvelope([lead], null, 1))
  await api.list({ limit: 1 })
  assert.equal(calls[0].path, 'leads?limit=1')
})
test('05 supports maximum page size=100', async () => {
  const { api, calls } = mockClient(listEnvelope([lead], null, 100))
  await api.list({ limit: 100 })
  assert.equal(calls[0].path, 'leads?limit=100')
})
test('06 accepts and encodes beforeId', async () => {
  const { api, calls } = mockClient(listEnvelope())
  await api.list({ beforeId: '15' })
  assert.equal(calls[0].path, 'leads?limit=25&beforeId=15')
})
test('07 supports maximum unsigned BIGINT cursor', async () => {
  const max = '18446744073709551615'
  const { api, calls } = mockClient(listEnvelope())
  await api.list({ beforeId: max })
  assert.equal(calls[0].path, `leads?limit=25&beforeId=${max}`)
})
test('08 forwards cancellation signal on list', async () => {
  const signal = new AbortController().signal
  const { api, calls } = mockClient(listEnvelope())
  await api.list({ signal })
  assert.equal(calls[0].signal, signal)
})

// 09â€“16: reject unsafe or malformed inputs before making HTTP calls.
for (const [index, invalid] of [0, 101, 1.5, NaN, '10'].entries()) {
  test(`${String(index + 9).padStart(2, '0')} rejects invalid page limit ${String(invalid)}`, async () => {
    const { api, calls } = mockClient(listEnvelope())
    await assert.rejects(api.list({ limit: invalid }), expectKind('configuration'))
    assert.equal(calls.length, 0)
  })
}
for (const [index, invalid] of ['0', '001', '18446744073709551616'].entries()) {
  test(`${String(index + 14).padStart(2, '0')} rejects invalid request cursor`, async () => {
    const { api, calls } = mockClient(listEnvelope())
    await assert.rejects(api.list({ beforeId: invalid }), expectKind('configuration'))
    assert.equal(calls.length, 0)
  })
}

// 17â€“27: backend envelope, fields, defensive validation and cursor safety.
test('17 preserves non-null cursor for an empty, filtered page', async () => {
  const { api } = mockClient(listEnvelope([], '39'))
  const result = await api.list()
  assert.equal(result.items.length, 0)
  assert.equal(result.pagination.nextCursor, '39')
})
test('18 preserves null cursor at end of pagination', async () => {
  const { api } = mockClient(listEnvelope([], null))
  assert.equal((await api.list()).pagination.nextCursor, null)
})
test('19 maps all required public lead properties', async () => {
  const { api } = mockClient(listEnvelope())
  const row = (await api.list()).items[0]
  for (const [key, value] of Object.entries(lead)) assert.equal(row[key], value)
})
test('20 freezes list, pagination, rows and items', async () => {
  const { api } = mockClient(listEnvelope())
  const result = await api.list()
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.pagination), true)
  assert.equal(Object.isFrozen(result.items), true)
  assert.equal(Object.isFrozen(result.items[0]), true)
})
test('21 keeps maximum unsigned BIGINT ID as exact text', async () => {
  const max = '18446744073709551615'
  const { api } = mockClient(listEnvelope([{ ...lead, id: max }]))
  assert.equal((await api.list()).items[0].id, max)
})
test('22 refuses unsafe numeric response IDs', async () => {
  const { api } = mockClient(listEnvelope([{ ...lead, id: 9007199254740992 }]))
  await assert.rejects(api.list(), expectKind('response'))
})
test('23 rejects a response exceeding the requested page limit', async () => {
  const { api } = mockClient(listEnvelope([lead, lead], null, 1))
  await assert.rejects(api.list({ limit: 1 }), expectKind('response'))
})
test('24 rejects unsuccessful list envelope', async () => {
  const { api } = mockClient({ ...listEnvelope(), success: false })
  await assert.rejects(api.list(), expectKind('response'))
})
test('25 rejects missing data array', async () => {
  const { api } = mockClient({ ...listEnvelope(), data: null })
  await assert.rejects(api.list(), expectKind('response'))
})
test('26 rejects pagination limit mismatch', async () => {
  const { api } = mockClient(listEnvelope([lead], null, 12))
  await assert.rejects(api.list(), expectKind('response'))
})
test('27 rejects non-BIGINT pagination cursor', async () => {
  const { api } = mockClient(listEnvelope([], 'not-an-id'))
  await assert.rejects(api.list(), expectKind('response'))
})

// 28â€“36: detail GET, malformed detail, and transparent error behavior.
test('28 retrieves a lead by exact ID with GET', async () => {
  const { api, calls } = mockClient(detailEnvelope())
  const result = await api.getById('10')
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].path, 'leads/10')
  assert.equal(result.id, '10')
})
test('29 forwards cancellation signal on detail', async () => {
  const signal = new AbortController().signal
  const { api, calls } = mockClient(detailEnvelope())
  await api.getById('10', signal)
  assert.equal(calls[0].signal, signal)
})
test('30 refuses invalid detail ID without making request', async () => {
  const { api, calls } = mockClient(detailEnvelope())
  await assert.rejects(api.getById('0'), expectKind('configuration'))
  assert.equal(calls.length, 0)
})
test('31 rejects detail response ID mismatch', async () => {
  const { api } = mockClient(detailEnvelope())
  await assert.rejects(api.getById('11'), expectKind('response'))
})
test('32 rejects detail response missing required fields', async () => {
  const { api } = mockClient(detailEnvelope({ ...lead, status: undefined }))
  await assert.rejects(api.getById('10'), expectKind('response'))
})
test('33 propagates network error from the list client unchanged', async () => {
  const cause = new Error('Network unavailable')
  const { api } = mockClient(null, cause)
  await assert.rejects(api.list(), error => error === cause)
})
test('34 propagates HTTP error from detail client unchanged', async () => {
  const cause = new Error('HTTP 404')
  const { api } = mockClient(null, cause)
  await assert.rejects(api.getById('10'), error => error === cause)
})
test('35 rejects missing request client', () => {
  assert.throws(() => createLeadsReadApi(null), expectKind('configuration'))
})
test('36 rejects malformed detail response', async () => {
  const { api } = mockClient({ success: true, data: null })
  await assert.rejects(api.getById('10'), expectKind('response'))
})

// 37â€“40: additional boundary cases.
test('37 rejects null list options before request', async () => {
  const { api, calls } = mockClient(listEnvelope())
  await assert.rejects(api.list(null), expectKind('configuration'))
  assert.equal(calls.length, 0)
})
test('38 rejects missing pagination object', async () => {
  const { api } = mockClient({ success: true, data: [lead] })
  await assert.rejects(api.list(), expectKind('response'))
})
test('39 preserves nullable contact and account IDs', async () => {
  const { api } = mockClient(listEnvelope())
  const record = (await api.list()).items[0]
  assert.equal(record.contactId, null)
  assert.equal(record.accountId, null)
})
test('40 rejects an invalid date type in response', async () => {
  const { api } = mockClient(listEnvelope([{ ...lead, createdAt: 1234 }]))
  await assert.rejects(api.list(), expectKind('response'))
})