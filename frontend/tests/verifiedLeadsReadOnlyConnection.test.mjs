import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const ts = require('typescript')
const dir = new URL('../', import.meta.url)
const load = path => readFileSync(fileURLToPath(new URL(path, dir)), 'utf8')
const gate = load('src/features/auth/TemporaryDevLoginGate.tsx')
const leads = load('src/features/leads/LeadsPage.tsx')
const panel = load('src/features/integration/LeadsReadOnlyAccessPanel.tsx')
const provider = load('src/core/api/VerifiedCrmApiProvider.tsx')
const store = load('src/core/api/VerifiedCrmApiStore.ts')

test('new TS and JSX sources transpile without syntax errors', () => {
  for (const source of [gate, leads, panel, provider, store]) {
    const result = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext }, reportDiagnostics: true })
    assert.deepEqual((result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error), [])
  }
})
test('API client is supplied only under backend-verified login identity', () => {
  assert.match(gate, /if \(identity !== null\)/)
  assert.match(gate, /<VerifiedDevIdentityProvider identity=\{identity\}>/)
  assert.match(gate, /<VerifiedCrmApiProvider client=\{bridge\?\.client \?\? null\}>/)
  assert.match(gate, /bridge\.auth\.clearToken\(\)/)
})
test('API provider contains client reference but no bearer token persistence', () => {
  assert.match(store, /createContext<ApiClient \| null>\(null\)/)
  assert.doesNotMatch(store + provider, /setToken|localStorage|sessionStorage|document\.cookie|Authorization/)
})
test('Leads access panel calls only established authenticated read adapter', () => {
  assert.match(panel, /createLeadsReadApi\(client\)\.list/)
  assert.match(panel, /limit: 1/)
  assert.match(panel, /signal: controller\.signal/)
  assert.doesNotMatch(panel, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]|\.create\(|\.update\(|\.delete\(/)
})
test('403 is not conflated with an empty authorized Leads list', () => {
  assert.match(panel, /error\.kind === 'authorization'/)
  assert.match(panel, /kind: 'unprovisioned'/)
  assert.match(panel, /this is not an empty authorized lead list/)
})
test('existing Leads UI stays mounted and no silent auto-load occurs', () => {
  assert.match(leads, /<LeadsReadOnlyAccessPanel \/>/)
  assert.match(panel, /onClick=\{\(\) => \{ void checkLeadsRead\(\) \}\}/)
  assert.doesNotMatch(panel, /useEffect\(\(\) => \{\s*void checkLeadsRead/)
})
