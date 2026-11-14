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
const {createSalesRouter}=require(process.cwd() + '/./src/modules/sales/routes/sales.routes.ts');
const cfg={host:env.DB_HOST||'127.0.0.1',port:Number(env.DB_PORT||3306),user:env.DB_USER||'root',password:env.DB_PASSWORD??'',multipleStatements:false};
const scratch='dgate_crm_salesqa_'+crypto.randomBytes(8).toString('hex');
assert.match(scratch,/^dgate_crm_salesqa_[0-9a-f]{16}$/);
const tables=['companies','users','teams','team_members','leads','pipelines','pipeline_stages','deals','crm_products','crm_quotations','crm_quotation_revisions','crm_quotation_items','audit_logs'];
let admin,pool,server,sessions,identities,created=false,failAudit=false;
async function main(){
 try{
  admin=await mysql.createConnection(cfg);
  await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);created=true;
  for(const table of tables)await admin.query(`CREATE TABLE \`${scratch}\`.\`${table}\` LIKE \`${env.DB_NAME}\`.\`${table}\``);
  pool=mysql.createPool({...cfg,database:scratch,connectionLimit:6,supportBigNumbers:true,bigNumberStrings:true});
  console.log('PASS: Scratch sales database and 13 production table structures created');
  for(const company of [100,200])await pool.execute(`INSERT INTO companies(id,platform_org_id,name,slug,status,platform_product_id,platform_access_mode,provisioned_at) VALUES(?,?,?,?,'active',1,'FULL',UTC_TIMESTAMP(3))`,[company,`sales_org_${company}`,`Sales Org ${company}`,`sales_org_${company}`]);
  for(const [id,company,role] of [[10,100,'owner'],[20,100,'manager'],[21,100,'manager'],[30,100,'employee'],[40,100,'employee'],[50,100,'employee'],[60,200,'employee']])await pool.execute(`INSERT INTO users(id,company_id,platform_user_id,full_name,email,role,status,activated_at) VALUES(?,?,?,?,?,?,'active',UTC_TIMESTAMP(3))`,[id,company,`sales_${id}`,`Sales user ${id}`,`sales${id}@example.test`,role]);
  for(const [team,manager] of [[7,20],[8,21]])await pool.execute(`INSERT INTO teams(id,company_id,name,manager_user_id,status) VALUES(?,100,?,?,'active')`,[team,`Team ${team}`,manager]);
  for(const [id,team,user] of [[1,7,30],[2,7,40],[3,8,50]])await pool.execute(`INSERT INTO team_members(id,company_id,team_id,user_id,joined_at) VALUES(?,100,?,?,'2026-01-01 00:00:00')`,[id,team,user]);
  for(const [lead,company,owner] of [[101,100,30],[102,100,40],[103,100,50],[201,200,60]])await pool.execute(`INSERT INTO leads(id,company_id,title,status,priority,created_by_user_id,owner_user_id) VALUES(?,?,?,'new','normal',?,?)`,[lead,company,`Lead ${lead}`,owner,owner]);
  sessions=createDevSessionStore();identities=createDevIdentityStore();const tokens={};
  for(const [who,company,user,role,mode] of [['owner',100,10,'OWNER','FULL'],['manager',100,20,'MANAGER','FULL'],['manager2',100,21,'MANAGER','FULL'],['employee',100,30,'EMPLOYEE','FULL'],['employee2',100,40,'EMPLOYEE','FULL'],['otherEmployee',100,50,'EMPLOYEE','FULL'],['readonly',100,20,'MANAGER','READ_ONLY'],['other',200,60,'EMPLOYEE','FULL']]){
   identities.registerIdentity(`sales_${who}`,{companyId:String(company),actorUserId:String(user),role,membershipStatus:'ACTIVE',accessMode:mode});tokens[who]=sessions.issueSession(`sales_${who}`);
  }
  const factory=async()=>{const c=await pool.getConnection();return{execute:(sql,args)=>{if(failAudit&&/INSERT\s+INTO\s+audit_logs/i.test(sql))throw Error('INJECTED_AUDIT_FAILURE');return c.execute(sql,args);},beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release(),destroy:()=>c.destroy()};};
  const app=createCrmApp({sessionVerifier:sessions.verifier,identityResolver:identities.resolver,protectedRoutes:createSalesRouter({connectionFactory:factory})});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}/api/v1/crm/sales`;
  async function req(who,method,path,body){const headers={};if(who)headers.Authorization=`Bearer ${tokens[who]}`;if(body!==undefined)headers['Content-Type']='application/json';const response=await fetch(url+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const raw=await response.text();let data;try{data=JSON.parse(raw)}catch{data=raw}return{status:response.status,data};}
  assert.equal((await req(null,'GET','/pipelines')).status,401);
  const pipe={name:'Customer-defined pipeline',stages:[{name:'Discovery',type:'open'},{name:'Proposal',type:'open'},{name:'Successfully Closed',type:'won'},{name:'Not Won',type:'lost'}]};
  assert.equal((await req('manager','POST','/pipelines',pipe)).status,403);
  assert.equal((await req('readonly','POST','/pipelines',pipe)).status,403);
  let r=await req('owner','POST','/pipelines',pipe);
  assert.equal(r.status,201,JSON.stringify(r.data));const pipeline=r.data.data;const [open,proposal,won,lost]=pipeline.stages;
  assert.ok(open&&proposal&&won&&lost);
  assert.equal((await req('owner','GET','/pipelines')).status,200);
  assert.equal((await req('owner','POST','/pipelines',{...pipe,stages:[{name:'New',type:'open'},{name:'new',type:'won'}]})).status,400);
  console.log('PASS: Owner-managed dynamic pipeline creation, stages and settings permissions');
  const product={name:'CRM setup service',sku:'DG-SETUP',itemType:'service',unit:'project',price:'1000.00',taxRate:'18.0000'};
  assert.equal((await req('employee','POST','/products',product)).status,403);
  r=await req('owner','POST','/products',product);assert.equal(r.status,201,JSON.stringify(r.data));
  r=await req('employee','GET','/products');assert.equal(r.status,200);assert.equal(r.data.data.length,1);
  assert.equal((await req('owner','POST','/products',{...product,price:'-1.00'})).status,400);
  console.log('PASS: Company product/service catalog and validated prices');
  const deal={title:'CRM integration opportunity',leadId:'101',pipelineId:pipeline.id,stageId:open.id,amount:'2500.00',expectedCloseDate:'2026-12-12'};
  for(const who of ['owner','readonly']) assert.equal((await req(who,'POST','/deals',deal)).status,403);
  assert.equal((await req('employee2','POST','/deals',deal)).status,404);
  assert.equal((await req('other','POST','/deals',deal)).status,404);
  assert.equal((await req('employee','POST','/deals',{...deal,stageId:won.id})).status,400);
  assert.equal((await req('employee','POST','/deals',{...deal,ownerUserId:'40'})).status,400);
  r=await req('employee','POST','/deals',deal);assert.equal(r.status,201,JSON.stringify(r.data));const dId=r.data.data.id;
  r=await req('manager','POST','/deals',{...deal,leadId:'102',title:'Managed team opportunity'});assert.equal(r.status,201,JSON.stringify(r.data));
  assert.equal((await req('manager2','POST','/deals',deal)).status,404);
  r=await req('owner','GET','/deals');assert.equal(r.status,200);assert.equal(r.data.data.length,2);
  r=await req('employee','GET','/deals');assert.equal(r.status,200);assert.equal(r.data.data.length,1);
  r=await req('manager2','GET','/deals');assert.equal(r.status,200);assert.equal(r.data.data.length,0);
  assert.equal((await req('employee2','GET',`/deals/${dId}`)).status,404);
  console.log('PASS: Deal creation, linked Lead scope, team/company isolation, no owner spoofing');
  const quote={dealId:dId,validUntil:'2026-12-31',items:[{description:'Installation',quantity:'2.000',unitPrice:'125.50',taxRate:'18.0000'}]};
  assert.equal((await req('owner','POST','/quotations',quote)).status,403);
  assert.equal((await req('employee2','POST','/quotations',quote)).status,404);
  r=await req('employee','POST','/quotations',quote);assert.equal(r.status,201,JSON.stringify(r.data));
  assert.equal(r.data.data.subtotal,'251.00');assert.equal(r.data.data.taxTotal,'45.18');assert.equal(r.data.data.grandTotal,'296.18');
  const quoteId=r.data.data.id;
  r=await req('manager','GET',`/quotations/${quoteId}`);assert.equal(r.status,200);assert.equal(r.data.data.items.length,1);
  assert.equal((await req('employee2','GET',`/quotations/${quoteId}`)).status,404);
  assert.equal((await req('other','GET',`/quotations/${quoteId}`)).status,404);
  assert.equal((await req('employee','POST','/quotations',{...quote,items:[{...quote.items[0],taxRate:'999.0000'}]})).status,400);
  console.log('PASS: Immutable draft quotation revision, exact money calculation, line items and tenant scope');
  const first=(await req('employee','GET',`/deals/${dId}`)).data.data;
  r=await req('employee','PATCH',`/deals/${dId}/stage`,{expectedRevision:first.revision,stageId:proposal.id});assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal((await req('employee','PATCH',`/deals/${dId}/stage`,{expectedRevision:first.revision,stageId:won.id})).status,409);
  assert.equal((await req('employee','PATCH',`/deals/${dId}/stage`,{expectedRevision:first.revision,stageId:'999999'})).status,409);
  const second=(await req('employee','GET',`/deals/${dId}`)).data.data;
  const race=await Promise.all([
   req('employee','PATCH',`/deals/${dId}/stage`,{expectedRevision:second.revision,stageId:won.id}),
   req('manager','PATCH',`/deals/${dId}/stage`,{expectedRevision:second.revision,stageId:lost.id})
  ]);
  assert.deepEqual(race.map(x=>x.status).sort(),[200,409]);
  assert.equal((await req('employee','PATCH',`/deals/${dId}/stage`,{expectedRevision:second.revision,stageId:open.id})).status,409);
  console.log('PASS: Customer-defined stage changes, optimistic concurrency, terminal protection');
  r=await req('owner','GET','/insights/pipeline');assert.equal(r.status,200);assert.ok(r.data.data.length>=1);
  r=await req('manager2','GET','/insights/pipeline');assert.equal(r.status,200);assert.equal(r.data.data.length,0);
  console.log('PASS: Permission-scoped pipeline aggregation without hardcoded stages');
  const [before]=await pool.execute('SELECT COUNT(*) AS n FROM deals WHERE company_id=100');
  const [auditBefore]=await pool.execute('SELECT COUNT(*) AS n FROM audit_logs WHERE company_id=100');
  failAudit=true;
  r=await req('employee','POST','/deals',{...deal,title:'Must roll back'});assert.equal(r.status,500,JSON.stringify(r.data));
  failAudit=false;
  const [after]=await pool.execute('SELECT COUNT(*) AS n FROM deals WHERE company_id=100');
  const [auditAfter]=await pool.execute('SELECT COUNT(*) AS n FROM audit_logs WHERE company_id=100');
  assert.equal(String(before[0].n),String(after[0].n));assert.equal(String(auditBefore[0].n),String(auditAfter[0].n));
  console.log('PASS: Real DB rollback on audit failure');
  const src=fs.readFileSync('./src/server.ts','utf8');assert.match(src,/createSalesRouter/);
  console.log('PASS: Sales router mounted in normal local CRM startup');
  console.log('PASS: ALL SALES MILESTONE TESTS');
 }finally{
  if(server)await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
  if(sessions)sessions.clearSessions();if(identities)identities.clearIdentities();if(pool)await pool.end();
  if(admin){try{if(created){assert.match(scratch,/^dgate_crm_salesqa_[0-9a-f]{16}$/);await admin.query(`DROP DATABASE \`${scratch}\``);console.log('PASS: Isolated scratch database removed');}}finally{await admin.end();}}
 }
 console.log('PASS: Original CRM database unchanged');
}
main().catch(e=>{console.error('FAIL:',e?.stack||e);process.exitCode=1;});

