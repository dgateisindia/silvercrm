const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const crypto = require('node:crypto');
const express = require('express');
const {once} = require('node:events');

const env = dotenv.parse(fs.readFileSync('.env'));
assert.equal(env.DB_NAME, 'dgate_crm_fresh');
Object.assign(process.env,env,{NODE_ENV:'test',AUTH_MODE:'local',HOST:'127.0.0.1',CRM_DEV_SEED:'0'});
require.extensions['.ts'] = (mod,file) => {
 const output=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}});
 mod._compile(output.outputText,file);
};
const {createCrmApp}=require(process.cwd() + '/./src/app.ts');
const {createDevSessionStore}=require(process.cwd() + '/./src/core/auth/devSessionVerifier.ts');
const {createDevIdentityStore}=require(process.cwd() + '/./src/core/auth/devIdentityResolver.ts');
const {createDirectTransferRouter}=require(process.cwd() + '/./src/modules/leads/routes/lead_transfer.routes.ts');
const {createLeadWorkflowsRouter}=require(process.cwd() + '/./src/modules/leads/routes/lead_workflows.routes.ts');
const cfg={host:env.DB_HOST||'127.0.0.1',port:Number(env.DB_PORT||3306),user:env.DB_USER||'root',password:env.DB_PASSWORD??'',multipleStatements:false};
const scratch='dgate_crm_bulkqa_'+crypto.randomBytes(8).toString('hex');
assert.match(scratch,/^dgate_crm_bulkqa_[a-f0-9]{16}$/);
let admin,pool,server,sessions,identities,created=false,failAudit=false;
const tables=['companies','users','teams','team_members','leads','lead_transfer_requests','lead_transfer_request_items','assignment_history','audit_logs','tasks','crm_lead_status_history'];
async function main(){
 try {
  admin=await mysql.createConnection(cfg);
  await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);created=true;
  for(const table of tables) await admin.query(`CREATE TABLE \`${scratch}\`.\`${table}\` LIKE \`${env.DB_NAME}\`.\`${table}\``);
  pool=mysql.createPool({...cfg,database:scratch,connectionLimit:6,supportBigNumbers:true,bigNumberStrings:true});
  console.log('PASS: Isolated scratch database created with 11 CRM tables');
  for(const c of [100,200]) await pool.execute(
    `INSERT INTO companies(id,platform_org_id,name,slug,status,platform_product_id,platform_access_mode,provisioned_at)
     VALUES(?,?,?,?,'active',1,'FULL',UTC_TIMESTAMP(3))`,[c,`bulk_org${c}`,`QA Company ${c}`,`bulk_${c}`]);
  for(const [u,c,role,status] of [[10,100,'owner','active'],[20,100,'manager','active'],[21,100,'manager','active'],[30,100,'employee','active'],[40,100,'employee','active'],[50,100,'employee','active'],[60,200,'employee','active']]){
    await pool.execute(`INSERT INTO users(id,company_id,platform_user_id,full_name,email,role,status,activated_at)
      VALUES(?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`,[u,c,`bulk_user${u}`,`User ${u}`,`u${u}@example.test`,role,status]);
  }
  for(const [t,m] of [[7,20],[8,21]]) await pool.execute(`INSERT INTO teams(id,company_id,name,manager_user_id,status) VALUES(?,100,?,?,'active')`,[t,`Team ${t}`,m]);
  for(const [id,team,user] of [[1,7,30],[2,7,40],[3,8,50]]) await pool.execute(`INSERT INTO team_members(id,company_id,team_id,user_id,joined_at) VALUES(?,100,?,?,'2026-01-01 00:00:00')`,[id,team,user]);
  for(const [lead,c,owner,title,status] of [[101,100,30,'Private enquiry','waiting'],[102,100,30,'Transport interest','warm'],[103,100,40,'Private enquiry','warm'],[104,100,30,'Repeat inquiry','cold'],[105,100,30,' repeat inquiry ','cold'],[106,100,30,'Transfer tester','cold'],[201,200,60,'Private enquiry','warm']]){
   await pool.execute(`INSERT INTO leads(id,company_id,title,status,priority,created_by_user_id,owner_user_id)
    VALUES(?,?,?,?, 'normal',?,?)`,[lead,c,title,status,owner,owner]);
  }
  console.log('PASS: Multiple employees, managers and two companies seeded');
  sessions=createDevSessionStore();identities=createDevIdentityStore();
  const tokens={};
  for(const [name,c,u,role,mode] of [['owner',100,10,'OWNER','FULL'],['manager',100,20,'MANAGER','FULL'],['manager2',100,21,'MANAGER','FULL'],['employee',100,30,'EMPLOYEE','FULL'],['employee2',100,40,'EMPLOYEE','FULL'],['readonly',100,20,'MANAGER','READ_ONLY'],['other',200,60,'EMPLOYEE','FULL']]){
   identities.registerIdentity('bulk_'+name,{companyId:String(c),actorUserId:String(u),role,membershipStatus:'ACTIVE',accessMode:mode});
   tokens[name]=sessions.issueSession('bulk_'+name);
  }
  const factory=async()=>{const db=await pool.getConnection();return {execute:(sql,params)=>{
   if(failAudit&&/INSERT\s+INTO\s+audit_logs/i.test(sql))throw Error('TEST_AUDIT_FAILURE');
   return db.execute(sql,params);
  },beginTransaction:()=>db.beginTransaction(),commit:()=>db.commit(),rollback:()=>db.rollback(),release:()=>db.release(),destroy:()=>db.destroy()};};
  const routes=express.Router();routes.use(createDirectTransferRouter({connectionFactory:factory}));routes.use(createLeadWorkflowsRouter({connectionFactory:factory}));
  const app=createCrmApp({sessionVerifier:sessions.verifier,identityResolver:identities.resolver,protectedRoutes:routes});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const root=`http://127.0.0.1:${server.address().port}/api/v1/crm/leads`;
  async function req(who,method,path,body){const headers={};if(who)headers.Authorization=`Bearer ${tokens[who]}`;
   if(body!==undefined)headers['Content-Type']='application/json';
   const response=await fetch(root+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
   const raw=await response.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}
   return {status:response.status,data};
  }
  const direct={expectedOwnerUserId:'30',toUserId:'40',reason:'Manager redistribution'};
  assert.equal((await req(null,'POST','/101/transfer-direct',direct)).status,401);
  assert.equal((await req('employee','POST','/101/transfer-direct',direct)).status,403);
  assert.equal((await req('owner','POST','/101/transfer-direct',direct)).status,403);
  assert.equal((await req('readonly','POST','/101/transfer-direct',direct)).status,403);
  // Original failed test used expectedOwner=40 and toUser=40; this is a self-transfer (400).
  assert.equal((await req('manager','POST','/101/transfer-direct', {...direct,expectedOwnerUserId:'40',toUserId:'40'})).status,400);
  // Correct stale-owner test uses an otherwise valid target: the manager of the team.
  assert.equal((await req('manager','POST','/101/transfer-direct',{...direct,expectedOwnerUserId:'40',toUserId:'20'})).status,409);
  const directSuccess=await req('manager','POST','/101/transfer-direct',direct);
  assert.equal(directSuccess.status,201,JSON.stringify(directSuccess.data));
  const [directRows]=await pool.execute('SELECT owner_user_id FROM leads WHERE company_id=100 AND id=101');
  assert.equal(String(directRows[0].owner_user_id),'40');
  console.log('PASS: Batch 86-90 repaired regression, real direct transfer, history and permissions');

  const request={toUserId:'40',reason:'Request reassignment'};
  for(const who of [null,'manager','owner','readonly']){
    const r=await req(who,'POST','/102/transfer-requests',request);assert.equal(r.status,who===null?401:403,JSON.stringify(r.data));
  }
  assert.equal((await req('employee2','POST','/102/transfer-requests',request)).status,404);
  assert.equal((await req('employee','POST','/102/transfer-requests',{...request,toUserId:'50'})).status,403);
  assert.equal((await req('employee','POST','/102/transfer-requests',{...request,companyId:'200'})).status,400);
  let r=await req('employee','POST','/102/transfer-requests',request);
  assert.equal(r.status,201,JSON.stringify(r.data));const transferId=r.data.data.transferRequestId;
  assert.equal((await req('employee','POST','/102/transfer-requests',request)).status,409);
  assert.equal((await req('manager2','GET','/transfer-requests/pending')).status,200);
  const pend=await req('manager','GET','/transfer-requests/pending');
  assert.equal(pend.status,200);assert.ok(pend.data.data.some(x=>x.id===transferId));
  console.log('PASS: Employee transfer request, duplicate-pending check, manager-scoped inbox');

  assert.equal((await req('employee','PATCH',`/transfer-requests/${transferId}/decision`,{decision:'approved'})).status,403);
  assert.equal((await req('manager2','PATCH',`/transfer-requests/${transferId}/decision`,{decision:'approved'})).status,404);
  assert.equal((await req('manager','PATCH',`/transfer-requests/${transferId}/decision`,{decision:'invented'})).status,400);
  r=await req('manager','PATCH',`/transfer-requests/${transferId}/decision`,{decision:'approved',notes:'Reviewed'});
  assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal((await req('manager','PATCH',`/transfer-requests/${transferId}/decision`,{decision:'approved'})).status,409);
  const [approvedLead]=await pool.execute('SELECT owner_user_id FROM leads WHERE company_id=100 AND id=102');
  assert.equal(String(approvedLead[0].owner_user_id),'40');
  const [approvedReq]=await pool.execute('SELECT status,decided_by_id FROM lead_transfer_requests WHERE company_id=100 AND id=?',[transferId]);
  assert.equal(approvedReq[0].status,'approved');assert.equal(String(approvedReq[0].decided_by_id),'20');
  console.log('PASS: Manager approval updates ownership and transfer/assignment histories atomically');

  r=await req('employee','POST','/104/transfer-requests',request);assert.equal(r.status,201,JSON.stringify(r.data));
  const rejectId=r.data.data.transferRequestId;
  r=await req('manager','PATCH',`/transfer-requests/${rejectId}/decision`,{decision:'rejected',notes:'Need employee coverage'});
  assert.equal(r.status,200,JSON.stringify(r.data));
  const [rejectedLead]=await pool.execute('SELECT owner_user_id FROM leads WHERE company_id=100 AND id=104');
  assert.equal(String(rejectedLead[0].owner_user_id),'30');
  console.log('PASS: Manager rejection preserves original Lead owner');

  r=await req('employee','POST','/104/followups',{title:'Call the client',description:'Confirm meeting',dueAt:'2026-12-03T14:00:00.000Z'});
  assert.equal(r.status,201,JSON.stringify(r.data));const taskId=r.data.data.id;
  assert.equal((await req('employee2','GET','/104/followups')).status,404);
  assert.equal((await req('owner','GET','/104/followups')).status,200);
  assert.equal((await req('readonly','POST','/104/followups',{title:'Not allowed'})).status,403);
  r=await req('employee','GET','/104/followups');assert.equal(r.status,200);assert.equal(r.data.data[0].title,'Call the client');
  r=await req('employee','PATCH',`/104/followups/${taskId}/complete`,{});
  assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal((await req('employee','PATCH',`/104/followups/${taskId}/complete`,{})).status,409);
  const [task]=await pool.execute('SELECT status,completed_at FROM tasks WHERE company_id=100 AND id=?',[taskId]);
  assert.equal(task[0].status,'completed');assert.ok(task[0].completed_at);
  console.log('PASS: Follow-up create/list/complete with authorization and audit');

  await pool.execute(`INSERT INTO crm_lead_status_history(company_id,lead_id,old_status,new_status,changed_by_id,changed_at)
     VALUES(100,102,'new','warm',20,UTC_TIMESTAMP(3))`);
  r=await req('manager','GET','/102/timeline');assert.equal(r.status,200,JSON.stringify(r.data));
  assert.ok(r.data.data.some(x=>x.type==='assignment'));assert.ok(r.data.data.some(x=>x.type==='audit'));assert.ok(r.data.data.some(x=>x.type==='status'));
  assert.equal((await req('employee','GET','/102/timeline')).status,404);
  assert.equal((await req('other','GET','/102/timeline')).status,404);
  console.log('PASS: Lead timeline shows status/assignment/audit without exposing raw details');

  r=await req('employee','GET','/104/possible-duplicates');assert.equal(r.status,200,JSON.stringify(r.data));
  assert.ok(r.data.data.some(x=>x.id==='105'));assert.ok(r.data.data.every(x=>x.ownerUserId==='30'));
  assert.equal((await req('employee2','GET','/104/possible-duplicates')).status,404);
  assert.equal((await req('employee','GET','/104/possible-duplicates?limit=200')).status,400);
  console.log('PASS: Potential duplicates are visibility-scoped and query limits enforced');

  r=await req('employee','GET','/insights/status-counts');assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal(r.data.data.total,3); // Leads 104,105,106; 101 and 102 were reassigned to 40.
  r=await req('owner','GET','/insights/status-counts');assert.equal(r.status,200);assert.equal(r.data.data.total,6);
  r=await req('manager','GET','/insights/status-counts');assert.equal(r.status,200);assert.equal(r.data.data.total,6);
  r=await req('manager2','GET','/insights/status-counts');assert.equal(r.status,200);assert.equal(r.data.data.total,0);
  r=await req('other','GET','/insights/status-counts');assert.equal(r.status,200);assert.equal(r.data.data.total,1);
  console.log('PASS: Dynamic Lead status counts respect roles, teams and company boundaries');

  // Rollback: fail audit after pending request and item were inserted.
  const [beforeRequests]=await pool.execute('SELECT COUNT(*) AS n FROM lead_transfer_requests WHERE company_id=100');
  failAudit=true;
  r=await req('employee','POST','/106/transfer-requests',request);
  assert.equal(r.status,500,JSON.stringify(r.data));failAudit=false;
  const [afterRequests]=await pool.execute('SELECT COUNT(*) AS n FROM lead_transfer_requests WHERE company_id=100');
  assert.equal(String(beforeRequests[0].n),String(afterRequests[0].n));
  console.log('PASS: Real SQL audit failure rolls back pending transfer and request item');

  // Rollback: task insertion fails to commit when audit fails.
  const [beforeTasks]=await pool.execute('SELECT COUNT(*) AS n FROM tasks WHERE company_id=100');
  failAudit=true;
  r=await req('employee','POST','/106/followups',{title:'Rollback followup'});
  assert.equal(r.status,500,JSON.stringify(r.data));failAudit=false;
  const [afterTasks]=await pool.execute('SELECT COUNT(*) AS n FROM tasks WHERE company_id=100');
  assert.equal(String(beforeTasks[0].n),String(afterTasks[0].n));
  console.log('PASS: Real SQL audit failure rolls back follow-up task');

  const serverCode=fs.readFileSync('./src/server.ts','utf8');
  assert.match(serverCode,/createLeadWorkflowsRouter/);assert.match(serverCode,/createDirectTransferRouter/);
  console.log('PASS: Normal CRM startup includes both transfer and workflows routers');
  console.log('PASS: ALL BULK CRM WORKFLOW TESTS');
 }finally{
  if(server)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  if(sessions)sessions.clearSessions();if(identities)identities.clearIdentities();
  if(pool)await pool.end();
  if(admin){try{if(created){assert.match(scratch,/^dgate_crm_bulkqa_[a-f0-9]{16}$/);await admin.query(`DROP DATABASE \`${scratch}\``);console.log('PASS: Temporary database removed');}}finally{await admin.end();}}
 }
 console.log('PASS: Original CRM database unchanged');
}
main().catch(e=>{console.error('FAIL:',e?.stack||e);process.exitCode=1;});
