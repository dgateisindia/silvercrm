import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
const dashboard = read('src/features/dashboard/LiveExecutiveDashboard.tsx')
const host = read('src/features/dashboard/DashboardPage.tsx')
const table = read('src/features/integration/LiveLeadsList.tsx')
const create = read('src/features/integration/LiveLeadCreate.tsx')
const access = read('src/features/integration/LeadsReadOnlyAccessPanel.tsx')
const polish = read('src/styles/prototypeV2Polish.css')

test('V2 executive screen reads backend overview instead of sample financial figures', () => {
    assert.match(host, /readDashboardOverview\(client, controller.signal\)/)
    assert.match(host, /<LiveExecutiveDashboard client=\{client\} overview=\{liveOverview\}/)
    assert.match(dashboard, /overview\.leadTotal/)
    assert.match(dashboard, /overview\.dealsTotal/)
    assert.match(dashboard, /overview\.overdueTasks/)
    assert.match(dashboard, /overview\.expectedDealValue/)
    assert.doesNotMatch(dashboard, /localStorage|sessionStorage|method:\s*['"]POST['"]|fake(Count|Revenue)/i)
})
test('V2 recent leads are loaded only through backend authorized GET adapter', () => {
    assert.match(dashboard, /createLeadsReadApi\(client\)\.list\(/)
    assert.match(dashboard, /signal: controller.signal/)
    assert.match(dashboard, /return \(\) => controller.abort\(\)/)
})
test('V2 does not fabricate unavailable agenda or historical chart data', () => {
    assert.match(dashboard, /Agenda details not connected/)
    assert.match(dashboard, /No sample events are displayed/)
    assert.match(dashboard, /No illustrative sales figures or fabricated activities/)
})
test('Leads creation still uses verified authentication and explicit backend POST', () => {
    assert.match(create, /path: 'leads', method: 'POST'/)
    assert.match(create, /submitting\.current = true/)
    assert.match(polish, /\.live-create-dialog\{position:fixed/)
})
test('The HTML hidden attribute keeps preview-only creation button hidden', () => {
    assert.match(polish, /\[hidden\]\{display:none!important\}/)
    assert.match(access, /<details className="crm-read-access-details">/)
})
test('Real Leads list displays live status, priority and honest pagination', () => {
    assert.match(table, />Priority<\/th>/)
    assert.match(table, /lead\.priority/)
    assert.match(table, /page\.pagination\.nextCursor/)
    assert.match(table, /Owner user ID/)
})
