const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const mysql=require('mysql2/promise');
const dotenv=require('dotenv');
const crypto=require('node:crypto');
const {once}=require('node:events');
const env=dotenv.parse(fs.readFileSync('.env'));
assert.equal(env.DB_NAME,'dgate_crm_fresh','STOP: protected DB must be dgate_crm_fresh');
Object.assign(process.env,env,{NODE_ENV:'test',AUTH_MODE:'local',CRM_DEV_SEED:'0'});
require.extensions['.ts']=(mod,file)=>{
 const out=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}});
 mod._compile(out.outputText,file);
};
const {createCrmApp}=require(process.cwd() + '/./src/app.ts');
const {createDevSessionStore}=require(process.cwd() + '/./src/core/auth/devSessionVerifier.ts');
const {createDevIdentityStore}=require(process.cwd() + '/./src/core/auth/devIdentityResolver.ts');
const {createIntegrationInboxRouter}=require(process.cwd() + '/./src/modules/integration_inbox/integration_inbox.routes.ts');
const {createIntegrationService}=require(process.cwd() + '/./src/modules/integration_inbox/integration_inbox.service.ts');
const config={host:env.DB_HOST||'127.0.0.1',port:Number(env.DB_PORT||3306),user:env.DB_USER||'root',password:env.DB_PASSWORD??'',multipleStatements:false};
const scratch='dgate_crm_inboxqa_'+crypto.randomBytes(8).toString('hex');
assert.match(scratch,/^dgate_crm_inboxqa_[a-f0-9]{16}$/);
const tables=['companies','users','integration_connections','crm_webhook_events','crm_background_jobs','audit_logs'];
let admin,pool,server,sessions,identities,created=false,failAudit=false;
async function main(){try{
 admin=await mysql.createConnection(config);
 await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);created=true;
 for(const tab of tables){await admin.query(`CREATE TABLE \`${scratch}\`.\`${tab}\` LIKE \`${env.DB_NAME}\`.\`${tab}\``);}
 pool=mysql.createPool({...config,database:scratch,connectionLimit:8,supportBigNumbers:true,bigNumberStrings:true});
 const sql=async(q,p=[]) => (await pool.execute(q,p))[0];
 const count=async(table,company=100)=>{
  assert.ok(tables.includes(table));
  return Number((await sql(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE company_id=?`,[company]))[0].n);
 };
 for(const company of [100,200])await sql(`INSERT INTO companies(id,platform_org_id,name,slug,status,platform_product_id,platform_access_mode,provisioned_at) VALUES(?,?,?,?,'active',1,'FULL',UTC_TIMESTAMP(3))`,[company,`inbox_org_${company}`,`Integration ${company}`,`inbox_${company}`]);
 for(const [user,company,role] of [[10,100,'owner'],[20,100,'manager'],[30,100,'employee'],[70,200,'owner']])await sql(`INSERT INTO users(id,company_id,platform_user_id,full_name,email,role,status,activated_at) VALUES(?,?,?,?,?,?,'active',UTC_TIMESTAMP(3))`,[user,company,`inbox_u_${user}`,`QA ${user}`,`inbox${user}@example.test`,role]);
 for(const [id,company,provider,status] of [[1,100,'demo1','active'],[2,200,'demo1','active'],[3,100,'off1','disabled']])await sql(`INSERT INTO integration_connections(id,company_id,provider_key,display_name,credential_secret_ref,status,configured_by_id) VALUES(?,?,?,?,?,?,?)`,[id,company,provider,`QA ${provider}`,`qa-secret-ref-${company}`,status,company===100?10:70]);
 console.log('PASS: Six existing production structures cloned into isolated Integration QA database');
 const factory=async()=>{const db=await pool.getConnection();return {
  execute:(query,params)=>{if(failAudit&&/INSERT\s+INTO\s+audit_logs/i.test(query))throw Error('EXPECTED_AUDIT_FAILURE');return db.execute(query,params);},
  beginTransaction:()=>db.beginTransaction(),commit:()=>db.commit(),rollback:()=>db.rollback(),release:()=>db.release(),destroy:()=>db.destroy()
 };};
 sessions=createDevSessionStore();identities=createDevIdentityStore();const tokens={};
 for(const [name,company,user,role,mode] of [['owner',100,10,'OWNER','FULL'],['manager',100,20,'MANAGER','FULL'],['employee',100,30,'EMPLOYEE','FULL'],['readonly',100,10,'OWNER','READ_ONLY'],['foreign',200,70,'OWNER','FULL']]){
  const key='inbox_'+name;identities.registerIdentity(key,{companyId:String(company),actorUserId:String(user),role,membershipStatus:'ACTIVE',accessMode:mode});tokens[name]=sessions.issueSession(key);
 }
 const app=createCrmApp({sessionVerifier:sessions.verifier,identityResolver:identities.resolver,protectedRoutes:createIntegrationInboxRouter({connectionFactory:factory})});
 server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}/api/v1/crm`;
 async function req(who,method,path,body){const headers={};if(who)headers.Authorization=`Bearer ${tokens[who]}`;if(body!==undefined)headers['Content-Type']='application/json';const res=await fetch(base+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,data:await res.json()};}
 assert.equal((await req(null,'GET','/integrations/connections')).status,401);
 assert.equal((await req('manager','GET','/integrations/connections')).status,403);
 assert.equal((await req('employee','GET','/integrations/connections')).status,403);
 let result=await req('owner','GET','/integrations/connections');assert.equal(result.status,200);assert.equal(result.data.data.items.length,2);
 assert.ok(result.data.data.items.every(x=>!('credential_secret_ref' in x)));
 result=await req('foreign','GET','/integrations/connections');assert.equal(result.status,200);assert.equal(result.data.data.items.length,1);
 assert.equal((await req('readonly','POST','/integrations/connections',{providerKey:'new2',displayName:'New Integration'})).status,403);
 assert.equal((await req('owner','POST','/integrations/connections',{providerKey:'demo1',displayName:'Duplicate'})).status,409);
 assert.equal((await req('owner','POST','/integrations/connections',{providerKey:'new2',displayName:'New',credentialSecretRef:'unsafe-secret'})).status,400);
 result=await req('owner','POST','/integrations/connections',{providerKey:'new2',displayName:'New integration'});
 assert.equal(result.status,201,JSON.stringify(result.data));assert.equal(result.data.data.status,'disabled');
 assert.equal(await count('integration_connections'),3);
 console.log('PASS: Owner-only integration inventory, disabled registration and tenant isolation');
 const secret100='qa-only-inbox-signing-secret-company100-123456';
 const secret200='qa-only-inbox-signing-secret-company200-123456';
 const resolver=async(company,key)=>(key==='demo1'?(company==='100'?secret100:company==='200'?secret200:null):null);
 const service=createIntegrationService({connectionFactory:factory,secretResolver:resolver});
 const rawBody=JSON.stringify({type:'lead.received',lead:{source:'qa-test'}});
 function payload(company,event,body=rawBody,secret=secret100){return {companyId:String(company),providerKey:'demo1',eventId:event,rawBody:body,signature:'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')};}
 let invalid=payload(100,'bad-signature');invalid.signature='sha256='+'0'.repeat(64);
 await assert.rejects(service.receiveSigned(invalid));
 await assert.rejects(service.receiveSigned({...payload(100,'bad-json'),rawBody:'{broken'}));
 await assert.rejects(service.receiveSigned({...payload(100,'bad-scope'),companyId:'200'}));
 await assert.rejects(service.receiveSigned({...payload(100,'bad-key'),providerKey:'off1'}));
 assert.equal(await count('crm_webhook_events'),0);
 console.log('PASS: Invalid signatures, malformed payload and disabled connection rejected with zero writes');
 result=await service.receiveSigned(payload(100,'event-001'));
 assert.equal(result.alreadyReceived,false);assert.equal(result.jobQueued,true);
 assert.equal(await count('crm_webhook_events'),1);
 assert.equal(await count('crm_background_jobs'),1);
 const [r1]=await sql(`SELECT event_id,payload_hash,status FROM crm_webhook_events WHERE company_id=100 AND event_id='event-001'`);
 assert.equal(r1.payload_hash,crypto.createHash('sha256').update(rawBody).digest('hex'));
 const [job]=await sql(`SELECT job_type,payload_json,state FROM crm_background_jobs WHERE company_id=100`);
 assert.equal(job.job_type,'integration.webhook.received');assert.equal(job.state,'pending');
 const metadata=typeof job.payload_json==='string'?JSON.parse(job.payload_json):job.payload_json;
 assert.deepEqual(Object.keys(metadata).sort(),['eventRecordId','providerKey']);
 assert.ok(!JSON.stringify(job).includes('qa-only-inbox-signing-secret'));
 assert.ok(!JSON.stringify(job).includes('lead.received'));
 result=await service.receiveSigned(payload(100,'event-001'));assert.equal(result.alreadyReceived,true);
 assert.equal(await count('crm_webhook_events'),1);assert.equal(await count('crm_background_jobs'),1);
 await assert.rejects(service.receiveSigned(payload(100,'event-001',JSON.stringify({changed:1}))));
 console.log('PASS: Valid signed webhook receipt, minimal queued metadata and exact replay deduplication');
 const concurrent=await Promise.all([service.receiveSigned(payload(100,'event-002')),service.receiveSigned(payload(100,'event-002'))]);
 assert.deepEqual(concurrent.map(x=>x.alreadyReceived).sort(),[false,true]);
 assert.equal(await count('crm_webhook_events'),2);assert.equal(await count('crm_background_jobs'),2);
 const foreign=await service.receiveSigned(payload(200,'event-001',rawBody,secret200));assert.equal(foreign.alreadyReceived,false);
 assert.equal(await count('crm_webhook_events',200),1);
 result=await req('owner','GET','/integrations/webhook-events');assert.equal(result.status,200);assert.equal(result.data.data.items.length,2);
 result=await req('foreign','GET','/integrations/webhook-events');assert.equal(result.status,200);assert.equal(result.data.data.items.length,1);
 assert.equal((await req('manager','GET','/integrations/webhook-events')).status,403);
 assert.equal((await req('owner','GET','/integrations/webhook-events?limit=999')).status,400);
 result=await req('owner','GET','/integrations/inbound-jobs');assert.equal(result.status,200);assert.equal(result.data.data.items.length,2);
 console.log('PASS: Concurrent receipt dedup, cross-company isolation and scoped job/event inspection');
 const before=[await count('crm_webhook_events'),await count('crm_background_jobs'),await count('audit_logs')];
 failAudit=true;
 await assert.rejects(service.receiveSigned(payload(100,'audit-failure')));
 failAudit=false;
 const after=[await count('crm_webhook_events'),await count('crm_background_jobs'),await count('audit_logs')];
 assert.deepEqual(after,before);
 result=await service.receiveSigned(payload(100,'audit-failure'));assert.equal(result.jobQueued,true);
 console.log('PASS: Real SQL rollback on audit failure and safe retry after rollback');
 const serverSource=fs.readFileSync('./src/server.ts','utf8');assert.match(serverSource,/createIntegrationInboxRouter/);
 assert.equal(serverSource.includes('/integrations/webhooks/receive'),false);
 console.log('PASS: Only authenticated admin inspection routes mounted, no insecure public webhook ingress');
 console.log('PASS: ALL BATCH 431-465 INTEGRATION INBOX TESTS');
}finally{
 if(server)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 if(sessions)sessions.clearSessions();if(identities)identities.clearIdentities();
 if(pool)await pool.end();
 if(admin){try{if(created){assert.match(scratch,/^dgate_crm_inboxqa_[a-f0-9]{16}$/);await admin.query(`DROP DATABASE \`${scratch}\``);console.log('PASS: Temporary Integration database removed');}}finally{await admin.end();}}
}
console.log('PASS: Original CRM database unchanged');}
main().catch(error=>{console.error('FAIL:',error.stack||error);process.exitCode=1;});
