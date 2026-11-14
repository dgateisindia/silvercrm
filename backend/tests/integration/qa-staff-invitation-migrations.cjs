/* D-GATE Silver CRM QA Phase 4: isolated staff invitation migrations.
 * DDL and fixture writes occur ONLY inside random dgate_crm_staffqa_* schema.
 * Source dgate_crm_fresh is read for schema presence only. No external providers. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

const env = dotenv.parse(fs.readFileSync('.env'));
assert.equal(env.DB_NAME, 'dgate_crm_fresh', 'STOP: source DB must be dgate_crm_fresh');
const source = 'dgate_crm_fresh';
const cfg = {
  host: env.DB_HOST || '127.0.0.1',
  port: Number(env.DB_PORT || 3306),
  user: env.DB_USER || 'root',
  password: env.DB_PASSWORD ?? '',
  supportBigNumbers: true,
  bigNumberStrings: true,
  connectionLimit: 5,
  multipleStatements: false
};
const scratch = 'dgate_crm_staffqa_' + crypto.randomBytes(8).toString('hex');
assert.match(scratch, /^dgate_crm_staffqa_[a-f0-9]{16}$/);
const m1path = path.resolve('database/migrations/20261103_staff_invitations.sql');
const m2path = path.resolve('database/migrations/20261103_staff_invitation_activation.sql');
const m1 = fs.readFileSync(m1path, 'utf8');
const m2 = fs.readFileSync(m2path, 'utf8');
function reviewedSql(sql, start) {
  const active=sql.split(/\r?\n/).filter(line => !/^\s*--/.test(line)).join('\n').trim();
  assert.match(active, start, 'Migration differs from reviewed DDL');
  assert.equal((active.match(/;/g) || []).length,1,'Migration must contain exactly one DDL statement');
  assert.doesNotMatch(active, /\b(INSERT|DELETE|DROP|TRUNCATE|CREATE\s+DATABASE|USE|GRANT|REVOKE|SOURCE)\b/i);
  assert.doesNotMatch(active, /`?dgate_crm_fresh`?\s*\./i, 'Migration must not qualify source DB');
  return active;
}
const ddlCreate = reviewedSql(m1,/^CREATE\s+TABLE\s+crm_staff_invitations\s*\(/i);
const ddlAlter = reviewedSql(m2,/^ALTER\s+TABLE\s+crm_staff_invitations\s+/i);
assert.match(ddlCreate,/CONSTRAINT\s+ck_staff_invites_team_role/i);
assert.match(ddlAlter,/'provisioned'/i);

let admin=null, pool=null, created=false, originalCount=null;
const insert = `INSERT INTO crm_staff_invitations
 (company_id,email,full_name,role,team_id,requested_by_id,idempotency_key,provider_invitation_id,state)
 VALUES (?,?,?,?,?,?,?,?,?)`;
function record(company, suffix, role='manager',team=null,provider=null,state='reserved') {
  return [company,`${suffix}@example.test`,'QA Invitation '+suffix,role,team,17,`idem_${suffix}`,provider,state];
}
async function expectRejected(fn, label) {
  let rejected=false;
  try { await fn(); }
  catch (e) {
    rejected=true;
    assert.ok(e.code || e.errno,`Missing SQL failure for ${label}`);
  }
  assert.ok(rejected,`Missing DB rejection: ${label}`);
  console.log('PASS: Rejected '+label);
}
async function sourceTableCount() {
  const [r]=await admin.execute(`SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA=? AND TABLE_NAME='crm_staff_invitations'`,[source]);
  return Number(r[0].n);
}
async function main() {
  try {
    admin=await mysql.createConnection({host:cfg.host,port:cfg.port,user:cfg.user,password:cfg.password,multipleStatements:false});
    const [db]=await admin.execute('SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME=?',[source]);
    assert.equal(db.length,1,'STOP: source database missing');
    originalCount=await sourceTableCount();
    console.log('PASS: Source DB verified read-only; invitation table present before QA='+originalCount);
    await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created=true;
    pool=mysql.createPool({...cfg,database:scratch});
    const [chosen]=await pool.execute('SELECT DATABASE() AS db');
    assert.equal(chosen[0].db,scratch);
    console.log('PASS: Random, isolated QA database created');

    // Same reviewed migrations that will eventually be applied during an authorized release.
    await pool.query(ddlCreate);
    console.log('PASS: 20261103_staff_invitations.sql applied to scratch');
    const [pre]=await pool.execute(`SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='crm_staff_invitations' AND COLUMN_NAME='state'`,[scratch]);
    assert.equal(pre.length,1);
    assert.doesNotMatch(pre[0].COLUMN_TYPE,/provisioned/i);
    await pool.query(ddlAlter);
    console.log('PASS: 20261103_staff_invitation_activation.sql applied to scratch, in order');
    const [post]=await pool.execute(`SELECT COLUMN_TYPE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='crm_staff_invitations' AND COLUMN_NAME='state'`,[scratch]);
    assert.equal(post.length,1);
    for(const state of ['reserved','sent','revoking','revoked','uncertain','provisioned'])assert.ok(post[0].COLUMN_TYPE.includes(`'${state}'`));
    const [idx]=await pool.execute(`SELECT INDEX_NAME,COLUMN_NAME,SEQ_IN_INDEX,NON_UNIQUE
       FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME='crm_staff_invitations'`,[scratch]);
    function hasIndex(name,cols,unique) {
      const rows=idx.filter(x=>x.INDEX_NAME===name).sort((a,b)=>a.SEQ_IN_INDEX-b.SEQ_IN_INDEX);
      assert.deepEqual(rows.map(x=>x.COLUMN_NAME),cols,`${name} columns`);
      if(unique)assert.ok(rows.every(x=>Number(x.NON_UNIQUE)===0),`${name} uniqueness`);
    }
    hasIndex('uq_staff_invitations_idempotency',['company_id','idempotency_key'],true);
    hasIndex('uq_staff_invitations_provider',['provider_invitation_id'],true);
    hasIndex('idx_staff_invites_email',['company_id','email','state'],false);
    hasIndex('idx_staff_invites_actor',['company_id','requested_by_id','created_at'],false);
    console.log('PASS: Required invitation state enum and indexes verified');

    await pool.execute(`SET SESSION sql_mode='STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'`);
    const [r1]=await pool.execute(insert,record(101,'manager_valid'));
    const managerId=r1.insertId;
    await pool.execute(insert,record(101,'employee_valid','employee',7));
    await expectRejected(()=>pool.execute(insert,record(101,'invalid_manager','manager',7)),'manager with team');
    await expectRejected(()=>pool.execute(insert,record(101,'invalid_employee','employee',null)),'employee without team');
    console.log('PASS: Valid manager/employee roles and CHECK enforcement');

    await expectRejected(()=>pool.execute(insert,record(101,'manager_valid')),'duplicate company idempotency key');
    await pool.execute(insert,record(202,'manager_valid'));
    console.log('PASS: Idempotency is unique per company, not globally');

    await pool.execute(insert,record(101,'provider_a','manager',null,'qa_clerk_provider_1','sent'));
    await expectRejected(()=>pool.execute(insert,record(202,'provider_b','manager',null,'qa_clerk_provider_1','sent')),'duplicate provider ID across companies');
    console.log('PASS: Provider invitation ID global uniqueness');

    const states=['sent','provisioned'];
    for(const state of states){
      const [result]=await pool.execute('UPDATE crm_staff_invitations SET state=? WHERE company_id=? AND id=?',[state,101,managerId]);
      assert.equal(result.affectedRows,1);
    }
    const [stateRow]=await pool.execute('SELECT state FROM crm_staff_invitations WHERE company_id=? AND id=?',[101,managerId]);
    assert.equal(stateRow[0].state,'provisioned');
    for(const [suffix,state] of [['revoke','revoking'],['revoked','revoked'],['uncertain','uncertain']]) {
      await pool.execute(insert,record(101,suffix,'manager',null,null,state));
    }
    const [otherScope]=await pool.execute('SELECT id FROM crm_staff_invitations WHERE company_id=? AND id=?',[202,managerId]);
    assert.equal(otherScope.length,0);
    console.log('PASS: Allowed invitation lifecycle states persisted and company-scoped query verified');

    const concurrent=await Promise.allSettled([
      pool.execute(insert,record(101,'race_same_key')),
      pool.execute(insert,record(101,'race_same_key'))
    ]);
    assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(concurrent.filter(x=>x.status==='rejected').length,1);
    const [count]=await pool.execute("SELECT COUNT(*) n FROM crm_staff_invitations WHERE company_id=101 AND idempotency_key='idem_race_same_key'");
    assert.equal(Number(count[0].n),1);
    console.log('PASS: Concurrent duplicate reservation creates exactly one record');

    const after=await sourceTableCount();
    assert.equal(after,originalCount,'Source database schema changed during QA');
    console.log('PASS: Source DB invitation-table presence unchanged');
    console.log('===== STAFF INVITATION MIGRATION QA: PASS =====');
  } finally {
    if(pool){try{await pool.end();}catch(e){console.error('QA pool cleanup: '+e.message)}}
    if(admin){
      try{
        if(created){
          assert.match(scratch,/^dgate_crm_staffqa_[a-f0-9]{16}$/);
          await admin.query(`DROP DATABASE \`${scratch}\``);
          console.log('PASS: Scratch invitation QA database removed');
        }
      }finally{await admin.end();}
    }
  }
}
main().catch(err=>{console.error('FAIL: STAFF INVITATION QA:',err.message);process.exitCode=1;});
