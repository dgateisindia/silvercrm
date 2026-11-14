const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const mysql=require('mysql2/promise');
const dotenv=require('dotenv');
const crypto=require('node:crypto');
const {once}=require('node:events');

const env=dotenv.parse(fs.readFileSync('.env'));
assert.equal(env.DB_NAME,'dgate_crm_fresh','The production CRM schema must remain the read-only reference');
Object.assign(process.env,env,{NODE_ENV:'test',AUTH_MODE:'local',HOST:'127.0.0.1',CRM_DEV_SEED:'0'});
require.extensions['.ts']=(mod,file)=>{
  const built=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}});
  mod._compile(built.outputText,file);
};
const {createCrmApp}=require(process.cwd() + '/./src/app.ts');
const {createDevSessionStore}=require(process.cwd() + '/./src/core/auth/devSessionVerifier.ts');
const {createDevIdentityStore}=require(process.cwd() + '/./src/core/auth/devIdentityResolver.ts');
const {createClosingRouter}=require(process.cwd() + '/./src/modules/closing/routes/closing.routes.ts');
const cfg={host:env.DB_HOST||'127.0.0.1',port:Number(env.DB_PORT||3306),user:env.DB_USER||'root',password:env.DB_PASSWORD??'',multipleStatements:false};
const scratch='dgate_crm_closingqa_'+crypto.randomBytes(8).toString('hex');
assert.match(scratch,/^dgate_crm_closingqa_[a-f0-9]{16}$/);
const tables=['companies','users','teams','team_members','crm_invoices','crm_payments','crm_payment_allocations','crm_payment_refunds','crm_credit_notes','crm_target_periods','crm_target_adjustments','pipelines','pipeline_stages','deals','audit_logs'];
let admin,pool,server,sessions,identities,created=false,failAudit=false;
async function count(table){assert.ok(tables.includes(table));const [rows]=await pool.execute(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE company_id=100`);return Number(rows[0].n);}
async function query(sql,values=[]){return (await pool.execute(sql,values))[0];}
async function main(){
 try{
  admin=await mysql.createConnection(cfg);
  await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  created=true;
  for(const table of tables)await admin.query(`CREATE TABLE \`${scratch}\`.\`${table}\` LIKE \`${env.DB_NAME}\`.\`${table}\``);
  pool=mysql.createPool({...cfg,database:scratch,connectionLimit:6,supportBigNumbers:true,bigNumberStrings:true});
  console.log('PASS: 15 CRM table structures copied into temporary database');
  for(const id of [100,200])await pool.execute(`INSERT INTO companies(id,platform_org_id,name,slug,status,platform_product_id,platform_access_mode,provisioned_at) VALUES(?,?,?,?,'active',1,'FULL',UTC_TIMESTAMP(3))`,[id,`close_${id}`,`Closing QA ${id}`,`closing_${id}`]);
  for(const [uid,company,role] of [[10,100,'owner'],[20,100,'manager'],[21,100,'manager'],[30,100,'employee'],[40,100,'employee'],[60,200,'employee'],[70,200,'manager']])
   await pool.execute(`INSERT INTO users(id,company_id,platform_user_id,full_name,email,role,status,activated_at) VALUES(?,?,?,?,?,?,'active',UTC_TIMESTAMP(3))`,[uid,company,`close_${uid}`,`QA ${uid}`,`close${uid}@example.test`,role]);
  for(const [id,company,manager] of [[7,100,20],[8,100,21],[9,200,70]])
   await pool.execute(`INSERT INTO teams(id,company_id,name,manager_user_id,status) VALUES(?,?,?,?,'active')`,[id,company,`QA Team ${id}`,manager]);
  for(const [id,company,team,user] of [[1,100,7,30],[2,100,8,40],[3,200,9,60]])
   await pool.execute(`INSERT INTO team_members(id,company_id,team_id,user_id,joined_at) VALUES(?,?,?,?, '2026-01-01 00:00:00')`,[id,company,team,user]);
  for(const [id,company,owner,amount,start,end] of [[301,100,30,'10000.00','2026-11-01','2026-11-30'],[302,100,40,'5000.00','2026-11-01','2026-11-30'],[303,200,60,'7000.00','2026-11-01','2026-11-30']])
   await pool.execute(`INSERT INTO crm_target_periods(id,company_id,user_id,starts_on,ends_on,target_amount,currency) VALUES(?,?,?,STR_TO_DATE(?,'%Y-%m-%d'),STR_TO_DATE(?,'%Y-%m-%d'),?,'INR')`,[id,company,owner,start,end,amount]);
  await pool.execute(`INSERT INTO crm_target_adjustments(company_id,target_period_id,delta_amount,reason,approved_by_id) VALUES(100,301,200.00,'Approved plan adjustment',20)`);
  for(const [pipe,company] of [[501,100],[502,200]])
   await pool.execute(`INSERT INTO pipelines(id,company_id,name,is_default,active) VALUES(?,?,?,1,1)`,[pipe,company,`QA Pipeline ${pipe}`]);
  for(const [stage,company,pipe,type,position] of [[601,100,501,'open',1],[602,100,501,'won',2],[603,200,502,'won',1]])
   await pool.execute(`INSERT INTO pipeline_stages(id,company_id,pipeline_id,name,position,stage_type) VALUES(?,?,?,?,?,?)`,[stage,company,pipe,`Stage ${stage}`,position,type]);
  for(const [deal,company,owner,stage,pipeline,amount,closedAt] of [[701,100,30,602,501,'4000.00','2026-11-12 12:00:00'],[702,100,30,602,501,'2000.00','2026-11-15 12:00:00'],[703,100,40,602,501,'1000.00','2026-11-13 12:00:00'],[704,200,60,603,502,'8000.00','2026-11-10 12:00:00'],[705,100,30,601,501,'999.00',null]])
   await pool.execute(`INSERT INTO deals(id,company_id,pipeline_id,stage_id,owner_user_id,title,expected_amount,currency,closed_at) VALUES(?,?,?,?,?,? ,?,'INR',?)`,[deal,company,pipeline,stage,owner,`QA Deal ${deal}`,amount,closedAt]);
  for(const [inv,company,issuer,amount,due] of [[801,100,20,'200.00','2026-10-01'],[802,100,21,'70.00','2027-01-01'],[803,200,70,'80.00','2026-10-01'],[804,100,20,'300.00','2026-07-01'],[805,100,20,'100.00','2027-01-01'],[806,100,20,'40.00','2026-10-20']])
   await pool.execute(`INSERT INTO crm_invoices(id,company_id,invoice_no,issued_by_id,status,issued_at,due_at,currency,grand_total) VALUES(?,?,?,?,'issued',UTC_TIMESTAMP(3),STR_TO_DATE(?,'%Y-%m-%d'),'INR',?)`,[inv,company,inv===806?'=1+1':`INV-${inv}`,issuer,due,amount]);
  for(const [id,company,issuer,amount] of [[901,100,20,'100.00'],[902,100,21,'40.00'],[903,200,70,'50.00']])
   await pool.execute(`INSERT INTO crm_payments(id,company_id,payment_no,amount,currency,payment_method,status,received_at,recorded_by_id) VALUES(?,?,?,?,'INR','upi','received',UTC_TIMESTAMP(3),?)`,[id,company,`PAY-${id}`,amount,issuer]);
  for(const [company,payment,invoice,amount,by] of [[100,901,801,'100.00',20],[100,902,802,'40.00',21],[200,903,803,'50.00',70]])
   await pool.execute(`INSERT INTO crm_payment_allocations(company_id,payment_id,invoice_id,amount,allocated_by_id) VALUES(?,?,?,?,?)`,[company,payment,invoice,amount,by]);
  await pool.execute(`INSERT INTO crm_credit_notes(company_id,credit_no,invoice_id,amount,currency,reason,status,issued_by_id) VALUES(100,'CRED-801',801,20.00,'INR','Test credit','issued',20)`);
  for(const [id,company,payment,amount,reason] of [[1001,100,901,'30.00','Return'],[1002,100,902,'10.00','Other team'],[1003,200,903,'20.00','Other company'],[1004,100,901,'20.00','Second request']])
   await pool.execute(`INSERT INTO crm_payment_refunds(id,company_id,payment_id,amount,reason,status) VALUES(?,?,?,?,?,'pending')`,[id,company,payment,amount,reason]);
  console.log('PASS: Two company scopes, three private teams, won deals, targets, invoices and refunds seeded');
  sessions=createDevSessionStore();identities=createDevIdentityStore();const tokens={};
  for(const [name,company,user,role,mode] of [['owner',100,10,'OWNER','FULL'],['manager',100,20,'MANAGER','FULL'],['manager2',100,21,'MANAGER','FULL'],['employee',100,30,'EMPLOYEE','FULL'],['employee2',100,40,'EMPLOYEE','FULL'],['readonly',100,20,'MANAGER','READ_ONLY'],['other',200,70,'MANAGER','FULL']]){
   identities.registerIdentity(`closing_${name}`,{companyId:String(company),actorUserId:String(user),role,membershipStatus:'ACTIVE',accessMode:mode});
   tokens[name]=sessions.issueSession(`closing_${name}`);
  }
  const factory=async()=>{const conn=await pool.getConnection();return {
    execute:(sql,params)=>{if(failAudit&&/INSERT\s+INTO\s+audit_logs/i.test(sql))throw Error('QA_INJECTED_AUDIT_FAILURE');return conn.execute(sql,params);},
    beginTransaction:()=>conn.beginTransaction(),commit:()=>conn.commit(),rollback:()=>conn.rollback(),release:()=>conn.release(),destroy:()=>conn.destroy()
  };};
  const app=createCrmApp({sessionVerifier:sessions.verifier,identityResolver:identities.resolver,protectedRoutes:createClosingRouter({connectionFactory:factory})});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}/api/v1/crm`;
  async function req(who,method,path,body){
   const headers={};if(who)headers.Authorization=`Bearer ${tokens[who]}`;
   if(body!==undefined)headers['Content-Type']='application/json';
   const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
   const raw=await response.text();let data;try{data=JSON.parse(raw)}catch{data=raw}
   return {status:response.status,data,ctype:response.headers.get('content-type')};
  }

  const refundPath='/finance/refund-requests/1001/review';
  const refundBody={decision:'approved',expectedStatus:'pending',reason:'Manager verified customer request'};
  assert.equal((await req(null,'PATCH',refundPath,refundBody)).status,401);
  for(const who of ['owner','employee','readonly'])assert.equal((await req(who,'PATCH',refundPath,refundBody)).status,403,who);
  assert.equal((await req('manager2','PATCH',refundPath,refundBody)).status,404);
  assert.equal((await req('other','PATCH',refundPath,refundBody)).status,404);
  assert.equal((await req('manager','PATCH',refundPath,{...refundBody,decision:'processed'})).status,400);
  const oldStatus=await query('SELECT status FROM crm_payment_refunds WHERE company_id=100 AND id=1001');assert.equal(oldStatus[0].status,'pending');
  failAudit=true;
  let result=await req('manager','PATCH',refundPath,refundBody);
  assert.equal(result.status,500,JSON.stringify(result.data));failAudit=false;
  const heldStatus=await query('SELECT status FROM crm_payment_refunds WHERE company_id=100 AND id=1001');assert.equal(heldStatus[0].status,'pending');
  result=await req('manager','PATCH',refundPath,refundBody);assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.data.cashReturned,false);
  assert.equal((await req('manager','PATCH',refundPath,refundBody)).status,409);
  result=await req('manager','PATCH','/finance/refund-requests/1004/review',{...refundBody,decision:'rejected'});
  assert.equal(result.status,200);assert.equal(result.data.data.status,'rejected');
  const payments=await query(`SELECT p.status,p.amount FROM crm_payments p WHERE p.company_id=100 AND p.id=901`);
  assert.equal(payments[0].status,'received');assert.equal(String(payments[0].amount),'100.00');
  console.log('PASS: Refund review permissions, approve/reject, immutable cash status and rollback');

  const targetPath='/operations/targets/301/carry-forward';
  const carry={nextStartsOn:'2026-12-01',nextEndsOn:'2026-12-31',baseAmount:'3000.00',expectedEffective:'10200.00'};
  for(const who of ['owner','employee','readonly'])assert.equal((await req(who,'POST',targetPath,carry)).status,403,who);
  assert.equal((await req('manager2','POST',targetPath,carry)).status,404);
  assert.equal((await req('other','POST',targetPath,carry)).status,404);
  assert.equal((await req('manager','POST',targetPath,{...carry,nextStartsOn:'2026-12-02'})).status,400);
  assert.equal((await req('manager','POST',targetPath,{...carry,expectedEffective:'9999.00'})).status,409);
  let before=await count('crm_target_periods');failAudit=true;
  result=await req('manager','POST',targetPath,carry);assert.equal(result.status,500,JSON.stringify(result.data));
  failAudit=false;assert.equal(await count('crm_target_periods'),before);
  const race=await Promise.all([req('manager','POST',targetPath,carry),req('manager','POST',targetPath,carry)]);
  assert.deepEqual(race.map(r=>r.status).sort(),[201,409],JSON.stringify(race));
  const winner=race.find(r=>r.status===201);
  assert.equal(winner.data.data.wonDealValue,'6000.00');
  assert.equal(winner.data.data.shortfallCarried,'4200.00');
  assert.equal(winner.data.data.amount,'7200.00');
  assert.equal(await count('crm_target_periods'),before+1);
  assert.equal((await req('manager','POST',targetPath,carry)).status,409);
  const [nextRows]=await pool.execute(`SELECT target_amount FROM crm_target_periods WHERE company_id=100 AND user_id=30 AND starts_on='2026-12-01'`);
  assert.equal(nextRows.length,1);assert.equal(String(nextRows[0].target_amount),'7200.00');
  console.log('PASS: Target carry-forward based on won Deal value, concurrency, overlap and audit rollback');

  const perf='/operations/reports/target-performance?from=2026-11-01&to=2026-11-30';
  result=await req('manager','GET',perf);assert.equal(result.status,200,JSON.stringify(result.data));
  assert.deepEqual(result.data.data.items.map(x=>x.userId),['30']);
  assert.equal(result.data.data.items[0].wonDealValue,'6000.00');
  assert.equal(result.data.data.items[0].shortfall,'4200.00');
  result=await req('owner','GET',perf);assert.equal(result.status,200);assert.equal(result.data.data.items.length,2);
  result=await req('employee','GET',perf);assert.equal(result.status,200);assert.deepEqual(result.data.data.items.map(x=>x.userId),['30']);
  result=await req('employee2','GET',perf);assert.equal(result.status,200);assert.deepEqual(result.data.data.items.map(x=>x.userId),['40']);
  result=await req('other','GET',perf);assert.equal(result.status,200);assert.deepEqual(result.data.data.items.map(x=>x.userId),['60']);
  assert.equal((await req('manager','GET','/operations/reports/target-performance?from=2026-02-30&to=2026-11-30')).status,400);
  result=await req('manager','GET',perf+'&format=csv');assert.equal(result.status,200);assert.match(result.ctype,/text\/csv/);
  assert.ok(result.data.includes('6000.00'));assert.ok(!result.data.includes('5000.00'));assert.ok(!result.data.includes('7000.00'));
  console.log('PASS: Target performance JSON/CSV scoped to Owner, Manager and Employee');

  result=await req('manager','GET','/operations/reports/invoice-aging');assert.equal(result.status,200,JSON.stringify(result.data));
  assert.ok(result.data.data.items.some(x=>x.invoiceNo==='INV-801'&&x.balance==='80.00'));
  assert.ok(!result.data.data.items.some(x=>x.invoiceNo==='INV-802'));
  assert.ok(!result.data.data.items.some(x=>x.invoiceNo==='INV-803'));
  const expectedIds=['INV-801','INV-804','INV-805','=1+1'];
  assert.deepEqual(result.data.data.items.map(x=>x.invoiceNo).sort(),expectedIds.sort());
  result=await req('manager2','GET','/operations/reports/invoice-aging');assert.equal(result.data.data.items.length,1);
  assert.equal(result.data.data.items[0].balance,'30.00');
  result=await req('owner','GET','/operations/reports/invoice-aging');assert.equal(result.data.data.items.length,5);
  assert.equal((await req('employee','GET','/operations/reports/invoice-aging')).status,403);
  assert.equal((await req('manager','GET','/operations/reports/invoice-aging?date=2026-11-02')).status,400);
  result=await req('manager','GET','/operations/reports/invoice-aging?format=csv');assert.equal(result.status,200);assert.match(result.ctype,/text\/csv/);
  assert.ok(result.data.includes("'\u003d1+1"));assert.ok(!result.data.includes('INV-802'));assert.ok(!result.data.includes('INV-803'));
  console.log('PASS: Current invoice aging, financial balances and spreadsheet-injection-safe CSV');

  const [auditRows]=await pool.execute(`SELECT action FROM audit_logs WHERE company_id=100`);
  for(const action of ['target.carried_forward','payment.refund_reviewed'])assert.ok(auditRows.some(x=>x.action===action));
  assert.match(fs.readFileSync('./src/server.ts','utf8'),/createClosingRouter/);
  console.log('PASS: Closing router mounted in CRM server, audit entries persisted');
  console.log('PASS: ALL CLOSING MILESTONE TESTS');
 }finally{
  if(server)await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
  if(sessions)sessions.clearSessions();if(identities)identities.clearIdentities();
  if(pool)await pool.end();
  if(admin){try{if(created){assert.match(scratch,/^dgate_crm_closingqa_[a-f0-9]{16}$/);await admin.query(`DROP DATABASE \`${scratch}\``);console.log('PASS: Scratch closing database removed');}}finally{await admin.end();}}
 }
 console.log('PASS: Original CRM database unchanged');
}
main().catch(error=>{console.error('FAIL:',error?.stack||error);process.exitCode=1;});
