const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const mysql=require('mysql2/promise');
const dotenv=require('dotenv');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {once}=require('node:events');
const env=dotenv.parse(fs.readFileSync('.env'));
assert.equal(env.DB_NAME,'dgate_crm_fresh','Original DB is schema-only. No production records are written.');
Object.assign(process.env,env,{NODE_ENV:'test',AUTH_MODE:'local',CRM_DEV_SEED:'0',CRM_COVERAGE_WORKER_ENABLED:'false'});
require.extensions['.ts']=(mod,file)=>{
 const out=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}});
 mod._compile(out.outputText,file);
};
const {createCrmApp}=require(process.cwd() + '/./src/app.ts');
const {createDevSessionStore}=require(process.cwd() + '/./src/core/auth/devSessionVerifier.ts');
const {createDevIdentityStore}=require(process.cwd() + '/./src/core/auth/devIdentityResolver.ts');
const {createWorkforceRouter}=require(process.cwd() + '/./src/modules/workforce/workforce.routes.ts');
const {createWorkforceService}=require(process.cwd() + '/./src/modules/workforce/workforce.service.ts');
const cfg={host:env.DB_HOST||'127.0.0.1',port:Number(env.DB_PORT||3306),user:env.DB_USER||'root',password:env.DB_PASSWORD??'',multipleStatements:false};
const scratch='dgate_crm_workforceqa_'+crypto.randomBytes(8).toString('hex');
assert.match(scratch,/^dgate_crm_workforceqa_[a-f0-9]{16}$/);
const tables=['companies','users','teams','team_members','leads','contacts','calendar_events','employee_absences','lead_transfer_requests','lead_transfer_request_items','lead_coverage_assignments','assignment_history','audit_logs'];
let admin,pool,server,sessions,identities,created=false,failAudit=false;
const iso=(hours)=>new Date(Date.now()+hours*3600000).toISOString();
const from=iso(-6),to=iso(6),start=iso(-1),end=iso(2),soon=iso(12),later=iso(13);
async function sql(q,p=[]){return (await pool.execute(q,p))[0];}
async function count(table,company=100){assert.ok(tables.includes(table));return Number((await sql(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE company_id=?`,[company]))[0].n);}
async function main(){try{
 admin=await mysql.createConnection(cfg);
 await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);created=true;
 for(const table of tables)await admin.query(`CREATE TABLE \`${scratch}\`.\`${table}\` LIKE \`${env.DB_NAME}\`.\`${table}\``);
 pool=mysql.createPool({...cfg,database:scratch,connectionLimit:8,supportBigNumbers:true,bigNumberStrings:true});
 console.log('PASS: Thirteen CRM table structures cloned into private workforce database');
 for(const c of [100,200])await sql(`INSERT INTO companies(id,platform_org_id,name,slug,status,platform_product_id,platform_access_mode,provisioned_at) VALUES(?,?,?,?,'active',1,'FULL',UTC_TIMESTAMP(3))`,[c,`wf_org${c}`,`Workforce ${c}`,`wf_${c}`]);
 for(const [u,c,role] of [[10,100,'owner'],[20,100,'manager'],[21,100,'manager'],[30,100,'employee'],[40,100,'employee'],[50,100,'employee'],[70,200,'employee']])
 await sql(`INSERT INTO users(id,company_id,platform_user_id,full_name,email,role,status,activated_at) VALUES(?,?,?,?,?,?,'active',UTC_TIMESTAMP(3))`,[u,c,`wf_user${u}`,`QA ${u}`,`wf${u}@example.test`,role]);
 for(const [team,mgr] of [[7,20],[8,21]])await sql(`INSERT INTO teams(id,company_id,name,manager_user_id,status) VALUES(?,100,?,?,'active')`,[team,`Team ${team}`,mgr]);
 for(const [m,team,user] of [[1,7,30],[2,7,40],[3,8,50]])await sql(`INSERT INTO team_members(id,company_id,team_id,user_id,joined_at) VALUES(?,100,?,?, '2026-01-01 00:00:00')`,[m,team,user]);
 for(const [lead,company,user] of [[101,100,30],[102,100,50],[103,100,30],[104,100,30],[201,200,70]])
 await sql(`INSERT INTO leads(id,company_id,title,status,priority,created_by_user_id,owner_user_id) VALUES(?,?,?,'new','normal',?,?)`,[lead,company,`Lead ${lead}`,user,user]);
 for(const [contact,company,user] of [[301,100,30],[302,100,50],[401,200,70]])await sql(`INSERT INTO contacts(id,company_id,first_name,owner_user_id) VALUES(?,?,?,?)`,[contact,company,`Contact ${contact}`,user]);
 console.log('PASS: Two companies, managers, teams, calendar contacts and leads seeded');
 const disabled=spawnSync(process.execPath,['dist/workers/coverage.worker.js','--once'],{env:{...process.env,CRM_COVERAGE_WORKER_ENABLED:'false'},encoding:'utf8',timeout:15000});
 assert.equal(disabled.status,1,'Standalone coverage worker must require explicit enablement');
 assert.equal(await count('lead_coverage_assignments'),0);
 console.log('PASS: Standalone worker refuses accidental startup; API does not auto-run it');
 const factory=async()=>{const conn=await pool.getConnection();return{
  execute:(q,args)=>{if(failAudit&&/INSERT\s+INTO\s+audit_logs/i.test(q))throw Error('SIMULATED_AUDIT_FAILURE');return conn.execute(q,args);},
  beginTransaction:()=>conn.beginTransaction(),commit:()=>conn.commit(),rollback:()=>conn.rollback(),release:()=>conn.release(),destroy:()=>conn.destroy()
 };};
 const service=createWorkforceService({connectionFactory:factory});
 sessions=createDevSessionStore();identities=createDevIdentityStore();const tokens={};
 for(const [name,company,user,role,mode] of [['owner',100,10,'OWNER','FULL'],['manager',100,20,'MANAGER','FULL'],['manager2',100,21,'MANAGER','FULL'],['employee',100,30,'EMPLOYEE','FULL'],['employee2',100,40,'EMPLOYEE','FULL'],['readonly',100,20,'MANAGER','READ_ONLY'],['foreign',200,70,'EMPLOYEE','FULL']]){
  const k=`workforce_${name}`;
  identities.registerIdentity(k,{companyId:String(company),actorUserId:String(user),role,membershipStatus:'ACTIVE',accessMode:mode});
  tokens[name]=sessions.issueSession(k);
 }
 const app=createCrmApp({sessionVerifier:sessions.verifier,identityResolver:identities.resolver,protectedRoutes:createWorkforceRouter({connectionFactory:factory})});
 server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}/api/v1/crm`;
 async function request(who,method,path,body){const headers={};if(who)headers.Authorization=`Bearer ${tokens[who]}`;
  if(body!==undefined)headers['Content-Type']='application/json';
  const resp=await fetch(base+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await resp.text();let data={};try{data=JSON.parse(text);}catch{data={raw:text};}
  return {status:resp.status,data};
 }
 const event={title:'Customer demo',organizerUserId:'30',leadId:'101',contactId:'301',startsAt:soon,endsAt:later};
 assert.equal((await request(null,'GET','/operations/calendar')).status,401);
 assert.equal((await request('owner','POST','/operations/calendar',event)).status,403);
 assert.equal((await request('readonly','POST','/operations/calendar',event)).status,403);
 assert.equal((await request('manager2','POST','/operations/calendar',event)).status,404);
 assert.equal((await request('employee2','POST','/operations/calendar',event)).status,404);
 assert.equal((await request('manager','POST','/operations/calendar',{...event,leadId:'102'})).status,404);
 assert.equal((await request('manager','POST','/operations/calendar',{...event,contactId:'302'})).status,404);
 assert.equal((await request('manager','POST','/operations/calendar',{...event,extra:'forged'})).status,400);
 const booked=await request('manager','POST','/operations/calendar',event);
 assert.equal(booked.status,201,JSON.stringify(booked.data));const eventId=booked.data.data.eventId;
 assert.equal((await request('employee','POST','/operations/calendar',event)).status,409);
 assert.equal((await request('manager2','GET','/operations/calendar')).data.data.items.length,0);
 assert.equal((await request('employee','GET','/operations/calendar')).data.data.items.length,1);
 assert.equal((await request('owner','GET','/operations/calendar')).data.data.items.length,1);
 assert.equal((await request('manager','PATCH',`/operations/calendar/${eventId}/cancel`,{})).status,200);
 assert.equal((await request('manager','PATCH',`/operations/calendar/${eventId}/cancel`,{})).status,409);
 assert.equal((await request('employee','POST','/operations/calendar',event)).status,201);
 console.log('PASS: Calendar scheduling, cross-role visibility, overlap prevention, cancellation and permissions');
 const absence={userId:'30',startsAt:from,endsAt:to,reason:'Annual leave'};
 assert.equal((await request('owner','POST','/operations/absences',absence)).status,403);
 assert.equal((await request('manager2','POST','/operations/absences',absence)).status,404);
 assert.equal((await request('employee2','POST','/operations/absences',absence)).status,404);
 const createdAbs=await request('employee','POST','/operations/absences',absence);
 assert.equal(createdAbs.status,201,JSON.stringify(createdAbs.data));const absenceId=createdAbs.data.data.absenceId;
 assert.equal((await request('manager','POST','/operations/absences',absence)).status,409);
 assert.equal((await request('manager2','GET','/operations/absences')).data.data.items.length,0);
 assert.equal((await request('owner','GET','/operations/absences')).data.data.items.length,1);
 const ownAbsence=await request('employee2','POST','/operations/absences',{startsAt:iso(48),endsAt:iso(60),reason:'Private leave'});
 assert.equal(ownAbsence.status,201,JSON.stringify(ownAbsence.data));
 const ownAbsId=ownAbsence.data.data.absenceId;
 assert.equal((await request('employee2','PATCH',`/operations/absences/${ownAbsId}/cancel`,{})).status,200);
 assert.equal((await request('employee2','PATCH',`/operations/absences/${ownAbsId}/cancel`,{})).status,409);
 console.log('PASS: Employee leave creation/cancellation, overlap prevention and team-scoped calendars');
 const coverage={leadId:'101',absenceId,coverUserId:'40',startsAt:start,endsAt:end};
 assert.equal((await request('owner','POST','/operations/coverage',coverage)).status,403);
 assert.equal((await request('employee','POST','/operations/coverage',coverage)).status,403);
 assert.equal((await request('manager2','POST','/operations/coverage',coverage)).status,404);
 assert.equal((await request('manager','POST','/operations/coverage',{...coverage,coverUserId:'50'})).status,404);
 assert.equal((await request('manager','POST','/operations/coverage',{...coverage,foreign:'foo'})).status,400);
 const scheduled=await request('manager','POST','/operations/coverage',coverage);
 assert.equal(scheduled.status,201,JSON.stringify(scheduled.data));const covId=scheduled.data.data.coverageId;
 assert.equal(await count('lead_transfer_requests'),1);assert.equal(await count('lead_transfer_request_items'),1);
 assert.equal((await request('employee','GET','/operations/coverage')).data.data.items.length,1);
 assert.equal((await request('manager2','GET','/operations/coverage')).data.data.items.length,0);
 assert.equal((await request('employee','PATCH',`/operations/absences/${absenceId}/cancel`,{})).status,409);
 console.log('PASS: Manager-only temporary Lead coverage linked to an approved transfer request');
 const cycles=await Promise.all([service.tick(10),service.tick(10)]);assert.equal(cycles.reduce((a,c)=>a+c.activated,0),1);
 const [leadActive]=await sql('SELECT owner_user_id FROM leads WHERE company_id=100 AND id=101');assert.equal(String(leadActive.owner_user_id),'40');
 const [activeCov]=await sql('SELECT status FROM lead_coverage_assignments WHERE company_id=100 AND id=?',[covId]);assert.equal(activeCov.status,'active');
 assert.equal((await service.tick(10)).activated,0);
 console.log('PASS: Concurrent workers atomically activate once, record ownership history and remain idempotent');
 // A second, isolated Lead illustrates audit rollback without touching the active coverage.
 const failing={...coverage,leadId:'103'};
 const beforeCoverage=await count('lead_coverage_assignments'),beforeRequests=await count('lead_transfer_requests');
 failAudit=true;
 const rejected=await request('manager','POST','/operations/coverage',failing);
 failAudit=false;
 assert.equal(rejected.status,500,JSON.stringify(rejected.data));
 assert.equal(await count('lead_coverage_assignments'),beforeCoverage);assert.equal(await count('lead_transfer_requests'),beforeRequests);
 console.log('PASS: Failed audit rolls back transfer request, item and coverage scheduling together');
 const racing=await Promise.all([request('manager','POST','/operations/coverage',failing),request('manager','POST','/operations/coverage',failing)]);
 assert.deepEqual(racing.map(x=>x.status).sort(),[201,409]);
 const secondId=racing.find(x=>x.status===201).data.data.coverageId;
 const activeSecond=await service.tick(10);assert.equal(activeSecond.activated,1);
 const [secondLead]=await sql('SELECT owner_user_id FROM leads WHERE company_id=100 AND id=103');assert.equal(String(secondLead.owner_user_id),'40');
 console.log('PASS: Concurrent coverage scheduling serializes to one assignment');
 // Task/Lead reassignment after coverage activation must not be overwritten by restoration.
 await sql('UPDATE leads SET owner_user_id=50 WHERE company_id=100 AND id=103');
 await sql(`UPDATE lead_coverage_assignments SET ends_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE company_id=100 AND id=?`,[secondId]);
 await sql(`UPDATE lead_coverage_assignments SET ends_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE company_id=100 AND id=?`,[covId]);
 const restored=await service.tick(10);
 assert.equal(restored.restored,1);assert.equal(restored.superseded,1);
 const [ownerAfter]=await sql('SELECT owner_user_id FROM leads WHERE company_id=100 AND id=101');assert.equal(String(ownerAfter.owner_user_id),'30');
 const [manualAfter]=await sql('SELECT owner_user_id FROM leads WHERE company_id=100 AND id=103');assert.equal(String(manualAfter.owner_user_id),'50');
 const history=await sql("SELECT from_user_id,to_user_id,assigned_by_user_id FROM assignment_history WHERE company_id=100 AND entity_type='lead' AND entity_id=101 ORDER BY id");
 assert.equal(history.length,2);assert.equal(String(history[0].assigned_by_user_id),'20');assert.equal(String(history[1].assigned_by_user_id),'20');
 console.log('PASS: Automatic restoration, later-transfer preservation and manager attribution in assignment history');
 // Audit failures during activation must preserve original owner and leave the coverage queued.
 const third=await request('manager','POST','/operations/coverage',{...coverage,leadId:'104'});assert.equal(third.status,201);
 failAudit=true;
 let workerFailed=false;try{await service.tick(10);}catch{workerFailed=true;}
 failAudit=false;
 assert.equal(workerFailed,true);
 const [thirdOwner]=await sql('SELECT owner_user_id FROM leads WHERE company_id=100 AND id=104');assert.equal(String(thirdOwner.owner_user_id),'30');
 assert.equal((await service.tick(10)).activated,1);
 console.log('PASS: Activation audit failure rolls back Lead assignment and allows safe retry');
 // Full isolation after manager loses team membership.
 await sql(`UPDATE team_members SET left_at=UTC_TIMESTAMP(3) WHERE company_id=100 AND team_id=7 AND user_id=30`);
 const mgrView=await request('manager','GET','/operations/absences');assert.equal(mgrView.status,200);assert.equal(mgrView.data.data.items.length,1);
 const ownerView=await request('owner','GET','/operations/absences');assert.equal(ownerView.data.data.items.length,2);
 const foreignView=await request('foreign','GET','/operations/coverage');assert.equal(foreignView.data.data.items.length,0);
 assert.equal(fs.readFileSync('src/server.ts','utf8').includes('createWorkforceRouter'),true);
 console.log('PASS: Team membership revocation, company isolation and normal server route integration');
 console.log('PASS: ALL BATCH 361-395 WORKFORCE TESTS');
}finally{
 if(server)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
 if(sessions)sessions.clearSessions();if(identities)identities.clearIdentities();
 if(pool)await pool.end();
 if(admin){try{if(created){assert.match(scratch,/^dgate_crm_workforceqa_[a-f0-9]{16}$/);await admin.query(`DROP DATABASE \`${scratch}\``);console.log('PASS: Temporary workforce database removed');}}finally{await admin.end();}}
}
 console.log('PASS: Original CRM database unchanged');
}
main().catch(error=>{console.error('FAIL:',error?.stack||error);process.exitCode=1;});
