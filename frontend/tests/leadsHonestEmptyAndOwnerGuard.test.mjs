import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = relative => readFileSync(fileURLToPath(new URL('../' + relative, import.meta.url)), 'utf8')
const page = read('src/features/leads/LeadsPage.tsx')
const panel = read('src/features/integration/LeadsReadOnlyAccessPanel.tsx')

test('Leads UI derives role from backend-verified identity context', () => {
    assert.match(page, /useVerifiedDevIdentity\(\)/)
    assert.match(page, /VerifiedDevIdentityStore/)
})

test('lead action is shown only to verified Manager or Employee', () => {
    assert.match(page, /verifiedIdentity\?\.role === 'MANAGER'/)
    assert.match(page, /verifiedIdentity\?\.role === 'EMPLOYEE'/)
    assert.match(page, /\{canSeeLeadAction && \(\s*<button/)
})

test('Owner cannot open even the development lead-form dialog from this page', () => {
    assert.match(page, /\{canSeeLeadAction && import\.meta\.env\.DEV && !onCreateLead && \(/)
    assert.doesNotMatch(page, /verifiedIdentity\?\.role === 'OWNER'\s*\|\|/)
})

test('unloaded table does not claim zero authorized Leads', () => {
    assert.match(page, /Live Leads list not loaded into this table/)
    assert.match(page, /Live Leads list not loaded/)
    assert.doesNotMatch(page, /No leads available/)
})

test('displayed rows are explicitly not a company total', () => {
    assert.match(page, /displayed rows/)
    assert.match(page, /access check verifies permission; loading live lead rows is the next integration step/i)
})

test('existing access check remains explicit and authenticated GET-only', () => {
    assert.match(page, /<LeadsReadOnlyAccessPanel \/>/)
    assert.match(panel, /createLeadsReadApi\(client\)\.list/)
    assert.match(panel, /limit: 1/)
    assert.match(panel, /Check Leads access/)
})

test('no new write-request calls are added to the Leads presentation page', () => {
    assert.doesNotMatch(page, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/)
    assert.match(page, /Preview only: no data will be saved/)
})
