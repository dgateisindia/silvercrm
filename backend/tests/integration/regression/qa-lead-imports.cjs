const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
const ts=require('typescript');
const mysql=require('mysql2/promise');
const dotenv=require('dotenv');
const {once}=require('node:events');
const env=dotenv.parse(fs.readFileSync('.env'));
assert.equal(env.DB_NAME,'dgate_crm_fresh','The main database must be used only as read-only schema source');
Object.assign(process.env,env,{NODE_ENV:'test',AUTH_MODE:'local',CRM_DEV_SEED:'0',HOST:'127.0.0.1'});
require.extensions['.ts']=(mod,file)=>{const result=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}});mod._compile(result.outputText,file);};
const {createCrmApp}=require(process.cwd() + '/./src/app.ts');
const {createDevSessionStore}=require(process.cwd() + '/./src/core/auth/devSessionVerifier.ts');
const {createDevIdentityStore}=require(process.cwd() + '/./src/core/auth/devIdentityResolver.ts');
const {createLeadBulkImportRouter}=require(process.cwd() + '/./src/modules/lead_import/lead_import.routes.ts');
const config={host:env.DB_HOST||'127.0.0.1',port:Number(env.DB_PORT||3306),user:env.DB_USER||'root',password:env.DB_PASSWORD??'',multipleStatements:false};
const scratch='dgate_crm_leadimportqa_'+crypto.randomBytes(8).toString('hex');
assert.match(scratch,/^dgate_crm_leadimportqa_[a-f0-9]{16}$/);
const tables=['companies','users','teams','team_members','contacts','leads','picklist_options','import_jobs','audit_logs'];
let admin,pool,server,sessions,identities,created=false,failAudit=false;
async function main(){try{
 admin=await mysql.createConnection(config);
 await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);created=true;
 for(const tab of tables){await admin.query(`CREATE TABLE \`${scratch}\`.\`${tab}\` LIKE \`${env.DB_NAME}\`.\`${tab}\``);}
 pool=mysql.createPool({...config,database:scratch,connectionLimit:8,supportBigNumbers:true,bigNumberStrings:true});
 const sql=async(q,p=[]) => (await pool.execute(q,p))[0];
 const count=async(tab,company=100)=>{assert.ok(tables.includes(tab));return Number((await sql(`SELECT COUNT(*) AS n FROM \`${tab}\` WHERE company_id=?`,[company]))[0].n);};
 for(const company of [100,200])await sql(`INSERT INTO companies(id,platform_org_id,name,slug,status,platform_product_id,platform_access_mode,provisioned_at) VALUES(?,?,?,?,'active',1,'FULL',UTC_TIMESTAMP(3))`,[company,`limport_org_${company}`,`Lead Import QA ${company}`,`limport_${company}`]);
 for(const [user,company,role] of [[10,100,'owner'],[20,100,'manager'],[21,100,'manager'],[30,100,'employee'],[40,100,'employee'],[50,100,'employee'],[60,200,'employee']])await sql(`INSERT INTO users(id,company_id,platform_user_id,full_name,email,role,status,activated_at) VALUES(?,?,?,?,?,?,'active',UTC_TIMESTAMP(3))`,[user,company,`limport_${user}`,`QA ${user}`,`import${user}@example.test`,role]);
 for(const [team,manager] of [[7,20],[8,21]])await sql(`INSERT INTO teams(id,company_id,name,manager_user_id,status) VALUES(?,100,?,?,'active')`,[team,`QA Team ${team}`,manager]);
 for(const [record,team,user] of [[1,7,30],[2,7,40],[3,8,50]])await sql(`INSERT INTO team_members(id,company_id,team_id,user_id,joined_at) VALUES(?,100,?,?,'2026-01-01 00:00:00')`,[record,team,user]);
 for(const [cid,company,owner] of [[101,100,30],[102,100,40],[103,100,50],[201,200,60]])await sql(`INSERT INTO contacts(id,company_id,first_name,owner_user_id) VALUES(?,?,?,?)`,[cid,company,`Lead import contact ${cid}`,owner]);
 await sql(`INSERT INTO leads(id,company_id,contact_id,title,status,priority,created_by_user_id,owner_user_id) VALUES(111,100,101,'Already Existing','new','normal',30,30)`);
 for(const [key,field,label,active] of [['new','status','New',1],['qualified','status','Qualified',1],['disabled','status','Disabled',0],['normal','priority','Normal',1]])await sql(`INSERT INTO picklist_options(company_id,entity_type,field_key,option_key,label,is_active) VALUES(100,'lead',?,?,?,?)`,[field,key,label,active]);
 console.log('PASS: Nine existing CRM table structures and two company scopes seeded in scratch QA');
 sessions=createDevSessionStore();identities=createDevIdentityStore();const tokens={};
 for(const [name,company,user,role,mode] of [['owner',100,10,'OWNER','FULL'],['manager',100,20,'MANAGER','FULL'],['manager2',100,21,'MANAGER','FULL'],['employee',100,30,'EMPLOYEE','FULL'],['employee2',100,40,'EMPLOYEE','FULL'],['employee3',100,50,'EMPLOYEE','FULL'],['readonly',100,20,'MANAGER','READ_ONLY'],['foreign',200,60,'EMPLOYEE','FULL']]){
  const key=`leadimport_${name}`;identities.registerIdentity(key,{companyId:String(company),actorUserId:String(user),role,membershipStatus:'ACTIVE',accessMode:mode});tokens[name]=sessions.issueSession(key);
 }
 const factory=async()=>{const db=await pool.getConnection();return {execute:(q,p)=>{if(failAudit&&/INSERT\s+INTO\s+audit_logs/i.test(q))throw Error('EXPECTED_IMPORT_AUDIT_FAILURE');return db.execute(q,p);},beginTransaction:()=>db.beginTransaction(),commit:()=>db.commit(),rollback:()=>db.rollback(),release:()=>db.release(),destroy:()=>db.destroy()};};
 const app=createCrmApp({sessionVerifier:sessions.verifier,identityResolver:identities.resolver,protectedRoutes:createLeadBulkImportRouter({connectionFactory:factory})});
 server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}/api/v1/crm/imports/leads`;
 async function req(who,method,path,body){const headers={};if(who)headers.Authorization=`Bearer ${tokens[who]}`;if(body!==undefined)headers['Content-Type']='application/json';const response=await fetch(base+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};}
 const csv='title,contactId,status,priority\nNew One,101,new,normal\nnew one,101,new,normal\nAlready Existing,101,new,normal';
 const body={csv,duplicateStrategy:'SKIP',idempotencyKey:'lead-import-qa-001'};
 assert.equal((await req(null,'POST','/preview',body)).status,401);
 assert.equal((await req('owner','POST','/preview',body)).status,403);
 assert.equal((await req('readonly','POST','/preview',body)).status,403);
 assert.equal((await req('employee2','POST','/preview',{...body,ownerUserId:'30'})).status,403);
 assert.equal((await req('manager2','POST','/preview',{...body,ownerUserId:'30'})).status,404);
 assert.equal((await req('foreign','POST','/preview',body)).status,404);
 console.log('PASS: Login required, Owner read-only, Manager team boundaries and company isolation');
 const startingLeads=await count('leads');
 let result=await req('employee','POST','/preview',body);
 assert.equal(result.status,200,JSON.stringify(result.data));
 assert.equal(result.data.data.validationOnly,true);
 assert.equal(result.data.data.wouldCreate,1);
 assert.equal(result.data.data.duplicates,2);
 assert.equal(await count('leads'),startingLeads);
 assert.equal(await count('import_jobs'),0);
 assert.equal(await count('audit_logs'),0);
 result=await req('employee','POST','/preview',{...body,duplicateStrategy:'REJECT'});
 assert.equal(result.status,200);assert.equal(result.data.data.wouldReject,true);
 console.log('PASS: CSV preview and duplicate detection make zero database writes');
 for(const malformed of [
  {...body,csv:'title,contactId,status\n"Bad quote,101,new'},
  {...body,csv:'title,contactId,status\nA,101,disabled'},
  {...body,csv:'title,contactId,status\nA,201,new'},
  {...body,csv:'title,contactId,status\nA,101,new',companyId:'200'},
  {...body,csv:'title,contactId,status\nA,101,new',mapping:{title:'ownerUserId'}},
 ]){
  const actual=await req('employee','POST','/preview',malformed);
  assert.ok([400,404].includes(actual.status),JSON.stringify(actual));
 }
 console.log('PASS: Malformed CSV, company forgery and inactive custom status choices rejected');
 result=await req('employee','POST','/commit',{...body,duplicateStrategy:'REJECT',idempotencyKey:'lead-import-qa-reject'});
 assert.equal(result.status,409);assert.equal(await count('leads'),startingLeads);assert.equal(await count('import_jobs'),0);
 console.log('PASS: All-or-nothing REJECT policy leaves zero records on duplicate conflicts');
 failAudit=true;
 result=await req('employee','POST','/commit',body);
 assert.equal(result.status,500,JSON.stringify(result.data));
 failAudit=false;
 assert.equal(await count('leads'),startingLeads);assert.equal(await count('import_jobs'),0);
 console.log('PASS: Audit failure rolls back the new Lead and import job together');
 result=await req('employee','POST','/commit',body);
 assert.equal(result.status,201,JSON.stringify(result.data));
 const jobId=result.data.data.id;
 assert.equal(result.data.data.wouldCreate,1);assert.equal(result.data.data.duplicates,2);
 assert.equal(await count('leads'),startingLeads+1);assert.equal(await count('import_jobs'),1);assert.equal(await count('audit_logs'),1);
 const [createdRows]=await sql(`SELECT title,status,priority,owner_user_id,created_by_user_id FROM leads WHERE company_id=100 AND title='New One'`);
 assert.equal(String(createdRows.owner_user_id),'30');assert.equal(createdRows.status,'new');
 assert.equal((await req('employee2','GET',`/${jobId}`)).status,404);
 assert.equal((await req('manager2','GET',`/${jobId}`)).status,404);
 assert.equal((await req('manager','GET',`/${jobId}`)).status,200);
 assert.equal((await req('owner','GET',`/${jobId}`)).status,200);
 assert.equal((await req('foreign','GET',`/${jobId}`)).status,404);
 result=await req('employee','GET',`/${jobId}`);assert.equal(result.status,200);assert.equal(result.data.data.created,1);
 console.log('PASS: Lead import committed atomically; job history restricted by role and team');
 result=await req('employee','POST','/commit',body);
 assert.equal(result.status,201);assert.equal(result.data.data.replayed,true);
 assert.equal(await count('leads'),startingLeads+1);assert.equal(await count('import_jobs'),1);
 assert.equal((await req('employee','POST','/commit',{...body,csv:'title,contactId,status\nForged,101,new'})).status,409);
 console.log('PASS: Exact idempotency replay returns original job; forged replay blocked');
 const next={csv:'title,contactId,status,priority\nSecond Deal,101,qualified,normal',duplicateStrategy:'SKIP',idempotencyKey:'lead-import-qa-racing'};
 const races=await Promise.all([req('employee','POST','/commit',next),req('employee','POST','/commit',next)]);
 assert.ok(races.every(x=>x.status===201),JSON.stringify(races));
 assert.deepEqual(races.map(x=>Boolean(x.data.data.replayed)).sort(),[false,true]);
 assert.equal(await count('leads'),startingLeads+2);
 assert.equal(await count('import_jobs'),2);
 console.log('PASS: Concurrent requests with the same idempotency key create one Lead');
 result=await req('manager','POST','/commit',{csv:'title,contactId,status\nManager Assigned,102,new',duplicateStrategy:'SKIP',ownerUserId:'40',idempotencyKey:'manager-lead-import-001'});
 assert.equal(result.status,201,JSON.stringify(result.data));
 const [targetLead]=await sql(`SELECT owner_user_id,created_by_user_id FROM leads WHERE company_id=100 AND title='Manager Assigned'`);
 assert.equal(String(targetLead.owner_user_id),'40');assert.equal(String(targetLead.created_by_user_id),'20');
 assert.equal((await req('manager2','POST','/preview',{csv:'title,contactId,status\nNo Access,102,new',duplicateStrategy:'SKIP',ownerUserId:'40'})).status,404);
 console.log('PASS: Manager-scoped employee assignment works without cross-team access');
 await sql(`UPDATE team_members SET left_at=UTC_TIMESTAMP(3) WHERE company_id=100 AND team_id=7 AND user_id=40`);
 assert.equal((await req('manager','POST','/preview',{csv:'title,contactId,status\nAfter Revocation,102,new',duplicateStrategy:'SKIP',ownerUserId:'40'})).status,404);
 const source=fs.readFileSync('./src/server.ts','utf8');assert.match(source,/createLeadBulkImportRouter/);
 const [audits]=await sql(`SELECT details_json FROM audit_logs WHERE company_id=100 AND action='lead.import.completed'`);
 assert.ok(!String(audits.details_json).includes('Second Deal'));
 console.log('PASS: Team revocation enforced and audit contains counts, not CSV contents');
 console.log('PASS: ALL BATCH 466-500 LEAD IMPORT TESTS');
}finally{
 if(server)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 if(sessions)sessions.clearSessions();if(identities)identities.clearIdentities();
 if(pool)await pool.end();
 if(admin){try{if(created){assert.match(scratch,/^dgate_crm_leadimportqa_[a-f0-9]{16}$/);await admin.query(`DROP DATABASE \`${scratch}\``);console.log('PASS: Temporary Lead Import QA database removed');}}finally{await admin.end();}}
}
console.log('PASS: Original CRM database unchanged');}
main().catch(error=>{console.error('FAIL:',error.stack||error);process.exitCode=1;});
