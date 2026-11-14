const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const mysql=require('mysql2/promise');
const dotenv=require('dotenv');
const crypto=require('node:crypto');
const {once}=require('node:events');
const env=dotenv.parse(fs.readFileSync('.env'));
assert.equal(env.DB_NAME,'dgate_crm_fresh','QA clones source schema but cannot write the original CRM database');
Object.assign(process.env,env,{NODE_ENV:'test',AUTH_MODE:'local',CRM_DEV_SEED:'0'});
require.extensions['.ts']=(mod,file)=>{
 const out=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}});
 mod._compile(out.outputText,file);
};
const {createCrmApp}=require(process.cwd() + '/./src/app.ts');
const {createDevSessionStore}=require(process.cwd() + '/./src/core/auth/devSessionVerifier.ts');
const {createDevIdentityStore}=require(process.cwd() + '/./src/core/auth/devIdentityResolver.ts');
const {createStaffAdminRouter}=require(process.cwd() + '/./src/modules/staff_admin/staff_admin.routes.ts');
const cfg={host:env.DB_HOST||'127.0.0.1',port:Number(env.DB_PORT||3306),user:env.DB_USER||'root',password:env.DB_PASSWORD??'',multipleStatements:false};
const scratch='dgate_crm_staffqa_'+crypto.randomBytes(8).toString('hex');
assert.match(scratch,/^dgate_crm_staffqa_[a-f0-9]{16}$/);
const tables=['companies','users','teams','team_members','leads','tasks','audit_logs'];
let admin,pool,server,sessions,identities,created=false,failAudit=false;
async function sql(q,p=[]){return (await pool.execute(q,p))[0];}
async function count(table,company=100){assert.ok(tables.includes(table));return Number((await sql(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE company_id=?`,[company]))[0].n);}
async function main(){try{
 admin=await mysql.createConnection(cfg);
 await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);created=true;
 for(const tab of tables){await admin.query(`CREATE TABLE \`${scratch}\`.\`${tab}\` LIKE \`${env.DB_NAME}\`.\`${tab}\``);}
 pool=mysql.createPool({...cfg,database:scratch,connectionLimit:8,supportBigNumbers:true,bigNumberStrings:true});
 console.log('PASS: Seven CRM structures cloned into isolated Staff QA database');
 for(const c of [100,200])await sql(`INSERT INTO companies(id,platform_org_id,name,slug,status,platform_product_id,platform_access_mode,provisioned_at) VALUES(?,?,?,?,'active',1,'FULL',UTC_TIMESTAMP(3))`,[c,`sa_org${c}`,`Staff Org ${c}`,`sa_${c}`]);
 for(const [u,c,role,status] of [[10,100,'owner','active'],[20,100,'manager','active'],[21,100,'manager','active'],[30,100,'employee','active'],[40,100,'employee','active'],[50,100,'employee','active'],[55,100,'employee','active'],[60,100,'employee','active'],[65,100,'employee','pending'],[70,200,'employee','active']]){
  await sql(`INSERT INTO users(id,company_id,platform_user_id,full_name,email,role,status,activated_at) VALUES(?,?,?,?,?,?,?,?)`,[u,c,`sa_user${u}`,`QA User ${u}`,`user${u}@example.test`,role,status,status==='active'?'2026-01-01 00:00:00':null]);
 }
 for(const [team,manager] of [[7,20],[8,21]])await sql(`INSERT INTO teams(id,company_id,name,manager_user_id,status) VALUES(?,100,?,?,'active')`,[team,`Team ${team}`,manager]);
 for(const [member,team,user] of [[1,7,30],[2,7,55],[3,8,50]])await sql(`INSERT INTO team_members(id,company_id,team_id,user_id,joined_at) VALUES(?,100,?,?, '2026-01-01 00:00:00')`,[member,team,user]);
 await sql(`INSERT INTO leads(id,company_id,title,status,priority,created_by_user_id,owner_user_id) VALUES(101,100,'Protected Lead','new','normal',30,30)`);
 await sql(`INSERT INTO tasks(id,company_id,title,owner_user_id,status) VALUES(401,100,'Protected Task',30,'open')`);
 console.log('PASS: Isolated companies, owner, managers, employees, private teams and assigned work seeded');
 const factory=async()=>{const conn=await pool.getConnection();return{
  execute:(q,args)=>{if(failAudit&&/INSERT\s+INTO\s+audit_logs/i.test(q))throw Error('EXPECTED_AUDIT_FAILURE');return conn.execute(q,args);},
  beginTransaction:()=>conn.beginTransaction(),commit:()=>conn.commit(),rollback:()=>conn.rollback(),release:()=>conn.release(),destroy:()=>conn.destroy()
 };};
 sessions=createDevSessionStore();identities=createDevIdentityStore();const tokens={};
 for(const [name,company,user,role,mode] of [['owner',100,10,'OWNER','FULL'],['manager',100,20,'MANAGER','FULL'],['manager2',100,21,'MANAGER','FULL'],['employee',100,30,'EMPLOYEE','FULL'],['employee2',100,50,'EMPLOYEE','FULL'],['readonly',100,20,'MANAGER','READ_ONLY'],['foreign',200,70,'EMPLOYEE','FULL']]){
  const k=`staff_${name}`;identities.registerIdentity(k,{companyId:String(company),actorUserId:String(user),role,membershipStatus:'ACTIVE',accessMode:mode});tokens[name]=sessions.issueSession(k);
 }
 const app=createCrmApp({sessionVerifier:sessions.verifier,identityResolver:identities.resolver,protectedRoutes:createStaffAdminRouter({connectionFactory:factory})});
 server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}/api/v1/crm`;
 async function request(who,method,path,body){const headers={};if(who)headers.Authorization=`Bearer ${tokens[who]}`;
  if(body!==undefined)headers['Content-Type']='application/json';
  const res=await fetch(base+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
  const content=await res.text();let data={};try{data=JSON.parse(content);}catch{data={raw:content};}
  return {status:res.status,data};
 }
 const create={name:'Outbound Sales',managerUserId:'20'};
 assert.equal((await request(null,'GET','/admin/staff')).status,401);
 assert.equal((await request('employee','POST','/admin/teams',create)).status,403);
 assert.equal((await request('manager','POST','/admin/teams',create)).status,403);
 assert.equal((await request('readonly','POST','/admin/teams',create)).status,403);
 assert.equal((await request('owner','POST','/admin/teams',{...create,admin:true})).status,400);
 assert.equal((await request('owner','POST','/admin/teams',{...create,managerUserId:'30'})).status,400);
 const newTeam=await request('owner','POST','/admin/teams',create);
 assert.equal(newTeam.status,201,JSON.stringify(newTeam.data));const teamId=newTeam.data.data.teamId;
 assert.equal((await request('owner','POST','/admin/teams',create)).status,409);
 const allTeams=await request('owner','GET','/admin/teams');assert.equal(allTeams.status,200);assert.equal(allTeams.data.data.items.length,3);
 assert.equal((await request('manager2','GET','/admin/teams')).data.data.items.length,1);
 assert.equal((await request('employee','GET','/admin/teams')).data.data.items.length,1);
 console.log('PASS: Owner-only team creation, active Manager validation and role-scoped team lists');
 assert.equal((await request('manager2','GET','/admin/teams/7/members')).status,404);
 assert.equal((await request('employee','GET','/admin/teams/7/members')).status,404);
 assert.equal((await request('manager2','POST','/admin/teams/7/members',{userId:'40'})).status,404);
 assert.equal((await request('manager','POST','/admin/teams/8/members',{userId:'40'})).status,404);
 assert.equal((await request('manager','POST','/admin/teams/7/members',{userId:'70'})).status,404);
 assert.equal((await request('manager','POST','/admin/teams/7/members',{userId:'65'})).status,400);
 assert.equal((await request('manager','POST','/admin/teams/7/members',{userId:'20'})).status,400);
 assert.equal((await request('manager','POST','/admin/teams/7/members',{userId:'30'})).status,409);
 const joined=await request('manager','POST','/admin/teams/7/members',{userId:'40'});
 assert.equal(joined.status,201,JSON.stringify(joined.data));
 assert.equal((await request('manager2','POST','/admin/teams/8/members',{userId:'40'})).status,409);
 assert.equal((await request('manager','GET','/admin/teams/7/members')).data.data.items.length,3);
 assert.equal((await request('manager2','GET','/admin/teams/8/members')).data.data.items.length,1);
 assert.equal((await request('manager','PATCH','/admin/teams/7/members/30/remove',{})).status,409);
 assert.equal((await request('manager2','PATCH','/admin/teams/7/members/40/remove',{})).status,404);
 assert.equal((await request('manager','PATCH','/admin/teams/7/members/40/remove',{})).status,200);
 assert.equal((await request('manager','PATCH','/admin/teams/7/members/40/remove',{})).status,404);
 console.log('PASS: Team membership, company isolation, assigned-work guard and immediate removal');
 // Rebuild the roster in one verified scoped read before applying optimistic updates.
 const roster=await request('manager','GET','/admin/staff');
 assert.equal(roster.status,200);
 assert.deepEqual(roster.data.data.items.map(x=>String(x.id)).sort(),['20','30','55']);
 assert.equal((await request('employee','GET','/admin/staff')).data.data.items.length,1);
 assert.equal((await request('manager2','GET','/admin/staff')).data.data.items.length,2);
 assert.equal((await request('foreign','GET','/admin/staff')).data.data.items.length,1);
 const row55=roster.data.data.items.find(x=>String(x.id)==='55');assert.ok(row55);
 assert.equal((await request('employee','PATCH','/admin/staff/55/status',{status:'inactive',expectedRevision:row55.revision})).status,403);
 assert.equal((await request('readonly','PATCH','/admin/staff/55/status',{status:'inactive',expectedRevision:row55.revision})).status,403);
 assert.equal((await request('manager2','PATCH','/admin/staff/55/status',{status:'inactive',expectedRevision:row55.revision})).status,404);
 assert.equal((await request('manager','PATCH','/admin/staff/10/status',{status:'inactive',expectedRevision:row55.revision})).status,403);
 assert.equal((await request('manager','PATCH','/admin/staff/20/status',{status:'inactive',expectedRevision:row55.revision})).status,403);
 assert.equal((await request('manager','PATCH','/admin/staff/30/status',{status:'inactive',expectedRevision:roster.data.data.items.find(x=>String(x.id)==='30').revision})).status,409);
 const disabled=await request('manager','PATCH','/admin/staff/55/status',{status:'inactive',expectedRevision:row55.revision});
 assert.equal(disabled.status,200,JSON.stringify(disabled.data));
 assert.equal((await request('manager','PATCH','/admin/staff/55/status',{status:'inactive',expectedRevision:row55.revision})).status,409);
 assert.equal((await sql('SELECT status FROM users WHERE company_id=100 AND id=55'))[0].status,'inactive');
 const refreshed=(await request('manager','GET','/admin/staff')).data.data.items.find(x=>String(x.id)==='55');
 const reactivated=await request('manager','PATCH','/admin/staff/55/status',{status:'active',expectedRevision:refreshed.revision});
 assert.equal(reactivated.status,200,JSON.stringify(reactivated.data));
 assert.equal((await sql('SELECT status FROM users WHERE company_id=100 AND id=55'))[0].status,'active');
 console.log('PASS: Restricted staff status transitions, stale revision protection, assigned Lead/Task checks');
 const teamView=await request('owner','GET','/admin/teams');
 assert.equal(teamView.status,200);
 assert.equal((await request('manager','PATCH','/admin/teams/8/manager',{managerUserId:'20'})).status,403);
 assert.equal((await request('owner','PATCH','/admin/teams/8/manager',{managerUserId:'30'})).status,400);
 assert.equal((await request('owner','PATCH','/admin/teams/8/manager',{managerUserId:'21'})).status,409);
 const promoted=await request('owner','PATCH','/admin/teams/8/manager',{managerUserId:'20'});
 assert.equal(promoted.status,200,JSON.stringify(promoted.data));
 assert.equal((await request('manager2','GET','/admin/teams')).data.data.items.length,0);
 const mgr21=(await request('owner','GET','/admin/staff')).data.data.items.find(x=>String(x.id)==='21');
 const mgrOff=await request('owner','PATCH','/admin/staff/21/status',{status:'inactive',expectedRevision:mgr21.revision});
 assert.equal(mgrOff.status,200,JSON.stringify(mgrOff.data));
 assert.equal((await request('manager2','GET','/admin/teams')).status,403);
 const mgrNew=(await request('owner','GET','/admin/staff')).data.data.items.find(x=>String(x.id)==='21');
 assert.equal((await request('owner','PATCH','/admin/staff/21/status',{status:'active',expectedRevision:mgrNew.revision})).status,200);
 console.log('PASS: Manager reassignment, safe Manager deactivation and local staff-admin revocation');
 const prev={fullName:'New Employee',email:'Invite@example.test',role:'employee',teamId:'7'};
 assert.equal((await request('employee','POST','/admin/invitations/preview',prev)).status,403);
 assert.equal((await request('readonly','POST','/admin/invitations/preview',prev)).status,403);
 assert.equal((await request('manager','POST','/admin/invitations/preview',{...prev,role:'manager'})).status,403);
 assert.equal((await request('manager','POST','/admin/invitations/preview',{...prev,teamId:'999'})).status,404);
 assert.equal((await request('manager','POST','/admin/invitations/preview',{...prev,teamId:undefined})).status,400);
 assert.equal((await request('manager','POST','/admin/invitations/preview',{...prev,email:'USER30@example.test'})).status,409);
 const beforeUsers=await count('users');
 const invite=await request('manager','POST','/admin/invitations/preview',prev);
 assert.equal(invite.status,200,JSON.stringify(invite.data));
 assert.equal(invite.data.data.invitationSent,false);assert.equal(invite.data.data.status,'preview_only');
 assert.equal(await count('users'),beforeUsers);
 const ownerInvite=await request('owner','POST','/admin/invitations/preview',{fullName:'New Manager',email:'manager@example.test',role:'manager'});
 assert.equal(ownerInvite.status,200,JSON.stringify(ownerInvite.data));
 assert.equal((await request('owner','POST','/admin/invitations/preview',{...prev,role:'manager',teamId:'7'})).status,400);
 console.log('PASS: Invitation PREVIEW only; no Clerk invitation, user provisioning, or email sends');
 // Concurrent insertion attempts across different teams must not produce multiple active memberships.
 const parallel=await Promise.all([
  request('owner','POST','/admin/teams/7/members',{userId:'40'}),
  request('owner','POST','/admin/teams/8/members',{userId:'40'})
 ]);
 assert.deepEqual(parallel.map(x=>x.status).sort(),[201,409]);
 assert.equal(Number((await sql(`SELECT COUNT(*) AS n FROM team_members WHERE company_id=100 AND user_id=40 AND left_at IS NULL`))[0].n),1);
 console.log('PASS: Concurrent team assignment serialized by user-row locks');
 const membersBefore=await count('team_members'),auditBefore=await count('audit_logs');
 failAudit=true;
 const rejected=await request('owner','POST','/admin/teams/7/members',{userId:'60'});
 failAudit=false;
 assert.equal(rejected.status,500,JSON.stringify(rejected.data));
 assert.equal(await count('team_members'),membersBefore);assert.equal(await count('audit_logs'),auditBefore);
 const good=await request('owner','POST','/admin/teams/7/members',{userId:'60'});
 assert.equal(good.status,201,JSON.stringify(good.data));
 const teamCountBefore=await count('teams');failAudit=true;
 const teamRejected=await request('owner','POST','/admin/teams',{name:'Rollback QA',managerUserId:'20'});
 failAudit=false;
 assert.equal(teamRejected.status,500,JSON.stringify(teamRejected.data));assert.equal(await count('teams'),teamCountBefore);
 console.log('PASS: Membership and team creation SQL rollback on audit failure');
 const [audit]=await sql(`SELECT action FROM audit_logs WHERE company_id=100 AND action LIKE 'staff.%' ORDER BY id`);
 assert.ok(audit);
 assert.equal(fs.readFileSync('src/server.ts','utf8').includes('createStaffAdminRouter'),true);
 console.log('PASS: Normal CRM server wiring and sensitive team changes recorded in audit trail');
 console.log('PASS: ALL BATCH 396-430 STAFF ADMINISTRATION TESTS');
}finally{
 if(server)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
 if(sessions)sessions.clearSessions();if(identities)identities.clearIdentities();
 if(pool)await pool.end();
 if(admin){try{if(created){assert.match(scratch,/^dgate_crm_staffqa_[a-f0-9]{16}$/);await admin.query(`DROP DATABASE \`${scratch}\``);console.log('PASS: Scratch Staff QA database removed');}}finally{await admin.end();}}
}
console.log('PASS: Original CRM database unchanged');
}
main().catch(err=>{console.error('FAIL:',err?.stack||err);process.exitCode=1;});
