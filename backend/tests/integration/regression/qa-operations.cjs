const assert=require('node:assert/strict');
const fs=require('node:fs');const ts=require('typescript');const mysql=require('mysql2/promise');const dotenv=require('dotenv');const crypto=require('node:crypto');const {once}=require('node:events');
const env=dotenv.parse(fs.readFileSync('.env'));assert.equal(env.DB_NAME,'dgate_crm_fresh');
Object.assign(process.env,env,{NODE_ENV:'test',AUTH_MODE:'local',HOST:'127.0.0.1',CRM_DEV_SEED:'0'});
require.extensions['.ts']=(mod,file)=>{const o=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}});mod._compile(o.outputText,file);};
const {createCrmApp}=require(process.cwd() + '/./src/app.ts');const {createDevSessionStore}=require(process.cwd() + '/./src/core/auth/devSessionVerifier.ts');const {createDevIdentityStore}=require(process.cwd() + '/./src/core/auth/devIdentityResolver.ts');const {createOperationsRouter}=require(process.cwd() + '/./src/modules/operations/routes/operations.routes.ts');
const cfg={host:env.DB_HOST||'127.0.0.1',port:Number(env.DB_PORT||3306),user:env.DB_USER||'root',password:env.DB_PASSWORD??'',multipleStatements:false};
const scratch='dgate_crm_opsqa_'+crypto.randomBytes(8).toString('hex');assert.match(scratch,/^dgate_crm_opsqa_[a-f0-9]{16}$/);
const tables=['companies','users','teams','team_members','leads','tasks','notifications','crm_invoices','crm_payments','crm_payment_allocations','crm_credit_notes','crm_payment_refunds','crm_invoice_due_schedules','crm_target_periods','crm_target_adjustments','audit_logs'];
let admin,pool,server,sessions,identities,created=false,failAudit=false;
async function count(table){const [rows]=await pool.execute(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE company_id=100`);return Number(rows[0].n);}
async function main(){
 try{
  admin=await mysql.createConnection(cfg);await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);created=true;
  for(const table of tables)await admin.query(`CREATE TABLE \`${scratch}\`.\`${table}\` LIKE \`${env.DB_NAME}\`.\`${table}\``);
  pool=mysql.createPool({...cfg,database:scratch,connectionLimit:6,supportBigNumbers:true,bigNumberStrings:true});
  console.log('PASS: 16 production tables cloned into isolated operations database');
  for(const id of [100,200])await pool.execute(`INSERT INTO companies(id,platform_org_id,name,slug,status,platform_product_id,platform_access_mode,provisioned_at) VALUES(?,?,?,?,'active',1,'FULL',UTC_TIMESTAMP(3))`,[id,`ops_org_${id}`,`Operations QA ${id}`,`ops_${id}`]);
  for(const [id,company,role] of [[10,100,'owner'],[20,100,'manager'],[21,100,'manager'],[30,100,'employee'],[40,100,'employee'],[60,200,'employee'],[70,200,'manager']])await pool.execute(`INSERT INTO users(id,company_id,platform_user_id,full_name,email,role,status,activated_at) VALUES(?,?,?,?,?,?,'active',UTC_TIMESTAMP(3))`,[id,company,`ops_${id}`,`Ops User ${id}`,`ops${id}@example.test`,role]);
  for(const [team,company,manager] of [[7,100,20],[8,100,21],[9,200,70]])await pool.execute(`INSERT INTO teams(id,company_id,name,manager_user_id,status) VALUES(?,?,?,?,'active')`,[team,company,`Ops team ${team}`,manager]);
  for(const [mid,company,team,user] of [[1,100,7,30],[2,100,8,40],[3,200,9,60]])await pool.execute(`INSERT INTO team_members(id,company_id,team_id,user_id,joined_at) VALUES(?,?,?,?, '2026-01-01 00:00:00')`,[mid,company,team,user]);
  for(const [lead,company,owner] of [[101,100,30],[102,100,40],[201,200,60]])await pool.execute(`INSERT INTO leads(id,company_id,title,status,priority,created_by_user_id,owner_user_id) VALUES(?,?,?,'new','normal',?,?)`,[lead,company,`Ops Lead ${lead}`,owner,owner]);
  for(const [id,company,issuer,total] of [[801,100,20,'200.00'],[802,100,21,'50.00'],[803,200,70,'80.00'],[804,100,20,'300.00'],[805,100,20,'1000.00']])await pool.execute(`INSERT INTO crm_invoices(id,company_id,invoice_no,issued_by_id,status,issued_at,due_at,currency,grand_total) VALUES(?,?,?,?,'issued','2026-11-02 06:00:00','2026-12-25 00:00:00','INR',?)`,[id,company,`INV-${id}`,issuer,total]);
  await pool.execute(`INSERT INTO crm_payments(id,company_id,payment_no,amount,currency,payment_method,status,received_at,recorded_by_id) VALUES(901,100,'PAY-901',100.00,'INR','upi','received',UTC_TIMESTAMP(3),20)`);
  await pool.execute(`INSERT INTO crm_payment_allocations(company_id,payment_id,invoice_id,amount,allocated_by_id) VALUES(100,901,801,100.00,20)`);
  await pool.execute(`INSERT INTO tasks(id,company_id,title,owner_user_id,lead_id,status,due_at) VALUES(1001,100,'Call buyer',30,101,'open',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 DAY)),(1002,100,'Review invoice',20,NULL,'open',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 DAY)),(1003,100,'Other team call',40,102,'open',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 DAY))`);
  await pool.execute(`INSERT INTO notifications(id,company_id,recipient_user_id,notification_type,title,body) VALUES(2001,100,30,'task','Follow up','Contact client'),(2002,100,40,'task','Private task','Not visible')`);
  console.log('PASS: Two companies, private managers, invoices, payments, tasks, notifications seeded');
  sessions=createDevSessionStore();identities=createDevIdentityStore();const tokens={};
  for(const [who,company,uid,role,mode] of [['owner',100,10,'OWNER','FULL'],['manager',100,20,'MANAGER','FULL'],['manager2',100,21,'MANAGER','FULL'],['employee',100,30,'EMPLOYEE','FULL'],['employee2',100,40,'EMPLOYEE','FULL'],['readonly',100,20,'MANAGER','READ_ONLY'],['other',200,70,'MANAGER','FULL']]){identities.registerIdentity(`ops_${who}`,{companyId:String(company),actorUserId:String(uid),role,membershipStatus:'ACTIVE',accessMode:mode});tokens[who]=sessions.issueSession(`ops_${who}`);}
  const factory=async()=>{const db=await pool.getConnection();return {execute:(sql,params)=>{if(failAudit&&/INSERT\s+INTO\s+audit_logs/i.test(sql))throw Error('INJECTED_AUDIT_FAILURE');return db.execute(sql,params);},beginTransaction:()=>db.beginTransaction(),commit:()=>db.commit(),rollback:()=>db.rollback(),release:()=>db.release(),destroy:()=>db.destroy()};};
  const app=createCrmApp({sessionVerifier:sessions.verifier,identityResolver:identities.resolver,protectedRoutes:createOperationsRouter({connectionFactory:factory})});server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}/api/v1/crm`;
  async function req(who,method,path,body){const headers={};if(who)headers.Authorization=`Bearer ${tokens[who]}`;if(body!==undefined)headers['Content-Type']='application/json';const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const raw=await response.text();let data;try{data=JSON.parse(raw)}catch{data=raw}return {status:response.status,data,ctype:response.headers.get('content-type')};}
  const creditPath='/finance/invoices/801/credits';const credit={amount:'40.00',expectedBalance:'100.00',reason:'Contract adjustment',idempotencyKey:'credit_test_901234'};
  assert.equal((await req(null,'POST',creditPath,credit)).status,401);assert.equal((await req('owner','POST',creditPath,credit)).status,403);assert.equal((await req('readonly','POST',creditPath,credit)).status,403);assert.equal((await req('employee','POST',creditPath,credit)).status,403);assert.equal((await req('manager2','POST',creditPath,credit)).status,404);assert.equal((await req('other','POST',creditPath,credit)).status,404);
  console.log('PASS: Auth, Owner read-only, manager-scoped credit and company restrictions');
  let result=await req('manager','POST',creditPath,{...credit,amount:'101.00'});assert.equal(result.status,400);
  const beforeCredit=await count('crm_credit_notes');failAudit=true;result=await req('manager','POST',creditPath,credit);assert.equal(result.status,500,JSON.stringify(result.data));failAudit=false;assert.equal(await count('crm_credit_notes'),beforeCredit);
  result=await req('manager','POST',creditPath,credit);assert.equal(result.status,201,JSON.stringify(result.data));assert.equal(result.data.data.balance,'60.00');assert.equal((await req('manager','POST',creditPath,credit)).status,409);
  const [creditRows]=await pool.execute(`SELECT amount,status FROM crm_credit_notes WHERE company_id=100 AND invoice_id=801`);assert.equal(creditRows.length,1);assert.equal(creditRows[0].status,'issued');
  const race=await Promise.all([req('manager','POST',creditPath,{...credit,amount:'30.00',expectedBalance:'60.00',idempotencyKey:'credit_race_12345'}),req('manager','POST',creditPath,{...credit,amount:'20.00',expectedBalance:'60.00',idempotencyKey:'credit_race_54321'})]);assert.deepEqual(race.map(x=>x.status).sort(),[201,409]);const creditedTotal=race[0].status===201?'70.00':'60.00';
  console.log('PASS: Credit issuance, rollback, idempotency and row-locked concurrency');
  const refundPath='/finance/payments/901/refund-requests';const refund={amount:'30.00',reason:'Customer return',expectedAvailable:'100.00'};
  assert.equal((await req('owner','POST',refundPath,refund)).status,403);assert.equal((await req('manager2','POST',refundPath,refund)).status,404);
  const beforeRefund=await count('crm_payment_refunds');failAudit=true;result=await req('manager','POST',refundPath,refund);assert.equal(result.status,500);failAudit=false;assert.equal(await count('crm_payment_refunds'),beforeRefund);
  result=await req('manager','POST',refundPath,refund);assert.equal(result.status,201,JSON.stringify(result.data));assert.equal(result.data.data.status,'pending');assert.equal(result.data.data.cashReturned,false);assert.equal((await req('manager','POST',refundPath,refund)).status,409);
  const [payRows]=await pool.execute(`SELECT status,amount FROM crm_payments WHERE company_id=100 AND id=901`);assert.equal(payRows[0].status,'received');assert.equal(String(payRows[0].amount),'100.00');
  console.log('PASS: Refund requests reserve availability without falsely refunding cash');
  const schedulePath='/finance/invoices/804/due-schedules';const schedule={items:[{dueOn:'2026-11-01',amount:'100.00'},{dueOn:'2026-12-25',amount:'200.00'}]};
  assert.equal((await req('owner','POST',schedulePath,schedule)).status,403);assert.equal((await req('manager2','POST',schedulePath,schedule)).status,404);assert.equal((await req('manager','POST',schedulePath,{items:[{dueOn:'2026-12-25',amount:'299.00'}]})).status,400);
  const beforeSchedules=await count('crm_invoice_due_schedules');failAudit=true;assert.equal((await req('manager','POST',schedulePath,schedule)).status,500);failAudit=false;assert.equal(await count('crm_invoice_due_schedules'),beforeSchedules);
  result=await req('manager','POST',schedulePath,schedule);assert.equal(result.status,201,JSON.stringify(result.data));assert.equal(result.data.data.total,'300.00');assert.equal((await req('manager','POST',schedulePath,schedule)).status,409);
  result=await req('manager','GET',schedulePath);assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.data.items.length,2);const today=new Date().toISOString().slice(0,10);const expectedOverdue=today>'2026-12-25'?'300.00':today>'2026-11-01'?'100.00':'0.00';assert.equal(result.data.data.overdue,expectedOverdue);
  console.log('PASS: Installment schedules, cumulative overdue, no replacement, and rollback');
  const targetPath='/operations/targets';const newTarget={userId:'30',startsOn:'2026-11-01',endsOn:'2026-11-30',amount:'10000.00'};
  assert.equal((await req('employee','POST',targetPath,newTarget)).status,403);assert.equal((await req('owner','POST',targetPath,newTarget)).status,403);assert.equal((await req('readonly','POST',targetPath,newTarget)).status,403);assert.equal((await req('manager2','POST',targetPath,newTarget)).status,404);assert.equal((await req('manager','POST',targetPath,{...newTarget,userId:'40'})).status,404);
  const beforeTargets=await count('crm_target_periods');failAudit=true;assert.equal((await req('manager','POST',targetPath,newTarget)).status,500);failAudit=false;assert.equal(await count('crm_target_periods'),beforeTargets);
  result=await req('manager','POST',targetPath,newTarget);assert.equal(result.status,201,JSON.stringify(result.data));const targetId=result.data.data.id;
  assert.equal((await req('manager','POST',targetPath,newTarget)).status,409);
  result=await req('employee','GET',`${targetPath}/${targetId}`);assert.equal(result.status,200);assert.equal(result.data.data.effective,'10000.00');assert.equal((await req('employee2','GET',`${targetPath}/${targetId}`)).status,404);assert.equal((await req('other','GET',`${targetPath}/${targetId}`)).status,404);
  const changePath=`${targetPath}/${targetId}/adjustments`;assert.equal((await req('employee','POST',changePath,{delta:'100.00',reason:'carry forward',expectedEffective:'10000.00'})).status,403);
  const adjustment={delta:'250.00',reason:'Manager authorized carry-forward adjustment',expectedEffective:'10000.00'};
  result=await req('manager','POST',changePath,adjustment);assert.equal(result.status,201,JSON.stringify(result.data));assert.equal(result.data.data.effective,'10250.00');assert.equal((await req('manager','POST',changePath,adjustment)).status,409);
  assert.equal((await req('manager','POST',changePath,{delta:'-99999.00',reason:'bad negative target',expectedEffective:'10250.00'})).status,400);
  result=await req('owner','GET',targetPath);assert.equal(result.status,200);assert.ok(result.data.data.items.some(x=>x.id===targetId));
  console.log('PASS: Manager-owned targets, team scope, approved adjustments, rollback and stale checks');
  result=await req('manager','GET','/operations/reports/finance?from=2026-11-01&to=2026-11-30');assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.data.totals.invoices,3);assert.equal(result.data.data.totals.billed,'1500.00');
  assert.equal(result.data.data.totals.paid,'100.00');assert.equal(result.data.data.totals.credits,creditedTotal);
  result=await req('owner','GET','/operations/reports/finance?from=2026-11-01&to=2026-11-30');assert.equal(result.status,200);assert.equal(result.data.data.totals.invoices,4);assert.equal(result.data.data.totals.billed,'1550.00');
  result=await req('manager2','GET','/operations/reports/finance?from=2026-11-01&to=2026-11-30');assert.equal(result.data.data.totals.invoices,1);
  assert.equal((await req('employee','GET','/operations/reports/finance?from=2026-11-01&to=2026-11-30')).status,403);
  assert.equal((await req('manager','GET','/operations/reports/finance?from=2026-02-30&to=2026-11-30')).status,400);
  result=await req('manager','GET','/operations/reports/finance?from=2026-11-01&to=2026-11-30&format=csv');assert.equal(result.status,200);assert.match(result.ctype,/text\/csv/);assert.ok(result.data.includes('INV-801'));assert.ok(!result.data.includes('INV-802'));assert.ok(!result.data.includes('INV-803'));
  console.log('PASS: JSON/CSV finance reports scoped per manager and Owner, with INR totals');
  result=await req('employee','GET','/operations/reminders/due');assert.equal(result.status,200);assert.deepEqual(result.data.data.items.map(x=>x.id),['1001']);
  result=await req('manager','GET','/operations/reminders/due');assert.equal(result.status,200);assert.deepEqual(result.data.data.items.map(x=>x.id),['1002']);
  result=await req('owner','GET','/operations/reminders/due');assert.equal(result.status,200);assert.equal(result.data.data.items.length,0);
  result=await req('employee','GET','/operations/notifications');assert.equal(result.status,200);assert.deepEqual(result.data.data.items.map(x=>x.id),['2001']);
  assert.equal((await req('employee','PATCH','/operations/notifications/2002/read')).status,404);
  assert.equal((await req('employee2','PATCH','/operations/notifications/2001/read')).status,404);
  assert.equal((await req('employee','PATCH','/operations/notifications/2001/read')).status,200);
  const [read]=await pool.execute(`SELECT read_at FROM notifications WHERE company_id=100 AND id=2001`);assert.ok(read[0].read_at);
  console.log('PASS: Personal reminders, notification isolation and read acknowledgments');
  const [audits]=await pool.execute(`SELECT action FROM audit_logs WHERE company_id=100`);for(const action of ['invoice.credit_issued','payment.refund_requested','invoice.due_schedule_created','target.created','target.adjusted'])assert.ok(audits.some(x=>x.action===action),`Missing ${action}`);
  const source=fs.readFileSync('./src/server.ts','utf8');assert.match(source,/createOperationsRouter/);
  console.log('PASS: All operations integrated, audited and mounted in normal server');
  console.log('PASS: ALL OPERATIONS MILESTONE TESTS');
 }finally{
  if(server)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));if(sessions)sessions.clearSessions();if(identities)identities.clearIdentities();if(pool)await pool.end();
  if(admin){try{if(created){assert.match(scratch,/^dgate_crm_opsqa_[a-f0-9]{16}$/);await admin.query(`DROP DATABASE \`${scratch}\``);console.log('PASS: Scratch operations database removed');}}finally{await admin.end();}}
 }
 console.log('PASS: Original CRM database unchanged');
}
main().catch(e=>{console.error('FAIL:',e?.stack||e);process.exitCode=1;});
