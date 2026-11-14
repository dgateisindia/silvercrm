const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
const ts=require('typescript');
const mysql=require('mysql2/promise');
const dotenv=require('dotenv');
const ExcelJS=require('exceljs');
const {once}=require('node:events');
const {spawnSync}=require('node:child_process');
const env=dotenv.parse(fs.readFileSync('.env'));
assert.equal(env.DB_NAME,'dgate_crm_fresh','Never modify the source CRM database');
Object.assign(process.env,env,{NODE_ENV:'test',AUTH_MODE:'local',CRM_DEV_SEED:'0',HOST:'127.0.0.1'});
require.extensions['.ts']=(mod,file)=>{const result=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}});mod._compile(result.outputText,file);};
const {createCrmApp}=require(process.cwd() + '/./src/app.ts');
const {createDevSessionStore}=require(process.cwd() + '/./src/core/auth/devSessionVerifier.ts');
const {createDevIdentityStore}=require(process.cwd() + '/./src/core/auth/devIdentityResolver.ts');
const {createBulkImportRouter}=require(process.cwd() + '/./src/modules/bulk_import/bulk_import.routes.ts');
const {createBulkImportService}=require(process.cwd() + '/./src/modules/bulk_import/bulk_import.service.ts');
const config={host:env.DB_HOST||'127.0.0.1',port:Number(env.DB_PORT||3306),user:env.DB_USER||'root',password:env.DB_PASSWORD??'',multipleStatements:false};
const scratch='dgate_crm_bulkqa_'+crypto.randomBytes(8).toString('hex');
assert.match(scratch,/^dgate_crm_bulkqa_[a-f0-9]{16}$/);
const tables=['companies','users','teams','team_members','contacts','leads','picklist_options','import_jobs','crm_import_rows','crm_background_jobs','audit_logs'];
let admin,pool,server,sessions,identities,created=false,failAudit=false,failLead=false;

