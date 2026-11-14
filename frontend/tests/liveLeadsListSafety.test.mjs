import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const read = p => readFileSync(fileURLToPath(new URL('../' + p, import.meta.url)), 'utf8')
const table = read('src/features/integration/LiveLeadsList.tsx')
const page = read('src/features/leads/LeadsPage.tsx')
const adapter = read('src/features/leads/leadsApi.ts')
const require = createRequire(import.meta.url)
const ts = require('typescript')

test('live Leads component is TypeScript/TSX syntax-valid', () => {
  for (const source of [table,page]) {
    const result = ts.transpileModule(source, {compilerOptions: {jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}, reportDiagnostics: true})
    assert.equal((result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
  }
})
test('new live list uses verified API client from provider only', () => {
  assert.match(page, /useVerifiedCrmApi\(\)/)
  assert.match(page, /<LiveLeadsList client=\{liveClient\} \/>/)
  assert.match(table, /client: ApiClient/)
})
test('requests use the existing typed GET-only Leads adapter', () => {
  assert.match(table, /createLeadsReadApi\(client\)\.list/)
  assert.match(table, /limit: PAGE_SIZE/)
  assert.match(adapter, /method: 'GET'/)
  assert.doesNotMatch(table, /\b(?:fetch\s*\(|axios\.|localStorage|sessionStorage)\b/)
})
test('abort token-bound requests when component unmounts or API client changes', () => {
  assert.match(table, /new AbortController\(\)/)
  assert.match(table, /signal: controller.signal/)
  assert.match(table, /return \(\) => controller.abort\(\)/)
  assert.match(table, /\[client, cursor, retry\]/)
})
test('denied and expired auth states cannot present stale rows', () => {
  assert.match(table, /setStatus\(\{ kind: 'loading' \}\)/)
  assert.match(table, /status.kind === 'ready' \? status.page : null/)
  assert.match(table, /kind === 'unauthorized'/)
  assert.match(table, /kind === 'expired'/)
  assert.match(table, /HTTP 403/)
  assert.match(table, /HTTP 401/)
})
test('pagination follows server cursor instead of guessing totals or offsets', () => {
  assert.match(table, /nextCursor/)
  assert.match(table, /beforeId: cursor/)
  assert.match(table, /cursors\.length/)
  assert.doesNotMatch(table, /totalCount|OFFSET|offset:/)
})
test('search and filters are limited to loaded page', () => {
  assert.match(table, /Search and status filters affect this page only/)
  assert.match(table, /page\?\.items \?\? \[\]/)
  assert.match(table, /statusFilter/)
})
test('no invented company or owner names are displayed', () => {
  assert.match(table, />Account ID</)
  assert.match(table, />Owner user ID</)
  assert.match(table, /lead\.accountId \?\? '—'/)
  assert.match(table, /lead\.ownerUserId/)
})
test('owner remains unable to open form preview', () => {
  assert.match(page, /verifiedIdentity\?\.role === 'MANAGER'/)
  assert.match(page, /verifiedIdentity\?\.role === 'EMPLOYEE'/)
  assert.match(page, /\{canSeeLeadAction && \(/)
})
test('existing presentation mode and preview remain intact', () => {
  assert.match(page, /rows\.length === 0/)
  assert.match(page, /Live Leads list not loaded into this table/)
  assert.match(page, /<LeadsReadOnlyAccessPanel \/>/)
  assert.match(page, /No lead columns are configured/)
})
test('new component has no write methods or SQL statements', () => {
  assert.doesNotMatch(table, /method:\s*['"](?:POST|PATCH|PUT|DELETE)['"]/)
  assert.doesNotMatch(table, /\b(?:INSERT INTO|UPDATE\s+leads|DELETE FROM)\b/i)
})
