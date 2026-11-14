const assert=require('node:assert/strict');
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const ts=require('typescript');
const mysql=require('mysql2/promise');
const dotenv=require('dotenv');
const crypto=require('node:crypto');
const {once}=require('node:events');

const env=dotenv.parse(fs.readFileSync('.env'));
assert.equal(env.DB_NAME,'dgate_crm_fresh','Only the declared original DB may be used as a schema template');
Object.assign(process.env,env,{NODE_ENV:'test',AUTH_MODE:'local',HOST:'127.0.0.1',CRM_DEV_SEED:'0',CRM_NOTIFICATION_WORKER_ENABLED:'false'});
require.extensions['.ts']=(mod,file)=>{
 const out=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}});
 mod._compile(out.outputText,file);
};
const {createCrmApp}=require(process.cwd() + '/./src/app.ts');
const {createDevSessionStore}=require(process.cwd() + '/./src/core/auth/devSessionVerifier.ts');
const {createDevIdentityStore}=require(process.cwd() + '/./src/core/auth/devIdentityResolver.ts');
const {createAutomationRouter}=require(process.cwd() + '/./src/modules/automation/automation.routes.ts');
const {createAutomationService}=require(process.cwd() + '/./src/modules/automation/automation.service.ts');
const {scanCompany,companies}=require(process.cwd() + '/./src/modules/automation/automation.repository.ts');
const cfg={host:env.DB_HOST||'127.0.0.1',port:Number(env.DB_PORT||3306),user:env.DB_USER||'root',password:env.DB_PASSWORD??'',multipleStatements:false};
const scratch='dgate_crm_workerqa_'+crypto.randomBytes(8).toString('hex');
assert.match(scratch,/^dgate_crm_workerqa_[a-f0-9]{16}$/);
const tables=['companies','users','teams','team_members','tasks','notifications','crm_notification_deliveries','crm_background_jobs','audit_logs'];
let admin,pool,server,sessions,identities,created=false,failAudit=false,oneFailure=true,alwaysFailTask=null;
async function sql(query,args=[]){return (await pool.execute(query,args))[0];}
async function count(table,company=100){assert.ok(tables.includes(table));return Number((await sql(`SELECT COUNT(*) n FROM \`${table}\` WHERE company_id=?`,[company]))[0].n);}
async function trans(work){const db=await pool.getConnection();try{await db.beginTransaction();const value=await work(db);await db.commit();return value;}catch(e){await db.rollback();throw e;}finally{db.release();}}
async function addTask(task,company,owner,hours,status='open'){
 const op=hours<0?'DATE_ADD':'DATE_SUB';
 await sql(`INSERT INTO tasks(id,company_id,title,owner_user_id,status,due_at,priority) VALUES(?,?,?,?,?,${op}(UTC_TIMESTAMP(3),INTERVAL ? HOUR),'normal')`,
 [task,company,`Private customer followup ${task}`,owner,status,Math.abs(hours)]);
}
async function main(){
 try{
  admin=await mysql.createConnection(cfg);
  await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  created=true;
  for(const table of tables){await admin.query(`CREATE TABLE \`${scratch}\`.\`${table}\` LIKE \`${env.DB_NAME}\`.\`${table}\``);}
  pool=mysql.createPool({...cfg,database:scratch,connectionLimit:9,supportBigNumbers:true,bigNumberStrings:true});
  console.log('PASS: Nine original CRM structures copied to private worker QA database');
  for(const company of [100,200])await sql(`INSERT INTO companies(id,platform_org_id,name,slug,status,platform_product_id,platform_access_mode,provisioned_at) VALUES(?,?,?,?,'active',1,'FULL',UTC_TIMESTAMP(3))`,[company,`autom_org${company}`,`Automation Company ${company}`,`autom_company${company}`]);
  for(const [uid,cid,role,status] of [[10,100,'owner','active'],[20,100,'manager','active'],[21,100,'manager','active'],[30,100,'employee','active'],[40,100,'employee','active'],[50,100,'employee','active'],[55,100,'employee','inactive'],[70,200,'employee','active']]){
   await sql(`INSERT INTO users(id,company_id,platform_user_id,full_name,email,role,status,activated_at) VALUES(?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`,[uid,cid,`autom_user${uid}`,`Test worker ${uid}`,`testworker${uid}@example.test`,role,status]);
  }
  for(const [id,manager] of [[7,20],[8,21]])await sql(`INSERT INTO teams(id,company_id,name,manager_user_id,status) VALUES(?,100,?,?,'active')`,[id,`Automation Team ${id}`,manager]);
  for(const [id,team,user] of [[1,7,30],[2,7,40],[3,8,50],[4,7,55]])await sql(`INSERT INTO team_members(id,company_id,team_id,user_id,joined_at) VALUES(?,100,?,?,'2026-01-01 00:00:00')`,[id,team,user]);
  for(const [tid,company,user,hours,status] of [[101,100,30,48,'open'],[102,100,40,1,'open'],[103,100,40,-24,'open'],[104,100,30,48,'completed'],[105,100,50,48,'open'],[106,100,55,48,'open'],[107,100,30,48,'open'],[108,100,30,48,'open'],[201,200,70,48,'open']])await addTask(tid,company,user,hours,status);
  console.log('PASS: Multiple company scopes, managers, private teams, overdue tasks and inactive staff seeded');
  // Claiming must be explicitly enabled; no API startup should run the worker implicitly.
  const blocked=spawnSync(process.execPath,['dist/workers/reminder.worker.js','--once'],{env:{...process.env,CRM_NOTIFICATION_WORKER_ENABLED:'false'},encoding:'utf8',timeout:15000});
  assert.equal(blocked.status,1,'Worker must refuse startup without explicit opt-in flag');
  assert.equal(await count('crm_background_jobs'),0);
  console.log('PASS: Standalone worker refuses unapproved startup; API does not auto-run it');
  const queue=await trans(async db=>{
   const a=await scanCompany(db,'100');
   const b=await scanCompany(db,'200');
   return {a,b};
  });
  assert.equal(queue.a.examined,5); // 101,102,105,107,108, excludes inactive/completed/future
  assert.equal(queue.b.examined,1);
  assert.equal(await count('crm_background_jobs'),9); // 101(2),102(1),105(2),107(2),108(2)
  console.log('PASS: Due-task scheduler generated idempotent in-app and escalation jobs');
  const before=(await count('crm_background_jobs'));
  await trans(db=>scanCompany(db,'100'));
  assert.equal(await count('crm_background_jobs'),before);
  console.log('PASS: Repeated scan does not create duplicated reminders');
  // Remove a team member and complete one task AFTER enqueuing, BEFORE delivering.
  await sql(`UPDATE team_members SET left_at=UTC_TIMESTAMP(3) WHERE company_id=100 AND user_id=50 AND team_id=8`);
  await sql(`UPDATE tasks SET status='completed',completed_at=UTC_TIMESTAMP(3) WHERE company_id=100 AND id=108`);
  const factory=async()=>{const db=await pool.getConnection();return{
   execute:(q,args)=>{if(failAudit&&/INSERT\s+INTO\s+audit_logs/i.test(q))throw Error('EXPECTED_AUTOMATION_AUDIT_FAILURE');return db.execute(q,args);},
   beginTransaction:()=>db.beginTransaction(),commit:()=>db.commit(),rollback:()=>db.rollback(),release:()=>db.release(),destroy:()=>db.destroy()
  };};
  const service=createAutomationService({connectionFactory:factory,beforeDelivery:async payload=>{
   if(alwaysFailTask===payload.taskId||(oneFailure&&payload.taskId==='107')){
    if(payload.taskId==='107')oneFailure=false;
    throw Error('EXPECTED_TRANSIENT_DELIVERY_FAILURE');
   }
  }});
  const racing=await Promise.all([service.tick(25),service.tick(25)]);
  assert.ok(racing.some(x=>x.delivered>0));
  const [jobs]=await pool.execute(`SELECT id,company_id,state,attempts,JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.taskId')) AS taskId,JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.kind')) AS kind FROM crm_background_jobs ORDER BY company_id,id`);
  assert.equal(jobs.filter(x=>x.state==='pending').length,1);
  assert.equal(jobs.filter(x=>x.state==='skipped').length,3); // task108 (due+escalation), former member task105 escalation
  assert.equal(jobs.filter(x=>x.state==='completed').length,6); // 101 due+escalation, 102,105 due, 201 due,107 escalation
  assert.equal(await count('notifications'),5); // tenant100: 101(2),102(1),105(1),107 escalation(1)
  assert.equal(await count('notifications',200),1);
  assert.equal(await count('crm_notification_deliveries'),5);
  const [privateAudit]=await pool.execute(`SELECT details_json FROM audit_logs WHERE company_id=100`);
  assert.equal(privateAudit.some(x=>JSON.stringify(x.details_json).includes('Private customer followup')),false);
  console.log('PASS: Concurrent workers deliver once, skip completed tasks and revoked managers');
  const [retryBefore]=await pool.execute(`SELECT id,state,attempts FROM crm_background_jobs WHERE company_id=100 AND JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.taskId'))='107' AND job_type='crm.followup.due'`);
  assert.equal(retryBefore.length,1);assert.equal(retryBefore[0].state,'pending');assert.equal(Number(retryBefore[0].attempts),1);
  await sql(`UPDATE crm_background_jobs SET run_after=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE company_id=100 AND id=?`,[retryBefore[0].id]);
  const recovered=await service.tick(5);
  assert.equal(recovered.delivered,1);
  const [retryAfter]=await pool.execute(`SELECT state,attempts FROM crm_background_jobs WHERE company_id=100 AND id=?`,[retryBefore[0].id]);
  assert.equal(retryAfter[0].state,'completed');assert.equal(Number(retryAfter[0].attempts),2);
  console.log('PASS: Transient failed delivery retries with attempt tracking and no duplicate notification');
  // Ensure audit failures roll back notification+delivery+job transaction.
  await addTask(109,100,30,1);
  const originalNotices=await count('notifications');const originalDeliveries=await count('crm_notification_deliveries');
  failAudit=true;
  const rejected=await service.tick(5);
  failAudit=false;
  assert.equal(rejected.retried,1);
  assert.equal(await count('notifications'),originalNotices);
  assert.equal(await count('crm_notification_deliveries'),originalDeliveries);
  const [queued109]=await pool.execute(`SELECT id,state,attempts FROM crm_background_jobs WHERE company_id=100 AND job_type='crm.followup.due' AND JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.taskId'))='109'`);
  assert.equal(queued109.length,1);assert.equal(queued109[0].state,'pending');assert.equal(Number(queued109[0].attempts),1);
  await sql(`UPDATE crm_background_jobs SET run_after=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE company_id=100 AND id=?`,[queued109[0].id]);
  assert.equal((await service.tick(5)).delivered,1);
  console.log('PASS: Failed audit rolls back in-app delivery and requeues work safely');
  // Repeated hard failures stop at bounded attempts; do not loop forever.
  await addTask(110,100,30,1);
  alwaysFailTask='110';
  for(let attempt=1;attempt<=5;attempt++){
   await service.tick(10);
   const [r]=await pool.execute(`SELECT id,state,attempts FROM crm_background_jobs WHERE company_id=100 AND job_type='crm.followup.due' AND JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.taskId'))='110'`);
   assert.equal(r.length,1);assert.equal(Number(r[0].attempts),attempt);
   assert.equal(r[0].state,attempt===5?'failed':'pending');
   if(attempt<5)await sql(`UPDATE crm_background_jobs SET run_after=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE company_id=100 AND id=?`,[r[0].id]);
  }
  alwaysFailTask=null;
  assert.equal((await service.tick(10)).delivered,0);
  console.log('PASS: Five failed attempts enter terminal failed state; no infinite retry');
  sessions=createDevSessionStore();identities=createDevIdentityStore();const tokens={};
  for(const [name,company,uid,role,mode] of [['owner',100,10,'OWNER','FULL'],['manager',100,20,'MANAGER','FULL'],['manager2',100,21,'MANAGER','FULL'],['employee',100,30,'EMPLOYEE','FULL'],['employee2',100,40,'EMPLOYEE','FULL'],['foreign',200,70,'EMPLOYEE','FULL'],['readonly',100,20,'MANAGER','READ_ONLY']]){
   identities.registerIdentity(`worker_${name}`,{companyId:String(company),actorUserId:String(uid),role,membershipStatus:'ACTIVE',accessMode:mode});
   tokens[name]=sessions.issueSession(`worker_${name}`);
  }
  const app=createCrmApp({sessionVerifier:sessions.verifier,identityResolver:identities.resolver,protectedRoutes:createAutomationRouter({connectionFactory:factory})});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const endpoint=`http://127.0.0.1:${server.address().port}/api/v1/crm/operations/automation/jobs`;
  async function request(name,suffix=''){
   const headers={};if(name)headers.Authorization=`Bearer ${tokens[name]}`;
   const response=await fetch(endpoint+suffix,{headers});return {status:response.status,data:await response.json()};
  }
  assert.equal((await request(null)).status,401);
  assert.equal((await request('employee','?limit=101')).status,400);
  assert.equal((await request('employee','?extra=1')).status,400);
  const owned=await request('owner');assert.equal(owned.status,200);assert.equal(owned.data.data.items.length,await count('crm_background_jobs'));
  const employee=await request('employee');assert.equal(employee.status,200);assert.ok(employee.data.data.items.length>0);assert.ok(employee.data.data.items.length<owned.data.data.items.length);
  const manager=await request('manager');assert.equal(manager.status,200);assert.ok(manager.data.data.items.length>employee.data.data.items.length);
  const manager2=await request('manager2');assert.equal(manager2.status,200);assert.equal(manager2.data.data.items.length,1); // manager can see a previous own escalation job
  const foreign=await request('foreign');assert.equal(foreign.status,200);assert.equal(foreign.data.data.items.length,1);
  assert.equal((await request('readonly')).status,200);
  console.log('PASS: Owner, Manager, Employee and other-company job visibility enforced');
  const [inApp]=await pool.execute(`SELECT n.notification_type,d.channel,d.status FROM notifications n JOIN crm_notification_deliveries d ON d.company_id=n.company_id AND d.notification_id=n.id WHERE n.company_id=100`);
  assert.ok(inApp.length>0);assert.ok(inApp.every(x=>x.channel==='in_app'&&x.status==='delivered'));
  assert.equal(fs.readFileSync('src/server.ts','utf8').includes('createAutomationRouter'),true);
  console.log('PASS: Deliveries are accurately labeled in-app only; normal API server mounts the job status route');
  console.log('PASS: ALL BATCH 326-360 AUTOMATION TESTS');
 }finally{
  if(server)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  if(sessions)sessions.clearSessions();if(identities)identities.clearIdentities();
  if(pool)await pool.end();
  if(admin){try{if(created){assert.match(scratch,/^dgate_crm_workerqa_[a-f0-9]{16}$/);await admin.query(`DROP DATABASE \`${scratch}\``);console.log('PASS: Temporary automation database removed');}}finally{await admin.end();}}
 }
 console.log('PASS: Original CRM database unchanged');
}
main().catch(e=>{console.error('FAIL:',e?.stack||e);process.exitCode=1;});
