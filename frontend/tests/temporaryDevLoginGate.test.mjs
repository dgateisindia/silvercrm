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
const app = load('src/App.tsx')
const proxy = load('vite.config.ts')

test('temporary login JSX/TS syntax compiles in memory', () => {
  const output = ts.transpileModule(gate, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext }, reportDiagnostics: true })
  assert.deepEqual((output.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error), [])
})
test('all 3 declared CRM roles are available, not Read-only/Denied/Inactive', () => {
  assert.match(gate, /role: 'OWNER'/)
  assert.match(gate, /role: 'MANAGER'/)
  assert.match(gate, /role: 'EMPLOYEE'/)
  assert.doesNotMatch(gate, /role: 'DENIED'/)
})
test('backend /me is required for sign-in, no automatic role grant', () => {
  assert.match(gate, /path: 'me'/)
  assert.match(gate, /isVerifiedIdentity\(result, selectedRole\)/)
  assert.match(gate, /data\.role === selectedRole/)
})
test('active FULL membership is required', () => {
  assert.match(gate, /data\.accessMode === 'FULL'/)
})
test('tokens stored only in existing transient bridge, cleared on logout/failure', () => {
  assert.match(gate, /bridge\.auth\.setToken\(value\)/)
  assert.match(gate, /bridge\.auth\.clearToken\(\)/)
  assert.doesNotMatch(gate, /localStorage|sessionStorage|document\.cookie/)
})
test('production builds fail closed pending SaaS sign-in', () => {
  assert.match(gate, /if \(!import\.meta\.env\.DEV\)/)
  assert.match(gate, /Sign-in integration pending/)
})
test('all CRM routes are protected by the temp gate', () => {
  assert.match(app, /element=\{<TemporaryDevLoginGate \/>\}/)
  assert.doesNotMatch(app, /element=\{<CRMLayout \/>\}/)
})
test('Vite proxy stays bound to local loopback', () => {
  assert.match(proxy, /host: '127\.0\.0\.1'/)
  assert.match(proxy, /target: 'http:\/\/127\.0\.0\.1:4001'/)
})
test('API config contains no credentials or tokens', () => {
  const config = load('.env.development.local')
  assert.equal(config, 'VITE_CRM_API_BASE_URL=http://127.0.0.1:5173/api/v1/crm/\nVITE_CRM_AUTH_MODE=bearer\n')
})
