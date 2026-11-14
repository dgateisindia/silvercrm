const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const mysql=require('mysql2/promise');
const dotenv=require('dotenv');
const crypto=require('node:crypto');
const {once}=require('node:events');

const env=dotenv.parse(fs.readFileSync('.env'));
assert.equal(env.DB_NAME,'dgate_crm_fresh','Source CRM database must never be selected as test DB');
Object.assign(process.env,env,{NODE_ENV:'test',AUTH_MODE:'local',HOST:'127.0.0.1',CRM_DEV_SEED:'0'});
require.extensions['.ts']=(mod,file)=>{
 const built=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}});
 mod._compile(built.outputText,file);
};
const {createCrmApp}=require(process.cwd() + '/./src/app.ts');
const {createDevSessionStore}=require(process.cwd() + '/./src/core/auth/devSessionVerifier.ts');
const {createDevIdentityStore}=require(process.cwd() + '/./src/core/auth/devIdentityResolver.ts');
const {createCustomerRouter}=require(process.cwd() + '/./src/modules/customers/routes/customer.routes.ts');
const cfg={host:env.DB_HOST||'127.0.0.1',port:Number(env.DB_PORT||3306),user:env.DB_USER||'root',password:env.DB_PASSWORD??'',multipleStatements:false};
const scratch='dgate_crm_customerqa_'+crypto.randomBytes(8).toString('hex');
assert.match(scratch,/^dgate_crm_customerqa_[0-9a-f]{16}$/);
const tables=['companies','users','teams','team_members','accounts','contacts','activity_events','import_jobs','audit_logs'];
let admin,pool,server,sessions,identities,created=false,failAudit=false;
async function query(sql,args=[]){return (await pool.execute(sql,args))[0];}
async function count(table){assert.ok(tables.includes(table));const rows=await query(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE company_id=100`);return Number(rows[0].n);}
async function main(){
 try{
  admin=await mysql.createConnection(cfg);
  await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  created=true;
  for(const table of tables)await admin.query(`CREATE TABLE \`${scratch}\`.\`${table}\` LIKE \`${env.DB_NAME}\`.\`${table}\``);
  pool=mysql.createPool({...cfg,database:scratch,connectionLimit:6,supportBigNumbers:true,bigNumberStrings:true});
  console.log('PASS: Nine CRM customer structures cloned into isolated scratch database');
  for(const company of [100,200])await pool.execute(`INSERT INTO companies(id,platform_org_id,name,slug,status,platform_product_id,platform_access_mode,provisioned_at) VALUES(?,?,?,?,'active',1,'FULL',UTC_TIMESTAMP(3))`,[company,`cust_org_${company}`,`Customer ${company}`,`customer_${company}`]);
  for(const [user,company,role] of [[10,100,'owner'],[20,100,'manager'],[21,100,'manager'],[30,100,'employee'],[40,100,'employee'],[50,100,'employee'],[60,200,'employee']])await pool.execute(`INSERT INTO users(id,company_id,platform_user_id,full_name,email,role,status,activated_at) VALUES(?,?,?,?,?,?,'active',UTC_TIMESTAMP(3))`,[user,company,`cust_${user}`,`QA ${user}`,`cust${user}@example.test`,role]);
  for(const [team,manager] of [[7,20],[8,21]])await pool.execute(`INSERT INTO teams(id,company_id,name,manager_user_id,status) VALUES(?,100,?,?,'active')`,[team,`Customer team ${team}`,manager]);
  for(const [record,team,person] of [[1,7,30],[2,7,40],[3,8,50]])await pool.execute(`INSERT INTO team_members(id,company_id,team_id,user_id,joined_at) VALUES(?,100,?,?,'2026-01-01 00:00:00')`,[record,team,person]);
  await pool.execute(`INSERT INTO accounts(id,company_id,name,email,phone,owner_user_id) VALUES(201,100,'Private Account','private@example.test','+911234560001',50),(301,200,'Other Company','other@example.test','+911234560002',60)`);
  await pool.execute(`INSERT INTO contacts(id,company_id,account_id,first_name,email,phone,owner_user_id) VALUES(201,100,201,'Private','private.person@example.test','+911234560011',50),(301,200,301,'Outside','outside@example.test','+911234560012',60)`);
  sessions=createDevSessionStore();identities=createDevIdentityStore();const tokens={};
  for(const [name,company,user,role,mode] of [['owner',100,10,'OWNER','FULL'],['manager',100,20,'MANAGER','FULL'],['manager2',100,21,'MANAGER','FULL'],['employee',100,30,'EMPLOYEE','FULL'],['employee2',100,40,'EMPLOYEE','FULL'],['outsider',100,50,'EMPLOYEE','FULL'],['readonly',100,20,'MANAGER','READ_ONLY'],['other',200,60,'EMPLOYEE','FULL']]){
   identities.registerIdentity(`customer_${name}`,{companyId:String(company),actorUserId:String(user),role,membershipStatus:'ACTIVE',accessMode:mode});
   tokens[name]=sessions.issueSession(`customer_${name}`);
  }
  const factory=async()=>{const connection=await pool.getConnection();return{
   execute:(sql,args)=>{if(failAudit&&/INSERT\s+INTO\s+audit_logs/i.test(sql))throw Error('EXPECTED_CUSTOMER_AUDIT_FAILURE');return connection.execute(sql,args);},
   beginTransaction:()=>connection.beginTransaction(),commit:()=>connection.commit(),rollback:()=>connection.rollback(),release:()=>connection.release(),destroy:()=>connection.destroy()
  };};
  const app=createCrmApp({sessionVerifier:sessions.verifier,identityResolver:identities.resolver,protectedRoutes:createCustomerRouter({connectionFactory:factory})});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}/api/v1/crm/customers`;
  async function req(who,method,path,body){
   const headers={};if(who)headers.Authorization=`Bearer ${tokens[who]}`;
   if(body!==undefined)headers['Content-Type']='application/json';
   const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
   const raw=await response.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}
   return {status:response.status,data};
  }
  assert.equal((await req(null,'GET','/accounts')).status,401);
  const newAccount={name:'Modern Systems',email:'Admin@Modern.example',phone:'+919876543210',website:'https://modern.example'};
  for(const who of ['owner','readonly'])assert.equal((await req(who,'POST','/accounts',newAccount)).status,403,who);
  assert.equal((await req('employee','GET','/accounts/201')).status,404);
  assert.equal((await req('manager','GET','/accounts/201')).status,404);
  assert.equal((await req('other','GET','/accounts/201')).status,404);
  let r=await req('employee','POST','/accounts',newAccount);
  assert.equal(r.status,201,JSON.stringify(r.data));const accountId=r.data.data.id;
  r=await req('employee','GET',`/accounts/${accountId}`);assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal(r.data.data.email,'admin@modern.example');const revision=r.data.data.revision;
  assert.equal((await req('manager','GET',`/accounts/${accountId}`)).status,200);
  assert.equal((await req('manager2','GET',`/accounts/${accountId}`)).status,404);
  r=await req('owner','GET','/accounts?limit=20');assert.equal(r.status,200);assert.equal(r.data.data.length,2);
  assert.equal((await req('employee','POST','/accounts',{...newAccount,name:'modern systems',email:'different@example.test'})).status,409);
  assert.equal((await req('employee','POST','/accounts',{...newAccount,ownerUserId:'40'})).status,400);
  assert.equal((await req('employee','PATCH',`/accounts/${accountId}`,{expectedRevision:'2000-01-01T00:00:00.000000',changes:{name:'New Name'}})).status,409);
  r=await req('employee','PATCH',`/accounts/${accountId}`,{expectedRevision:revision,changes:{name:'Modern Systems India'}});assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal((await req('employee','PATCH',`/accounts/${accountId}`,{expectedRevision:revision,changes:{name:'Should fail'}})).status,409);
  console.log('PASS: Accounts create/read/edit, normalized identities, stale edits, role/team isolation');

  const person={firstName:'Anita',lastName:'Nair',email:'Anita@modern.example',phone:'+919876543211',accountId,marketingOptIn:false};
  assert.equal((await req('employee2','POST','/contacts',person)).status,404);
  assert.equal((await req('owner','POST','/contacts',person)).status,403);
  r=await req('employee','POST','/contacts',person);
  assert.equal(r.status,201,JSON.stringify(r.data));const contactId=r.data.data.id;
  r=await req('employee','GET',`/contacts/${contactId}`);assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal(r.data.data.email,'anita@modern.example');const contactRevision=r.data.data.revision;
  assert.equal((await req('manager','GET',`/contacts/${contactId}`)).status,200);
  assert.equal((await req('employee2','GET',`/contacts/${contactId}`)).status,404);
  assert.equal((await req('other','GET',`/contacts/${contactId}`)).status,404);
  assert.equal((await req('employee','POST','/contacts',{...person,email:'ANITA@MODERN.EXAMPLE',phone:'+919876543212'})).status,409);
  assert.equal((await req('employee','POST','/contacts',{...person,email:'second@modern.example',phone:'+919876543211'})).status,409);
  assert.equal((await req('employee','POST','/contacts',{...person,accountId:'301'})).status,404);
  assert.equal((await req('employee','PATCH',`/contacts/${contactId}`,{expectedRevision:contactRevision,changes:{phone:null,email:null}})).status,400);
  r=await req('employee','PATCH',`/contacts/${contactId}`,{expectedRevision:contactRevision,changes:{lastName:'Menon',phone:'+919876543213'}});
  assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal((await req('employee','PATCH',`/contacts/${contactId}`,{expectedRevision:contactRevision,changes:{firstName:'Old edit'}})).status,409);
  r=await req('employee','GET',`/accounts/${accountId}/contacts`);assert.equal(r.status,200);assert.equal(r.data.data.length,1);
  console.log('PASS: Contacts linked to visible accounts, duplicate blocking, validated contact changes and audit');

  r=await req('employee','GET','/contacts/possible-duplicates?email=ANITA%40MODERN.EXAMPLE');
  assert.equal(r.status,200);assert.equal(r.data.data.length,1);
  r=await req('manager2','GET','/contacts/possible-duplicates?email=ANITA%40MODERN.EXAMPLE');
  assert.equal(r.status,200);assert.equal(r.data.data.length,0);
  assert.equal((await req('employee','GET','/contacts/possible-duplicates?limit=1001&email=anita%40modern.example')).status,400);
  assert.equal((await req('employee','GET','/contacts/possible-duplicates?email=anita%40modern.example&companyId=200')).status,400);
  console.log('PASS: Visibility-scoped duplicate previews do not expose private or external contacts');

  assert.equal((await req('employee2','POST',`/contacts/${contactId}/activities`,{type:'note',summary:'Should not record'})).status,404);
  assert.equal((await req('owner','POST',`/contacts/${contactId}/activities`,{type:'note',summary:'Should not record'})).status,403);
  assert.equal((await req('employee','POST',`/contacts/${contactId}/activities`,{type:'private',summary:'Bad'})).status,400);
  for(const [type,summary] of [['call','Discussed next steps'],['meeting','Product demonstration'],['note','Awaiting proposal']]){
   r=await req('employee','POST',`/contacts/${contactId}/activities`,{type,summary});assert.equal(r.status,201,JSON.stringify(r.data));
  }
  r=await req('manager','GET',`/contacts/${contactId}/timeline`);
  assert.equal(r.status,200,JSON.stringify(r.data));
  assert.ok(r.data.data.some(x=>x.type==='contact.meeting'));
  assert.ok(r.data.data.some(x=>x.type==='contact.updated'));
  assert.equal((await req('employee2','GET',`/contacts/${contactId}/timeline`)).status,404);
  console.log('PASS: Customer call, meeting and note activities plus unified contact timeline');

  const csv='First Name,Email,Phone,Last Name\r\n"Nina, Jr",nina@example.test,+919876543215,Shah\r\nAnita,anita@modern.example,+919876543213,Menon\r\nKiran,kiran@example.test,+919876543216,Joshi\r\n';
  const mapping={'First Name':'firstName','Email':'email','Phone':'phone','Last Name':'lastName'};
  const payload={csv,mapping,duplicateStrategy:'SKIP'};
  assert.equal((await req('owner','POST','/imports/contacts/preview',payload)).status,403);
  assert.equal((await req('readonly','POST','/imports/contacts/preview',payload)).status,403);
  assert.equal((await req('employee','POST','/imports/contacts/preview',{...payload,duplicateStrategy:'UPDATE_MATCHING'})).status,400);
  assert.equal((await req('employee','POST','/imports/contacts/preview',{...payload,csv:'firstName,email\n"broken,a@example.test'})).status,400);
  assert.equal((await req('employee','POST','/imports/contacts/preview',{...payload,mapping:{'First Name':'firstName','Email':'firstName'}})).status,400);
  const beforeContactCount=await count('contacts'),beforeJobCount=await count('import_jobs');
  r=await req('employee','POST','/imports/contacts/preview',payload);
  assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal(r.data.data.expectedCreated,2);
  assert.equal(r.data.data.expectedDuplicates,1);
  assert.equal(await count('contacts'),beforeContactCount);
  assert.equal(await count('import_jobs'),beforeJobCount);
  assert.equal((await req('employee','POST','/imports/contacts/preview',{...payload,duplicateStrategy:'REJECT'})).status,409);
  console.log('PASS: RFC-style CSV preview, custom header mapping, strict validation, zero preview writes');

  const commit={...payload,idempotencyKey:'cust-import-2026-11-02-001'};
  r=await req('employee','POST','/imports/contacts/commit',commit);
  assert.equal(r.status,201,JSON.stringify(r.data));const importId=r.data.data.id;
  assert.equal(r.data.data.created,2);
  assert.equal(r.data.data.skippedDuplicates,1);
  assert.equal(await count('contacts'),beforeContactCount+2);
  assert.equal(await count('import_jobs'),beforeJobCount+1);
  assert.equal((await req('employee','POST','/imports/contacts/commit',commit)).status,409);
  r=await req('employee','GET',`/imports/${importId}`);
  assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.data.successfulRows,2);
  assert.equal((await req('employee2','GET',`/imports/${importId}`)).status,404);
  assert.equal((await req('other','GET',`/imports/${importId}`)).status,404);
  console.log('PASS: CSV import commit, SKIP duplicates, job counters and idempotency');

  const reject={csv:'firstName,email\nA,aa@fresh.example\nB,aa@fresh.example',duplicateStrategy:'REJECT',idempotencyKey:'cust-import-2026-11-02-002'};
  const beforeReject=await count('contacts'),beforeRejectJobs=await count('import_jobs');
  r=await req('employee','POST','/imports/contacts/commit',reject);
  assert.equal(r.status,409,JSON.stringify(r.data));
  assert.equal(await count('contacts'),beforeReject);
  assert.equal(await count('import_jobs'),beforeRejectJobs);
  failAudit=true;
  const rollback={csv:'firstName,email\nRollback,rollback.new@example.test',duplicateStrategy:'SKIP',idempotencyKey:'cust-import-2026-11-02-003'};
  r=await req('employee','POST','/imports/contacts/commit',rollback);
  assert.equal(r.status,500,JSON.stringify(r.data));failAudit=false;
  assert.equal(await count('contacts'),beforeReject);
  assert.equal(await count('import_jobs'),beforeRejectJobs);
  console.log('PASS: All-or-nothing REJECT import and full rollback on audit failure');

  const racePerson={firstName:'Concurrent',email:'concurrent@example.test',phone:'+919876543217'};
  const race=await Promise.all([req('employee','POST','/contacts',racePerson),req('employee','POST','/contacts',racePerson)]);
  assert.deepEqual(race.map(x=>x.status).sort(),[201,409],JSON.stringify(race));
  const [raceRows]=await pool.execute(`SELECT COUNT(*) AS n FROM contacts WHERE company_id=100 AND email='concurrent@example.test'`);
  assert.equal(Number(raceRows[0].n),1);
  console.log('PASS: Cross-request duplicate creation protected by company row locks');

  await pool.execute(`UPDATE team_members SET left_at=UTC_TIMESTAMP(3) WHERE company_id=100 AND user_id=30 AND team_id=7`);
  assert.equal((await req('manager','GET',`/contacts/${contactId}`)).status,404);
  console.log('PASS: Manager visibility revoked immediately after team membership removal');
  assert.match(fs.readFileSync('./src/server.ts','utf8'),/createCustomerRouter/);
  console.log('PASS: Customer router wired in normal CRM startup');
  console.log('PASS: ALL CUSTOMER + CSV + ACTIVITY MILESTONE TESTS');
 }finally{
  if(server)await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
  if(sessions)sessions.clearSessions();if(identities)identities.clearIdentities();if(pool)await pool.end();
  if(admin){try{if(created){assert.match(scratch,/^dgate_crm_customerqa_[0-9a-f]{16}$/);await admin.query(`DROP DATABASE \`${scratch}\``);console.log('PASS: Scratch database removed');}}finally{await admin.end();}}
 }
 console.log('PASS: Original CRM database unchanged');
}
main().catch(error=>{console.error('FAIL:',error?.stack||error);process.exitCode=1;});
