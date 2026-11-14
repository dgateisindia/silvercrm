/* D-GATE CRM QA Phase 3: local auth + HTTP + isolated MariaDB.
 * NO production DB writes. All SQL writes target random scratch schema.
 * No live Clerk/Platform/provider requests. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
const mysql=require('mysql2/promise');
const dotenv=require('dotenv');
const ts=require('typescript');
const express=require('express');
const {once}=require('node:events');
const env=dotenv.parse(fs.readFileSync('.env'));
assert.equal(env.DB_NAME,'dgate_crm_fresh','STOP: DB_NAME must be dgate_crm_fresh');
Object.assign(process.env,env,{NODE_ENV:'test',AUTH_MODE:'local',HOST:'127.0.0.1',CRM_DEV_SEED:'0'});
require.extensions['.ts']=(mod,file)=>{
 const compiled=ts.transpileModule(fs.readFileSync(file,'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}
 });mod._compile(compiled.outputText,file);
};
const {createCrmApp}=require(process.cwd()+'/./src/app.ts');
const {createDevSessionStore}=require(process.cwd()+'/./src/core/auth/devSessionVerifier.ts');
const {createDevIdentityStore}=require(process.cwd()+'/./src/core/auth/devIdentityResolver.ts');
const {createGeneralTaskRouter}=require(process.cwd()+'/./src/modules/tasks/routes/task.routes.ts');
const {createDashboardOverviewRouter}=require(process.cwd()+'/./src/modules/dashboard/dashboard.routes.ts');
const {createActivityReportRouter}=require(process.cwd()+'/./src/modules/reports/report.routes.ts');
const {createCrmExportRouter}=require(process.cwd()+'/./src/modules/exports/export.routes.ts');
const {createPortfolioExportRouter}=require(process.cwd()+'/./src/modules/exports/portfolio.routes.ts');
const cfg={host:env.DB_HOST||'127.0.0.1',port:Number(env.DB_PORT||3306),user:env.DB_USER||'root',password:env.DB_PASSWORD??'',multipleStatements:false};
const scratch='dgate_crm_qap3_'+crypto.randomBytes(8).toString('hex');
assert.match(scratch,/^dgate_crm_qap3_[a-f0-9]{16}$/);
const tables=['companies','users','teams','team_members','leads','tasks','deals','accounts','contacts','crm_export_jobs','audit_logs'];
let admin,pool,server,sessions,identities,created=false,failAudit=false;
async function sql(statement,args=[]){return (await pool.execute(statement,args))[0];}
async function num(table,company=100){assert.ok(tables.includes(table));const rows=await sql(`SELECT COUNT(*) n FROM \`${table}\` WHERE company_id=?`,[company]);return Number(rows[0].n);}
async function main(){
 try{
  admin=await mysql.createConnection(cfg);
  await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  created=true;
  for(const table of tables) await admin.query(`CREATE TABLE \`${scratch}\`.\`${table}\` LIKE \`${env.DB_NAME}\`.\`${table}\``);
  pool=mysql.createPool({...cfg,database:scratch,connectionLimit:8,supportBigNumbers:true,bigNumberStrings:true});
  console.log('PASS: 11 source table structures cloned into random scratch database');
  for(const company of [100,200]) await pool.execute(`INSERT INTO companies
   (id,platform_org_id,name,slug,status,platform_product_id,platform_access_mode,provisioned_at)
   VALUES(?,?,?,?,'active',1,'FULL',UTC_TIMESTAMP(3))`,
   [company,`phase3_org_${company}`,`Phase3 ${company}`,`phase3_${company}`]);
  for(const [u,c,role] of [[10,100,'owner'],[20,100,'manager'],[21,100,'manager'],[30,100,'employee'],[40,100,'employee'],[50,100,'employee'],[60,200,'employee']])
   await pool.execute(`INSERT INTO users(id,company_id,platform_user_id,full_name,email,role,status,activated_at)
    VALUES(?,?,?,?,?,?,'active',UTC_TIMESTAMP(3))`,[u,c,`phase3_user${u}`,`Phase3 User ${u}`,`phase3_${u}@example.test`,role]);
  for(const [id,manager] of [[7,20],[8,21]])await pool.execute(`INSERT INTO teams(id,company_id,name,manager_user_id,status) VALUES(?,100,?,?,'active')`,[id,`QA Team ${id}`,manager]);
  for(const [id,team,u] of [[1,7,30],[2,7,40],[3,8,50]])await pool.execute(`INSERT INTO team_members(id,company_id,team_id,user_id,joined_at) VALUES(?,100,?,?,'2026-01-01 00:00:00')`,[id,team,u]);
  for(const [id,c,owner,title] of [[101,100,30,'=2+2'],[102,100,50,'Other private Lead'],[201,200,60,'External company Lead']])
   await pool.execute(`INSERT INTO leads(id,company_id,title,status,priority,created_by_user_id,owner_user_id) VALUES(?,?,?,'cold','normal',?,?)`,[id,c,title,owner,owner]);
  for(const [id,c,owner] of [[301,100,30],[302,100,50],[401,200,60]])
   await pool.execute(`INSERT INTO accounts(id,company_id,name,email,phone,owner_user_id) VALUES(?,?,?,?,?,?)`,[id,c,`QA Account ${id}`,`acct${id}@example.test`,null,owner]);
  for(const [id,c,acct,owner] of [[311,100,301,30],[312,100,302,50],[411,200,401,60]])
   await pool.execute(`INSERT INTO contacts(id,company_id,account_id,first_name,email,owner_user_id) VALUES(?,?,?,?,?,?)`,[id,c,acct,`QA Contact ${id}`,`contact${id}@example.test`,owner]);
  console.log('PASS: Multi-company, team/private ownership, Lead, Account and Contact fixtures seeded');
  sessions=createDevSessionStore();identities=createDevIdentityStore();const tokens={};
  for(const [name,c,u,role,mode] of [
   ['owner',100,10,'OWNER','FULL'],['manager',100,20,'MANAGER','FULL'],['manager2',100,21,'MANAGER','FULL'],
   ['employee',100,30,'EMPLOYEE','FULL'],['employee2',100,40,'EMPLOYEE','FULL'],['outsider',100,50,'EMPLOYEE','FULL'],
   ['readonly',100,20,'MANAGER','READ_ONLY'],['other',200,60,'EMPLOYEE','FULL']]){
   identities.registerIdentity('phase3_'+name,{companyId:String(c),actorUserId:String(u),role,membershipStatus:'ACTIVE',accessMode:mode});
   tokens[name]=sessions.issueSession('phase3_'+name);
  }
  const factory=async()=>{const c=await pool.getConnection();return {
   execute:(q,args)=>{if(failAudit&&/INSERT\s+INTO\s+audit_logs/i.test(q))throw Error('EXPECTED_QA3_AUDIT_FAIL');return c.execute(q,args);},
   beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release(),destroy:()=>c.destroy()
  };};
  const router=express.Router();
  router.use(createGeneralTaskRouter({connectionFactory:factory}));
  router.use(createDashboardOverviewRouter({connectionFactory:factory}));
  router.use(createActivityReportRouter({connectionFactory:factory}));
  router.use(createCrmExportRouter({connectionFactory:factory}));
  router.use(createPortfolioExportRouter({connectionFactory:factory}));
  const app=createCrmApp({sessionVerifier:sessions.verifier,identityResolver:identities.resolver,protectedRoutes:router});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}/api/v1/crm`;
  async function req(who,method,path,body){const headers={};if(who)headers.Authorization=`Bearer ${tokens[who]}`;
   if(body!==undefined)headers['Content-Type']='application/json';
   const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
   const raw=await response.text();let data;try{data=JSON.parse(raw)}catch{data=raw}
   return {status:response.status,data,raw,headers:response.headers};}
  function ok(r,code=200){assert.equal(r.status,code,JSON.stringify(r.data));return r.data.data;}

  console.log('\n===== TEST GROUP 1: GENERAL TASKS =====');
  assert.equal((await req(null,'GET','/operations/tasks')).status,401);
  assert.equal((await req('employee','GET','/operations/tasks?limit=999')).status,400);
  assert.equal((await req('owner','POST','/operations/tasks',{title:'No access'})).status,403);
  assert.equal((await req('readonly','POST','/operations/tasks',{title:'No access'})).status,403);
  assert.equal((await req('employee','POST','/operations/tasks',{title:'',companyId:'200'})).status,400);
  assert.equal((await req('employee','POST','/operations/tasks',{title:'Spoof',ownerUserId:'50'})).status,404);
  assert.equal((await req('manager','POST','/operations/tasks',{title:'Wrong team',ownerUserId:'50'})).status,404);
  let r=await req('employee','POST','/operations/tasks',{title:'Call prospect',priority:'high',dueAt:'2026-12-03T09:00:00.000Z'});
  let task=ok(r,201);const id=task.id;assert.equal(task.status,'open');assert.equal(task.ownerUserId,'30');
  assert.equal((await req('outsider','GET',`/operations/tasks/${id}`)).status,404);
  assert.equal((await req('manager2','GET',`/operations/tasks/${id}`)).status,404);
  assert.equal((await req('other','GET',`/operations/tasks/${id}`)).status,404);
  assert.equal(ok(await req('manager','GET',`/operations/tasks/${id}`)).id,id);
  assert.equal(ok(await req('owner','GET',`/operations/tasks/${id}`)).id,id);
  assert.ok(ok(await req('employee','GET','/operations/tasks')).items.some(x=>x.id===id));
  assert.ok(!ok(await req('manager2','GET','/operations/tasks')).items.some(x=>x.id===id));
  assert.equal((await req('employee','PATCH',`/operations/tasks/${id}`,{title:'New title',expectedRevision:'2000-01-01T00:00:00.000000Z'})).status,409);
  r=await req('employee','PATCH',`/operations/tasks/${id}`,{title:'Call and demo',expectedRevision:task.revision});task=ok(r);
  assert.equal(task.title,'Call and demo');
  assert.equal((await req('employee','PATCH',`/operations/tasks/${id}`,{title:'Old revision',expectedRevision:'2000-01-01T00:00:00.000000Z'})).status,409);
  r=await req('employee','PATCH',`/operations/tasks/${id}/complete`,{expectedRevision:task.revision});task=ok(r);
  assert.equal(task.status,'completed');
  assert.equal((await req('employee','PATCH',`/operations/tasks/${id}/complete`,{expectedRevision:task.revision})).status,409);
  const taskRows=await sql('SELECT status,completed_at FROM tasks WHERE company_id=100 AND id=?',[id]);
  assert.equal(taskRows[0].status,'completed');assert.ok(taskRows[0].completed_at);
  const before=await num('tasks');failAudit=true;
  r=await req('employee','POST','/operations/tasks',{title:'Rollback task'});failAudit=false;
  assert.equal(r.status,500,JSON.stringify(r.data));assert.equal(await num('tasks'),before);
  r=await req('manager','POST','/operations/tasks',{title:'Assigned call',ownerUserId:'40'});
  const assigned=ok(r,201);assert.equal(assigned.ownerUserId,'40');
  assert.equal((await req('employee','GET',`/operations/tasks/${assigned.id}`)).status,404);
  assert.equal(ok(await req('employee2','GET',`/operations/tasks/${assigned.id}`)).ownerUserId,'40');
  console.log('PASS: Tasks create/list/read/update/complete, stale revisions, staff scope and SQL audit rollback');

  console.log('\n===== TEST GROUP 2: DASHBOARD + ACTIVITY REPORT =====');
  assert.equal((await req(null,'GET','/dashboard/overview')).status,401);
  assert.equal((await req('owner','GET','/dashboard/overview?companyId=200')).status,400);
  const own=ok(await req('owner','GET','/dashboard/overview'));
  assert.equal(own.scope,'company');assert.equal(own.leads.total,'2');assert.equal(own.tasks.total,'2');
  const emp=ok(await req('employee','GET','/dashboard/overview'));
  assert.equal(emp.scope,'own');assert.equal(emp.leads.total,'1');assert.equal(emp.tasks.total,'1');
  const mgr2=ok(await req('manager2','GET','/dashboard/overview'));
  assert.equal(mgr2.scope,'managed_team');assert.equal(mgr2.leads.total,'1');assert.equal(mgr2.tasks.total,'0');
  const other=ok(await req('other','GET','/dashboard/overview'));
  assert.equal(other.leads.total,'1');assert.equal(other.tasks.total,'0');
  const utcDay=new Date().toISOString().slice(0,10);
  assert.equal((await req('owner','GET','/reports/sales-activity?from=2026-02-31&to=2026-03-02')).status,400);
  assert.equal((await req('owner','GET','/reports/sales-activity?companyId=200')).status,400);
  r=await req('owner','GET',`/reports/sales-activity?from=${utcDay}&to=${utcDay}`);
  const report=ok(r);assert.equal(report.days.length,1);assert.equal(report.scope,'company');
  assert.equal(report.days[0].leads,'2');assert.equal(report.days[0].tasksCompleted,'1');
  const empReport=ok(await req('employee','GET',`/reports/sales-activity?from=${utcDay}&to=${utcDay}`));
  assert.equal(empReport.days[0].leads,'1');assert.equal(empReport.days[0].tasksCompleted,'1');
  const otherReport=ok(await req('other','GET',`/reports/sales-activity?from=${utcDay}&to=${utcDay}`));
  assert.equal(otherReport.days[0].leads,'1');assert.equal(otherReport.days[0].tasksCompleted,'0');
  console.log('PASS: Dashboard aggregates, Owner/Manager/Employee visibility, dates and daily report scope');

  console.log('\n===== TEST GROUP 3: LEAD + PORTFOLIO EXPORTS =====');
  assert.equal((await req(null,'GET','/exports/leads')).status,401);
  assert.equal((await req('employee','GET','/exports/leads?limit=800')).status,400);
  assert.equal((await req('employee','GET','/exports/leads?format=XLSX')).status,400);
  let json=await req('employee','GET','/exports/leads?format=JSON');
  assert.equal(json.status,200,JSON.stringify(json.data));assert.equal(json.data.rows.length,1);
  assert.equal(json.data.rows[0].id,'101');assert.equal(json.data.rows[0].title,'=2+2');
  assert.ok(json.headers.get('x-crm-export-job-id'));
  const ownCsv=await req('owner','GET','/exports/leads?format=CSV');
  assert.equal(ownCsv.status,200,ownCsv.raw);assert.match(ownCsv.raw,/"'=2\+2"/);
  assert.ok(!ownCsv.raw.includes('External company Lead'));
  const otherJson=await req('other','GET','/exports/leads?format=JSON');
  assert.equal(otherJson.status,200);assert.equal(otherJson.data.rows.length,1);
  assert.equal(otherJson.data.rows[0].id,'201');
  const ownJobs=ok(await req('employee','GET','/exports/jobs'));
  assert.equal(ownJobs.items.length,1);assert.equal(ownJobs.items[0].entityType,'leads');
  const beforeExport=await num('crm_export_jobs');failAudit=true;
  const failed=await req('employee','GET','/exports/leads?format=JSON');failAudit=false;
  assert.equal(failed.status,500,JSON.stringify(failed.data));assert.equal(await num('crm_export_jobs'),beforeExport);
  console.log('PASS: Lead JSON/CSV export, formula-injection protection, history, tenant scope and rollback');

  let acc=await req('employee','GET','/exports/portfolio/accounts?format=JSON');
  assert.equal(acc.status,200,JSON.stringify(acc.data));assert.equal(acc.data.rows.length,1);
  assert.equal(String(acc.data.rows[0].id),'301');
  let contacts=await req('employee','GET','/exports/portfolio/contacts?format=JSON');
  assert.equal(contacts.status,200,JSON.stringify(contacts.data));assert.equal(contacts.data.rows.length,1);
  assert.equal(String(contacts.data.rows[0].id),'311');
  const mgr2Acc=await req('manager2','GET','/exports/portfolio/accounts?format=JSON');
  assert.equal(mgr2Acc.status,200);assert.equal(mgr2Acc.data.rows.length,1);
  assert.equal(String(mgr2Acc.data.rows[0].id),'302');
  const dealExport=await req('employee','GET','/exports/portfolio/deals?format=JSON');
  assert.equal(dealExport.status,200);assert.equal(dealExport.data.rows.length,0);
  const otherAcc=await req('other','GET','/exports/portfolio/accounts?format=JSON');
  assert.equal(otherAcc.status,200);assert.equal(otherAcc.data.rows.length,1);
  assert.equal(String(otherAcc.data.rows[0].id),'401');
  const portfolioJobs=ok(await req('employee','GET','/exports/portfolio/jobs'));
  assert.equal(portfolioJobs.items.length,3);
  assert.ok(portfolioJobs.items.every(item=>['accounts','contacts','deals'].includes(item.entityType)));
  assert.equal((await req('employee','GET','/exports/portfolio/accounts?limit=800')).status,400);
  console.log('PASS: Account/Contact/Deal export, company/role isolation and actor-only job history');
  const serverText=fs.readFileSync('src/server.ts','utf8');
  for(const name of ['createGeneralTaskRouter','createDashboardOverviewRouter','createActivityReportRouter','createCrmExportRouter','createPortfolioExportRouter'])
   assert.ok(serverText.includes(name),`Missing real server mount ${name}`);
  console.log('PASS: All five APIs mounted in the normal protected CRM server');
  console.log('\n===== QA PHASE 3: ALL THREE GROUPS PASS =====');
 }finally{
  if(server)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  if(sessions)sessions.clearSessions();if(identities)identities.clearIdentities();
  if(pool)await pool.end();
  if(admin){try{if(created){assert.match(scratch,/^dgate_crm_qap3_[a-f0-9]{16}$/);await admin.query(`DROP DATABASE \`${scratch}\``);console.log('PASS: Temporary QA Phase 3 DB removed');}}finally{await admin.end();}}
 }
 console.log('PASS: dgate_crm_fresh remains unchanged');
}
main().catch(e=>{console.error('FAIL:',e?.stack||e);process.exitCode=1;});

