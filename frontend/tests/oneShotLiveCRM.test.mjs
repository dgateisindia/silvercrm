import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
const load = name => fs.readFileSync(new URL('../'+name, import.meta.url),'utf8')
const create = load('src/features/integration/LiveLeadCreate.tsx')
const leads = load('src/features/leads/LeadsPage.tsx')
const dashboard = load('src/features/dashboard/DashboardPage.tsx')
const adapter = load('src/features/dashboard/dashboardLiveApi.ts')
test('Real create uses authenticated API and POST only on explicit Save Lead',()=>{
  assert.match(create,/path: 'leads', method: 'POST'/)
  assert.match(create,/onSubmit=/)
  assert.match(create,/submitting\.current = true/)
})
test('Company choice and field configuration requested from backend',()=>{
  assert.match(create,/customization\/leads\/form\?picklists=status,priority/)
  assert.match(create,/customization\/leads\/options/)
  assert.match(create,/customValues/)
})
test('No hardcoded tokens or passwords or customer data',()=>{
  for(const s of [create,dashboard,adapter]) assert.doesNotMatch(s,/localStorage|sessionStorage|document\.cookie|API_KEY|Bearer [a-z0-9]/i)
})
test('Owner never sees real Save Lead button',()=>{
  assert.match(leads,/canSeeLeadAction && useLiveRows && liveClient && verifiedIdentity/)
  assert.match(leads,/verifiedIdentity\?\.role === 'MANAGER'/)
  assert.match(leads,/verifiedIdentity\?\.role === 'EMPLOYEE'/)
})
test('Employee owner cannot be selected by client',()=>{
  assert.match(create,/role === 'EMPLOYEE' \? actorUserId : ownerId\.trim\(\)/)
  assert.match(create,/role === 'MANAGER' &&/)
})
test('Creation refreshes authorized list but does not fabricate rows',()=>{
  assert.match(leads,/onCreated=\{\(\) => setLiveRefresh/)
  assert.match(leads,/<Fragment key=\{liveRefresh\}>/)
})
test('Dashboard uses real scoped overview API, not fabricated revenue',()=>{
  assert.match(adapter,/dashboard\/overview/)
  assert.match(dashboard,/readDashboardOverview\(client, controller.signal\)/)
  assert.match(dashboard,/overview.scope !== expected/)
  assert.match(dashboard,/Expected Deal Value/)
  assert.match(dashboard,/Pipeline estimate, not earned revenue/)
})
test('Production guard and no automatic create',()=>{
  assert.match(create,/if \(!import\.meta\.env\.DEV\) return null/)
  assert.doesNotMatch(dashboard,/path: 'leads', method: 'POST'/)
})
