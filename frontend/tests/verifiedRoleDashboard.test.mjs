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
const identity = load('src/core/auth/VerifiedDevIdentityContext.tsx')
const identityStore = load('src/core/auth/VerifiedDevIdentityStore.ts')
const dashboard = load('src/features/dashboard/DashboardPage.tsx')
const styles = load('src/features/dashboard/VerifiedRoleDashboard.css')

test('verified role context and changed JSX compile', () => {
  for (const file of [gate, identity, identityStore, dashboard]) {
    const output = ts.transpileModule(file, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext }, reportDiagnostics: true })
    assert.deepEqual((output.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error), [])
  }
})
test('role identity is provided only after backend /me validation', () => {
  assert.match(gate, /path: 'me'/)
  assert.match(gate, /isVerifiedIdentity\(result, selectedRole\)/)
  assert.match(gate, /if \(identity !== null\)/)
  assert.match(gate, /<VerifiedDevIdentityProvider identity=\{identity\}>/)
})
test('context never stores, serializes or exposes bearer tokens', () => {
  assert.doesNotMatch(identity + identityStore, /setToken|tokenInput|localStorage|sessionStorage|document\.cookie|Authorization/)
  assert.match(identityStore, /createContext<VerifiedDevIdentity \| null>\(null\)/)
})
test('owner manager employee each have separate presentation', () => {
  for (const text of ['Owner Dashboard', 'Manager Dashboard', 'Employee Dashboard']) {
    assert.match(dashboard, new RegExp(text))
  }
  assert.match(dashboard, /verifiedRoleViews\[verifiedIdentity\.role\]/)
})
test('role presentation has blank metrics until actual authorized data supplied', () => {
  assert.match(dashboard, /value: null/)
  assert.match(dashboard, /data\?\.metrics \?\? /)
  assert.match(dashboard, /No live metrics are shown until backend-authorized CRM data is connected/)
})
test('existing login access controls are preserved', () => {
  assert.match(gate, /data\.accessMode === 'FULL'/)
  assert.match(gate, /bridge\.auth\.clearToken\(\)/)
  assert.match(gate, /Sign-in integration pending/)
})
test('dashboard role UI does not issue writes or perform mock role switch', () => {
  assert.doesNotMatch(dashboard, /method: '(POST|PUT|PATCH|DELETE)'/)
  assert.doesNotMatch(dashboard, /setRole|previewRole|localStorage/)
  assert.match(styles, /dashboard-role-context/)
})