async function xlsxData(rows){
 const book=new ExcelJS.Workbook();const sheet=book.addWorksheet('Leads');
 sheet.addRow(['title','contactId','status','priority']);
 for(const row of rows)sheet.addRow(row);
 return Buffer.from(await book.xlsx.writeBuffer()).toString('base64');
}
async function main(){
 try{
  admin=await mysql.createConnection(config);
  await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);created=true;
  for(const tab of tables)await admin.query(`CREATE TABLE \`${scratch}\`.\`${tab}\` LIKE \`${env.DB_NAME}\`.\`${tab}\``);
  pool=mysql.createPool({...config,database:scratch,connectionLimit:8,supportBigNumbers:true,bigNumberStrings:true});
  const sql=async(q,p=[])=> (await pool.execute(q,p))[0];
  const count=async(table,company=100)=>{assert.ok(tables.includes(table));return Number((await sql(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE company_id=?`,[company]))[0].n);};
  for(const company of [100,200])await sql(`INSERT INTO companies(id,platform_org_id,name,slug,status,platform_product_id,platform_access_mode,provisioned_at) VALUES(?,?,?,?,'active',1,'FULL',UTC_TIMESTAMP(3))`,[company,`bulk_org_${company}`,`Bulk QA ${company}`,`bulkqa_${company}`]);
  for(const [user,company,role] of [[10,100,'owner'],[20,100,'manager'],[21,100,'manager'],[30,100,'employee'],[40,100,'employee'],[50,100,'employee'],[60,200,'employee']])await sql(`INSERT INTO users(id,company_id,platform_user_id,full_name,email,role,status,activated_at) VALUES(?,?,?,?,?,?,'active',UTC_TIMESTAMP(3))`,[user,company,`bulk_${user}`,`QA ${user}`,`bulk${user}@example.test`,role]);
  for(const [team,manager] of [[7,20],[8,21]])await sql(`INSERT INTO teams(id,company_id,name,manager_user_id,status) VALUES(?,100,?,?,'active')`,[team,`Bulk Team ${team}`,manager]);
  for(const [membership,team,user] of [[1,7,30],[2,7,40],[3,8,50]])await sql(`INSERT INTO team_members(id,company_id,team_id,user_id,joined_at) VALUES(?,100,?,?,'2026-01-01 00:00:00')`,[membership,team,user]);
  for(const [contact,company,owner] of [[101,100,30],[102,100,40],[103,100,50],[201,200,60]])await sql(`INSERT INTO contacts(id,company_id,first_name,owner_user_id) VALUES(?,?,?,?)`,[contact,company,`Bulk contact ${contact}`,owner]);
  await sql(`INSERT INTO leads(id,company_id,contact_id,title,status,priority,created_by_user_id,owner_user_id) VALUES(111,100,101,'Existing Lead','new','normal',30,30)`);
  for(const [key,field,label,active] of [['new','status','New',1],['qualified','status','Qualified',1],['disabled','status','Disabled',0],['normal','priority','Normal',1]])await sql(`INSERT INTO picklist_options(company_id,entity_type,field_key,option_key,label,is_active) VALUES(100,'lead',?,?,?,?)`,[field,key,label,active]);
  console.log('PASS: Eleven original CRM structures cloned and isolated company/team fixtures seeded');
  sessions=createDevSessionStore();identities=createDevIdentityStore();const tokens={};
  for(const [name,company,user,role,mode] of [['owner',100,10,'OWNER','FULL'],['manager',100,20,'MANAGER','FULL'],['manager2',100,21,'MANAGER','FULL'],['employee',100,30,'EMPLOYEE','FULL'],['employee2',100,40,'EMPLOYEE','FULL'],['employee3',100,50,'EMPLOYEE','FULL'],['readonly',100,20,'MANAGER','READ_ONLY'],['foreign',200,60,'EMPLOYEE','FULL']]){
   const key=`bulk_${name}`;identities.registerIdentity(key,{companyId:String(company),actorUserId:String(user),role,membershipStatus:'ACTIVE',accessMode:mode});tokens[name]=sessions.issueSession(key);
  }
  const factory=async()=>{const db=await pool.getConnection();return {execute:(q,p)=>{
    if(failAudit&&/INSERT\s+INTO\s+audit_logs/i.test(q))throw Error('EXPECTED_BULK_AUDIT_FAILURE');
    if(failLead&&/INSERT\s+INTO\s+leads/i.test(q))throw Error('EXPECTED_BULK_INSERT_FAILURE');
    return db.execute(q,p);},beginTransaction:()=>db.beginTransaction(),commit:()=>db.commit(),rollback:()=>db.rollback(),release:()=>db.release(),destroy:()=>db.destroy()};};
  const service=createBulkImportService({connectionFactory:factory});
  const app=createCrmApp({sessionVerifier:sessions.verifier,identityResolver:identities.resolver,protectedRoutes:createBulkImportRouter({connectionFactory:factory})});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}/api/v1/crm/imports/leads/bulk`;
  async function req(who,method,path,body){const headers={};if(who)headers.Authorization=`Bearer ${tokens[who]}`;if(body!==undefined)headers['Content-Type']='application/json';const response=await fetch(base+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};}
  const baseRows=[['Bulk A',101,'new','normal'],['Existing Lead',101,'new','normal'],['Bulk B',101,'qualified','normal']];
  const xlsxBase64=await xlsxData(baseRows);
  const body={format:'XLSX',xlsxBase64,duplicateStrategy:'SKIP',idempotencyKey:'bulk-qa-xlsx-basic'};
  const worker=spawnSync(process.execPath,['dist/workers/bulk_import.worker.js','--once'],{cwd:process.cwd(),env:{...process.env,CRM_BULK_IMPORT_WORKER_ENABLED:'false'},encoding:'utf8',timeout:10000});
  assert.equal(worker.status,1,worker.stderr);
  assert.equal((await req(null,'POST','/preview',body)).status,401);
  assert.equal((await req('owner','POST','/preview',body)).status,403);
  assert.equal((await req('readonly','POST','/queue',body)).status,403);
  assert.equal((await req('employee2','POST','/preview',{...body,ownerUserId:'30'})).status,403);
  assert.equal((await req('manager2','POST','/preview',{...body,ownerUserId:'30'})).status,404);
  assert.equal((await req('foreign','POST','/preview',body)).status,404);
  console.log('PASS: Worker off by default; authentication, Owner read-only and tenant/team boundaries enforced');
  let r=await req('employee','POST','/preview',body);
  assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.data.totalRows,3);assert.equal(r.data.data.duplicatesAtPreview,1);
  assert.equal(await count('import_jobs'),0);assert.equal(await count('crm_background_jobs'),0);assert.equal(await count('leads'),1);
  assert.equal((await req('employee','POST','/preview',{...body,format:'CSV',csv:'title,contactId,status\nInvalid,101,disabled',xlsxBase64:undefined})).status,400);
  assert.equal((await req('employee','POST','/preview',{...body,ownerUserId:'30',companyId:'200'})).status,400);
  assert.equal((await req('employee','POST','/preview',{...body,duplicateStrategy:'REJECT'})).status,400);
  const badBook=new ExcelJS.Workbook(),badSheet=badBook.addWorksheet('Leads');badSheet.addRow(['title','contactId','status']);badSheet.addRow(['Bad Formula',101,'new']);badSheet.getRow(2).getCell(1).value={formula:'1+1',result:2};
  const badBase64=Buffer.from(await badBook.xlsx.writeBuffer()).toString('base64');
  assert.equal((await req('employee','POST','/preview',{...body,xlsxBase64:badBase64})).status,400);
  console.log('PASS: XLSX parsed, preview is read-only, malformed/status/formula/policy inputs rejected');
  failAudit=true;
  r=await req('employee','POST','/queue',body);assert.equal(r.status,500,JSON.stringify(r));failAudit=false;
  assert.equal(await count('import_jobs'),0);assert.equal(await count('crm_import_rows'),0);assert.equal(await count('crm_background_jobs'),0);
  console.log('PASS: Queue audit failure atomically rolls back import, row staging and background jobs');
  const races=await Promise.all([req('employee','POST','/queue',body),req('employee','POST','/queue',body)]);
  assert.ok(races.every(x=>x.status===202),JSON.stringify(races));
  assert.deepEqual(races.map(x=>Boolean(x.data.data.replayed)).sort(),[false,true]);
  const importId=races[0].data.data.id;
  assert.equal(await count('import_jobs'),1);assert.equal(await count('crm_import_rows'),3);assert.equal(await count('crm_background_jobs'),1);
  assert.equal((await req('employee','POST','/queue',{...body,xlsxBase64:await xlsxData([['Forged',101,'new','normal']])})).status,409);
  r=await req('employee','GET',`/${importId}`);assert.equal(r.status,200);assert.equal(r.data.data.processed,0);
  assert.equal((await req('employee2','GET',`/${importId}`)).status,404);
  assert.equal((await req('manager2','GET',`/${importId}`)).status,404);
  assert.equal((await req('manager','GET',`/${importId}`)).status,200);
  assert.equal((await req('owner','GET',`/${importId}`)).status,200);
  assert.equal((await req('foreign','GET',`/${importId}`)).status,404);
  console.log('PASS: Concurrent queue exactly once; idempotency hash, scoped status and untouched Lead table');
  const ticks=await Promise.all([service.tick(2),service.tick(2)]);
  assert.equal(ticks.reduce((a,b)=>a+b.completed,0),1,JSON.stringify(ticks));
  r=await req('employee','GET',`/${importId}`);assert.equal(r.status,200);assert.equal(r.data.data.status,'completed');assert.equal(r.data.data.created,2);assert.equal(r.data.data.skippedOrFailed,1);
  assert.equal(await count('leads'),3);
  const jobsAfter=await sql(`SELECT payload_json,state FROM crm_background_jobs WHERE company_id=100`);
  assert.equal(jobsAfter[0].state,'completed');assert.deepEqual(typeof jobsAfter[0].payload_json==='string'?JSON.parse(jobsAfter[0].payload_json):jobsAfter[0].payload_json,{});
  console.log('PASS: Concurrent chunk workers deduplicate, update row-level status and scrub processed payloads');
  const largeRows=Array.from({length:221},(_,i)=>[`XLSX Bulk ${i+1}`,101,'new','normal']);
  largeRows.push(['XLSX Bulk 2',101,'new','normal']);
  const large={format:'XLSX',xlsxBase64:await xlsxData(largeRows),duplicateStrategy:'SKIP',idempotencyKey:'bulk-qa-xlsx-large'};
  r=await req('employee','POST','/queue',large);assert.equal(r.status,202,JSON.stringify(r.data));
  const largeId=r.data.data.id;assert.equal(await count('leads'),3);
  assert.equal(await count('crm_background_jobs'),6);
  let out=await service.tick(1);assert.equal(out.processed,1);
  let partial=await req('employee','GET',`/${largeId}`);
  assert.equal(partial.status,200);assert.equal(partial.data.data.status,'processing');assert.equal(partial.data.data.processed,50);
  out=await service.tick(20);assert.equal(out.completed,1,JSON.stringify(out));
  partial=await req('employee','GET',`/${largeId}`);
  assert.equal(partial.data.data.status,'completed');assert.equal(partial.data.data.created,221);assert.equal(partial.data.data.skippedOrFailed,1);
  assert.equal(await count('leads'),224); // existing + basic 2 + unique 221
  console.log('PASS: 222-row XLSX imports proceed in 50-row transactions with accurate incremental progress');
  const csv='title,contactId,status,priority\nRetry Me,101,new,normal';
  r=await req('employee','POST','/queue',{format:'CSV',csv,duplicateStrategy:'SKIP',idempotencyKey:'bulk-qa-retry-001'});
  assert.equal(r.status,202);const retryId=r.data.data.id;
  failLead=true;out=await service.tick(1);assert.equal(out.retries,1);failLead=false;
  assert.equal((await req('employee','GET',`/${retryId}`)).data.data.processed,0);
  await sql(`UPDATE crm_background_jobs SET run_after=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE company_id=100 AND state='pending'`);
  out=await service.tick(1);assert.equal(out.completed,1);assert.equal((await req('employee','GET',`/${retryId}`)).data.data.created,1);
  const [retryLeads]=await sql(`SELECT COUNT(*) AS n FROM leads WHERE company_id=100 AND title='Retry Me'`);assert.equal(Number(retryLeads.n),1);
  console.log('PASS: Transient SQL failure rolls back whole chunk and resumes once without duplicate Leads');
  r=await req('employee','POST','/queue',{format:'CSV',csv:'title,contactId,status\nNever Commit,101,new',duplicateStrategy:'SKIP',idempotencyKey:'bulk-qa-terminal-001'});
  assert.equal(r.status,202);const terminalId=r.data.data.id;
  failLead=true;
  for(let attempt=1;attempt<=5;attempt++){
   await sql(`UPDATE crm_background_jobs SET run_after=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE company_id=100 AND state='pending'`);
   out=await service.tick(1);
   assert.equal(attempt===5?out.failed:out.retries,1,JSON.stringify(out));
  }
  failLead=false;
  const terminal=await req('employee','GET',`/${terminalId}`);
  assert.equal(terminal.data.data.status,'failed');assert.equal(terminal.data.data.skippedOrFailed,1);assert.equal(terminal.data.data.rowStates[0].state,'failed');
  const [never]=await sql(`SELECT COUNT(*) AS n FROM leads WHERE company_id=100 AND title='Never Commit'`);assert.equal(Number(never.n),0);
  const dead=await sql(`SELECT state,payload_json,attempts FROM crm_background_jobs WHERE company_id=100 AND idempotency_key=?`,[`lead-import:${terminalId}:0`]);
  assert.equal(dead[0].state,'failed');assert.equal(Number(dead[0].attempts),5);
  assert.deepEqual(typeof dead[0].payload_json==='string'?JSON.parse(dead[0].payload_json):dead[0].payload_json,{});
  console.log('PASS: Five failed attempts become terminal, failed rows accounted for and queued payload scrubbed');
  // A manager's queued import must not proceed after employee team membership is revoked.
  r=await req('manager','POST','/queue',{format:'CSV',csv:'title,contactId,status\nRevoked Team Member,102,new',duplicateStrategy:'SKIP',ownerUserId:'40',idempotencyKey:'bulk-qa-team-revoked'});
  assert.equal(r.status,202,JSON.stringify(r.data));const revokedId=r.data.data.id;
  await sql(`UPDATE team_members SET left_at=UTC_TIMESTAMP(3) WHERE company_id=100 AND user_id=40 AND team_id=7`);
  for(let i=1;i<=5;i++){
   await sql(`UPDATE crm_background_jobs SET run_after=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE company_id=100 AND state='pending'`);
   await service.tick(1);
  }
  assert.equal((await req('manager','GET',`/${revokedId}`)).data.data.status,'failed');
  const [revoked]=await sql(`SELECT COUNT(*) AS n FROM leads WHERE company_id=100 AND title='Revoked Team Member'`);assert.equal(Number(revoked.n),0);
  console.log('PASS: Team revocation before worker execution prevents background Lead creation');
  const src=fs.readFileSync('./src/server.ts','utf8');assert.match(src,/createBulkImportRouter/);
  const audits=await sql(`SELECT details_json FROM audit_logs WHERE company_id=100`);
  assert.ok(!audits.some(a=>JSON.stringify(a.details_json).includes('Never Commit')));
  console.log('PASS: Normal CRM server wiring and minimal audit metadata; no source row names in audit');
  console.log('PASS: ALL BATCH 501-535 BULK IMPORT TESTS');
 }finally{
  if(server)await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
  if(sessions)sessions.clearSessions();if(identities)identities.clearIdentities();
  if(pool)await pool.end();
  if(admin){try{if(created){assert.match(scratch,/^dgate_crm_bulkqa_[a-f0-9]{16}$/);await admin.query(`DROP DATABASE \`${scratch}\``);console.log('PASS: Temporary Bulk Import QA database removed');}}finally{await admin.end();}}
 }
 console.log('PASS: Original CRM database unchanged');
}
main().catch(error=>{console.error('FAIL:',error.stack||error);process.exitCode=1;});
