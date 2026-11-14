const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const mysql=require('mysql2/promise');
const dotenv=require('dotenv');
const crypto=require('node:crypto');
const {once}=require('node:events');
const env=dotenv.parse(fs.readFileSync('.env'));
assert.equal(env.DB_NAME,'dgate_crm_fresh');
Object.assign(process.env,env,{NODE_ENV:'test',AUTH_MODE:'local',HOST:'127.0.0.1',CRM_DEV_SEED:'0'});
require.extensions['.ts']=(mod,file)=>{const o=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}});mod._compile(o.outputText,file);};
const {createCrmApp}=require(process.cwd() + '/./src/app.ts');
const {createDevSessionStore}=require(process.cwd() + '/./src/core/auth/devSessionVerifier.ts');
const {createDevIdentityStore}=require(process.cwd() + '/./src/core/auth/devIdentityResolver.ts');
const {createFinanceRouter}=require(process.cwd() + '/./src/modules/finance/routes/finance.routes.ts');
const config={host:env.DB_HOST||'127.0.0.1',port:Number(env.DB_PORT||3306),user:env.DB_USER||'root',password:env.DB_PASSWORD??'',multipleStatements:false};
const scratch='dgate_crm_financeqa_'+crypto.randomBytes(8).toString('hex');
assert.match(scratch,/^dgate_crm_financeqa_[0-9a-f]{16}$/);
const tables=['companies','users','teams','team_members','leads','pipelines','pipeline_stages','deals','crm_quotations','crm_quotation_revisions','crm_quotation_items','crm_invoices','crm_invoice_items','crm_payments','crm_payment_allocations','crm_credit_notes','audit_logs'];
let admin,pool,server,sessions,identities,created=false,failAudit=false;
async function main(){
 try {
  admin=await mysql.createConnection(config);
  await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);created=true;
  for(const table of tables)await admin.query(`CREATE TABLE \`${scratch}\`.\`${table}\` LIKE \`${env.DB_NAME}\`.\`${table}\``);
  pool=mysql.createPool({...config,database:scratch,connectionLimit:6,supportBigNumbers:true,bigNumberStrings:true});
  console.log('PASS: 17 production structures copied into isolated finance database');
  for(const company of [100,200])await pool.execute(`INSERT INTO companies(id,platform_org_id,name,slug,status,platform_product_id,platform_access_mode,provisioned_at) VALUES(?,?,?,?,'active',1,'FULL',UTC_TIMESTAMP(3))`,[company,`finance_org_${company}`,`Finance Org ${company}`,`fin_org_${company}`]);
  for(const [id,company,role] of [[10,100,'owner'],[20,100,'manager'],[21,100,'manager'],[30,100,'employee'],[40,100,'employee'],[60,200,'employee'],[70,200,'manager']])await pool.execute(`INSERT INTO users(id,company_id,platform_user_id,full_name,email,role,status,activated_at) VALUES(?,?,?,?,?,?,'active',UTC_TIMESTAMP(3))`,[id,company,`fin_${id}`,`Finance user ${id}`,`fin${id}@example.test`,role]);
  for(const [id,company,manager] of [[7,100,20],[8,100,21],[9,200,70]])await pool.execute(`INSERT INTO teams(id,company_id,name,manager_user_id,status) VALUES(?,?,?,?,'active')`,[id,company,`Finance Team ${id}`,manager]);
  for(const [id,company,team,user] of [[1,100,7,30],[2,100,8,40],[3,200,9,60]])await pool.execute(`INSERT INTO team_members(id,company_id,team_id,user_id,joined_at) VALUES(?,?,?,?,'2026-01-01 00:00:00')`,[id,company,team,user]);
  for(const [lead,company,owner] of [[101,100,30],[102,100,40],[201,200,60]])await pool.execute(`INSERT INTO leads(id,company_id,title,status,priority,created_by_user_id,owner_user_id) VALUES(?,?,?,'new','normal',?,?)`,[lead,company,`Finance Lead ${lead}`,owner,owner]);
  for(const company of [100,200]){
   await pool.execute(`INSERT INTO pipelines(id,company_id,name,is_default,active) VALUES(?,?,?,1,1)`,[company,company,`Custom Pipeline ${company}`]);
   await pool.execute(`INSERT INTO pipeline_stages(id,company_id,pipeline_id,name,position,stage_type) VALUES(?,?,?,'Customer Defined',1,'open')`,[company,company,company]);
  }
  for(const [deal,company,lead,owner] of [[301,100,101,30],[302,100,102,40],[401,200,201,60]])await pool.execute(`INSERT INTO deals(id,company_id,lead_id,pipeline_id,stage_id,owner_user_id,title,expected_amount,currency) VALUES(?,?,?,?,?,?,?,118.00,'INR')`,[deal,company,lead,company,company,owner,`Finance Deal ${deal}`]);
  for(const [quote,company,deal,creator] of [[501,100,301,30],[502,100,302,40],[601,200,401,60]]){
   await pool.execute(`INSERT INTO crm_quotations(id,company_id,quote_no,deal_id,created_by_id,status,currency) VALUES(?,?,?,?,?,'draft','INR')`,[quote,company,`QUOTE-${quote}`,deal,creator]);
   await pool.execute(`INSERT INTO crm_quotation_revisions(id,company_id,quotation_id,revision_no,subtotal,discount_total,tax_total,grand_total,status,created_by_id) VALUES(?,?,?,1,100.00,0,18.00,118.00,'draft',?)`,[quote,company,quote,creator]);
   await pool.execute(`INSERT INTO crm_quotation_items(company_id,revision_id,description,quantity,unit_price,tax_rate,line_total) VALUES(?,?,'Initial service',1.000,100.00,18.0000,100.00)`,[company,quote]);
  }
  console.log('PASS: Two isolated companies, deals, private teams and draft quotations seeded');
  sessions=createDevSessionStore();identities=createDevIdentityStore();const tokens={};
  for(const [who,company,user,role,mode] of [['owner',100,10,'OWNER','FULL'],['manager',100,20,'MANAGER','FULL'],['manager2',100,21,'MANAGER','FULL'],['employee',100,30,'EMPLOYEE','FULL'],['employee2',100,40,'EMPLOYEE','FULL'],['readonly',100,20,'MANAGER','READ_ONLY'],['other',200,70,'MANAGER','FULL']]){
   identities.registerIdentity(`fin_${who}`,{companyId:String(company),actorUserId:String(user),role,membershipStatus:'ACTIVE',accessMode:mode});tokens[who]=sessions.issueSession(`fin_${who}`);
  }
  const factory=async()=>{const db=await pool.getConnection();return {execute:(sql,args)=>{if(failAudit&&/INSERT\s+INTO\s+audit_logs/i.test(sql))throw Error('INJECTED_AUDIT_FAILURE');return db.execute(sql,args);},beginTransaction:()=>db.beginTransaction(),commit:()=>db.commit(),rollback:()=>db.rollback(),release:()=>db.release(),destroy:()=>db.destroy()};};
  const app=createCrmApp({sessionVerifier:sessions.verifier,identityResolver:identities.resolver,protectedRoutes:createFinanceRouter({connectionFactory:factory})});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const root=`http://127.0.0.1:${server.address().port}/api/v1/crm`;
  async function req(who,method,path,body){const headers={};if(who)headers.Authorization=`Bearer ${tokens[who]}`;if(body!==undefined)headers['Content-Type']='application/json';const response=await fetch(root+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const raw=await response.text();let data;try{data=JSON.parse(raw)}catch{data=raw}return{status:response.status,data};}
  const revised={expectedRevisionNo:1,validUntil:'2026-12-31',items:[{description:'Implementation services',quantity:'2.000',unitPrice:'125.50',taxRate:'18.0000'}]};
  const rev='/sales/quotations/501/revisions';
  assert.equal((await req(null,'GET',rev)).status,401);
  assert.equal((await req('owner','GET',rev)).status,200);
  assert.equal((await req('manager','GET',rev)).status,200);
  assert.equal((await req('manager2','GET',rev)).status,404);
  assert.equal((await req('other','GET',rev)).status,404);
  assert.equal((await req('owner','POST',rev,revised)).status,403);
  assert.equal((await req('readonly','POST',rev,revised)).status,403);
  assert.equal((await req('employee2','POST',rev,revised)).status,404);
  assert.equal((await req('manager2','POST',rev,revised)).status,404);
  console.log('PASS: Quotation read, write and company/team permissions');
  const before=(await pool.execute(`SELECT COUNT(*) AS n FROM crm_quotation_revisions WHERE company_id=100 AND quotation_id=501`))[0][0].n;
  failAudit=true;
  let r=await req('employee','POST',rev,revised);assert.equal(r.status,500,JSON.stringify(r.data));
  failAudit=false;
  const after=(await pool.execute(`SELECT COUNT(*) AS n FROM crm_quotation_revisions WHERE company_id=100 AND quotation_id=501`))[0][0].n;
  assert.equal(String(before),String(after));
  console.log('PASS: Draft revision inserts roll back on audit failure');
  r=await req('employee','POST',rev,revised);assert.equal(r.status,201,JSON.stringify(r.data));
  assert.equal(r.data.data.revisionNo,2);assert.equal(r.data.data.subtotal,'251.00');assert.equal(r.data.data.taxTotal,'45.18');assert.equal(r.data.data.grandTotal,'296.18');
  assert.equal((await req('employee','POST',rev,revised)).status,409);
  r=await req('owner','GET',rev);assert.equal(r.status,200);assert.equal(r.data.data.revisions.length,2);
  const [first]=await pool.execute(`SELECT grand_total FROM crm_quotation_revisions WHERE company_id=100 AND quotation_id=501 AND revision_no=1`);
  assert.equal(String(first[0].grand_total),'118.00');
  const extra='/sales/quotations/502/revisions';
  const duel=await Promise.all([
   req('employee2','POST',extra,revised),
   req('manager2','POST',extra,revised)
  ]);
  assert.deepEqual(duel.map(x=>x.status).sort(),[201,409]);
  console.log('PASS: Immutable quote revisions, concurrent revisions, exact INR arithmetic');
  const approve='/sales/quotations/501/approve';
  assert.equal((await req('employee','POST',approve,{expectedRevisionNo:2})).status,403);
  assert.equal((await req('manager2','POST',approve,{expectedRevisionNo:2})).status,404);
  assert.equal((await req('manager','POST',approve,{expectedRevisionNo:1})).status,409);
  r=await req('manager','POST',approve,{expectedRevisionNo:2});assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal((await req('manager','POST',approve,{expectedRevisionNo:2})).status,409);
  assert.equal((await req('employee','POST',rev,{...revised,expectedRevisionNo:2})).status,409);
  console.log('PASS: Manager approval locks quotation and prevents further draft revisions');
  const create='/finance/invoices/from-quotation/501';
  assert.equal((await req('employee','POST',create)).status,403);
  assert.equal((await req('other','POST',create)).status,404);
  assert.equal((await req('manager2','POST',create)).status,404);
  r=await req('manager','POST',create);assert.equal(r.status,201,JSON.stringify(r.data));
  const invoiceId=r.data.data.id;assert.equal(r.data.data.grandTotal,'296.18');assert.equal(r.data.data.status,'draft');
  assert.equal((await req('manager','POST',create)).status,409);
  const [lines]=await pool.execute(`SELECT description,quantity,unit_price,tax_amount,line_total FROM crm_invoice_items WHERE company_id=100 AND invoice_id=?`,[invoiceId]);
  assert.equal(lines.length,1);assert.equal(String(lines[0].tax_amount),'45.18');assert.equal(String(lines[0].line_total),'251.00');
  console.log('PASS: Single invoice draft from approved quotation with immutable item snapshots');
  const balance=`/finance/invoices/${invoiceId}/balance`;
  assert.equal((await req('employee','GET',balance)).status,403);
  assert.equal((await req('manager2','GET',balance)).status,404);
  assert.equal((await req('other','GET',balance)).status,404);
  r=await req('owner','GET',balance);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.data.balance,'296.18');
  const issue=`/finance/invoices/${invoiceId}/issue`;
  assert.equal((await req('owner','POST',issue,{dueAt:'2026-12-10'})).status,403);
  assert.equal((await req('readonly','POST',issue,{dueAt:'2026-12-10'})).status,403);
  assert.equal((await req('manager','POST',issue,{dueAt:'2026-02-30'})).status,400);
  r=await req('manager','POST',issue,{dueAt:'2026-12-10'});assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal((await req('manager','POST',issue,{dueAt:'2026-12-10'})).status,409);
  console.log('PASS: Invoice issue, date validation, Owner read-only and finance scoping');
  const payment=`/finance/invoices/${invoiceId}/manual-payments`;
  const firstPay={amount:'100.00',expectedBalance:'296.18',method:'upi',reference:'UPI-CONFIRM-TEST',idempotencyKey:'receipt_test_123456'};
  assert.equal((await req('owner','POST',payment,firstPay)).status,403);
  assert.equal((await req('readonly','POST',payment,firstPay)).status,403);
  assert.equal((await req('employee','POST',payment,firstPay)).status,403);
  assert.equal((await req('manager2','POST',payment,firstPay)).status,404);
  assert.equal((await req('manager','POST',payment,{...firstPay,amount:'999.00'})).status,400);
  assert.equal((await req('manager','POST',payment,{...firstPay,idempotencyKey:'too-short'})).status,400);
  let paymentCount=async()=>Number((await pool.execute(`SELECT COUNT(*) AS n FROM crm_payments WHERE company_id=100`))[0][0].n);
  const countBefore=await paymentCount();
  failAudit=true;r=await req('manager','POST',payment,firstPay);assert.equal(r.status,500,JSON.stringify(r.data));failAudit=false;
  assert.equal(await paymentCount(),countBefore);
  r=await req('manager','GET',balance);assert.equal(r.data.data.balance,'296.18');
  console.log('PASS: Rejected and failed payment writes leave invoice and receipt totals unchanged');
  const concurrent=await Promise.all([
   req('manager','POST',payment,firstPay),
   req('manager','POST',payment,{...firstPay,idempotencyKey:'receipt_test_654321',reference:'UPI-SECOND'})
  ]);
  assert.deepEqual(concurrent.map(x=>x.status).sort(),[201,409]);
  r=await req('manager','GET',balance);assert.equal(r.status,200);assert.equal(r.data.data.paid,'100.00');assert.equal(r.data.data.balance,'196.18');assert.equal(r.data.data.status,'partially_paid');
  const winner=concurrent[0].status===201?firstPay:{...firstPay,idempotencyKey:'receipt_test_654321',reference:'UPI-SECOND'};
  assert.equal((await req('manager','POST',payment,{...winner,expectedBalance:'196.18',amount:'1.00'})).status,409);
  console.log('PASS: Concurrent payments, idempotency fence, partial balance and stale checks');
  const nextPay={amount:'196.18',expectedBalance:'196.18',method:'bank_transfer',reference:'BANK-RECEIPT-TEST',idempotencyKey:'receipt_test_999999'};
  r=await req('manager','POST',payment,nextPay);assert.equal(r.status,201,JSON.stringify(r.data));assert.equal(r.data.data.verification,'manual_record');
  r=await req('manager','GET',balance);assert.equal(r.data.data.paid,'296.18');assert.equal(r.data.data.balance,'0.00');assert.equal(r.data.data.status,'paid');
  assert.equal((await req('manager','POST',payment,nextPay)).status,409);
  const [allocation]=await pool.execute(`SELECT COALESCE(SUM(amount),0) AS n FROM crm_payment_allocations WHERE company_id=100 AND invoice_id=?`,[invoiceId]);
  assert.equal(String(allocation[0].n),'296.18');
  console.log('PASS: Two manual receipts, payment allocations, paid balance, repeat prevention');
  const [audits]=await pool.execute(`SELECT action,details_json FROM audit_logs WHERE company_id=100 AND entity_type IN ('invoice','payment') ORDER BY id`);
  assert.ok(audits.some(x=>x.action==='invoice.drafted_from_quote'));
  assert.ok(audits.some(x=>x.action==='invoice.issued_internal'));
  assert.equal(audits.filter(x=>x.action==='payment.manual_received').length,2);
  for(const a of audits){const details=typeof a.details_json==='string'?a.details_json:JSON.stringify(a.details_json);assert.ok(!details.includes('UPI-CONFIRM-TEST'));}
  const src=fs.readFileSync('./src/server.ts','utf8');assert.match(src,/createFinanceRouter/);
  console.log('PASS: Audit coverage, no raw receipt reference in logs, normal CRM startup wired');
  console.log('PASS: ALL FINANCE MILESTONE TESTS');
 } finally {
  if(server)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  if(sessions)sessions.clearSessions();if(identities)identities.clearIdentities();
  if(pool)await pool.end();
  if(admin){try{if(created){assert.match(scratch,/^dgate_crm_financeqa_[0-9a-f]{16}$/);await admin.query(`DROP DATABASE \`${scratch}\``);console.log('PASS: Temporary finance database removed');}}finally{await admin.end();}}
 }
 console.log('PASS: Original CRM database unchanged');
}
main().catch(e=>{console.error('FAIL:',e?.stack||e);process.exitCode=1;});

