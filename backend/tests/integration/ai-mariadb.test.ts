import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import mysql, { type Connection, type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import type { TenantContext } from '../../src/core/tenant/tenantContext';
import {
  reserveGeneration, completeGeneration, markGenerationFailed
} from '../../src/modules/ai/ai.generation.repository';
import { listAiMessages } from '../../src/modules/ai/ai.conversation.repository';

/** Integration test: no live AI provider, no real customer data, no production DB writes. */
const SOURCE_DB = 'dgate_crm_fresh';
const SCRATCH_PREFIX = 'dgate_crm_ai_qa_';
const scratch = `${SCRATCH_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const requiredTables = [
  'companies', 'crm_ai_assistants', 'crm_ai_conversations',
  'crm_ai_policies', 'crm_ai_runs', 'crm_ai_usage_events',
  'crm_ai_messages', 'audit_logs'
] as const;
const connectionConfig = {
  host: process.env.CRM_QA_MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.CRM_QA_MYSQL_PORT || '3306'),
  user: process.env.CRM_QA_MYSQL_USER || 'root',
  password: process.env.CRM_QA_MYSQL_PASSWORD ?? '',
  multipleStatements: false,
  timezone: 'Z' as const
};

interface CountRow extends RowDataPacket { total: number | string; }
interface CipherRow extends RowDataPacket { content_ciphertext: Buffer | null; content_preview: string | null; }
const tenantA: TenantContext = {
  companyId: '1', actorUserId: '11', role: 'EMPLOYEE', accessMode: 'FULL'
};
const tenantB: TenantContext = {
  companyId: '2', actorUserId: '22', role: 'EMPLOYEE', accessMode: 'FULL'
};
const budget = { reserveMicros: 50000n, perUserDaily: 10, perCompanyDaily: 100 };
const key = Buffer.alloc(32, 73);
let admin: Connection | undefined;
let pool: Pool | undefined;
let scratchCreated = false;

function assertScratchName(): void {
  if (!/^dgate_crm_ai_qa_[a-f0-9]{16}$/.test(scratch) || scratch === SOURCE_DB) {
    throw new Error('QA_DATABASE_NAME_UNSAFE');
  }
}

async function transaction<T>(work: (db: PoolConnection) => Promise<T>): Promise<T> {
  if (!pool) throw new Error('QA_POOL_NOT_READY');
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    try {
      const result = await work(db);
      await db.commit();
      return result;
    } catch (error) {
      await db.rollback();
      throw error;
    }
  } finally {
    db.release();
  }
}

async function count(sql: string, params: Array<string | number> = []): Promise<number> {
  if (!pool) throw new Error('QA_POOL_NOT_READY');
  const [rows] = await pool.execute<CountRow[]>(sql, params);
  const value = Number(rows[0]?.total ?? NaN);
  if (!Number.isSafeInteger(value)) throw new Error('QA_INVALID_COUNT');
  return value;
}

describe('Silver AI real MariaDB isolation and budget controls', () => {
  beforeAll(async () => {
    assertScratchName();
    if (!Number.isSafeInteger(connectionConfig.port) ||
        connectionConfig.port < 1 || connectionConfig.port > 65535) {
      throw new Error('QA_MYSQL_INVALID_PORT');
    }
    admin = await mysql.createConnection(connectionConfig);
    await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    scratchCreated = true;
    // CREATE TABLE ... LIKE copies table structure, not rows or foreign keys.
    // Never issue CREATE/UPDATE/DELETE against SOURCE_DB.
    for (const table of requiredTables) {
      await admin.query(`CREATE TABLE \`${scratch}\`.\`${table}\` LIKE \`${SOURCE_DB}\`.\`${table}\``);
    }
    pool = mysql.createPool({ ...connectionConfig, database: scratch, connectionLimit: 3 });
    for (const [companyId, org] of [[1, 'org_aiqa_one'], [2, 'org_aiqa_two']] as const) {
      await pool.execute(
        `INSERT INTO companies
          (id,platform_org_id,name,slug,status,platform_product_id,
           platform_access_mode,platform_entitlement_version,provisioned_at)
         VALUES (?,?,?,?,'active',1,'FULL',1,UTC_TIMESTAMP(3))`,
        [companyId, `${org}_${scratch}`, `AI QA Company ${companyId}`, `${org}_${scratch}`]
      );
    }
    for (const [company, assistantId, convoId, userId, limit] of [
      [1, 101, 201, 11, '0.05'],
      [2, 102, 202, 22, '0.15']
    ] as const) {
      await pool.execute(
        `INSERT INTO crm_ai_assistants (id,company_id,name,model_key,enabled)
         VALUES (?,?,'QA assistant','qa-model',1)`, [assistantId, company]
      );
      await pool.execute(
        `INSERT INTO crm_ai_policies
          (company_id,assistant_id,max_monthly_cost,read_only,allow_external_knowledge)
         VALUES (?,?,?,1,0)`, [company, assistantId, limit]
      );
      await pool.execute(
        `INSERT INTO crm_ai_conversations
          (id,company_id,assistant_id,user_id,title,status)
         VALUES (?,?,?,?,'QA test','active')`,
        [convoId, company, assistantId, userId]
      );
    }
  }, 30000);

  afterAll(async () => {
    try {
      if (pool) await pool.end();
    } finally {
      if (admin) {
        try {
          if (scratchCreated) {
            assertScratchName();
            await admin.query(`DROP DATABASE \`${scratch}\``);
          }
        } finally {
          await admin.end();
        }
      }
    }
  }, 30000);

  it('denies a different company from reserving someone else\'s conversation', async () => {
    await expect(transaction(db => reserveGeneration(db, tenantB, '201', 'qa-model', budget)))
      .rejects.toThrow();
    expect(await count('SELECT COUNT(*) AS total FROM crm_ai_runs')).toBe(0);
    expect(await count('SELECT COUNT(*) AS total FROM crm_ai_usage_events')).toBe(0);
  });

  it('persists an atomic reservation, encrypted messages and audit trail', async () => {
    const reserved = await transaction(db =>
      reserveGeneration(db, tenantA, '201', 'qa-model', budget)
    );
    expect(reserved.assistantId).toBe('101');
    expect(await count('SELECT COUNT(*) AS total FROM crm_ai_runs WHERE company_id=1')).toBe(1);
    expect(await count('SELECT COUNT(*) AS total FROM crm_ai_usage_events WHERE company_id=1')).toBe(1);
    expect(await count("SELECT COUNT(*) AS total FROM audit_logs WHERE action='ai_run_reserved' AND company_id=1")).toBe(1);

    const saved = await transaction(db =>
      completeGeneration(db, tenantA, '201', reserved.runId, 'private customer prompt',
        'private assistant response', key)
    );
    expect(saved.runId).toBe(reserved.runId);
    expect(await count("SELECT COUNT(*) AS total FROM crm_ai_runs WHERE company_id=1 AND status='completed'")).toBe(1);

    if (!pool) throw new Error('QA_POOL_NOT_READY');
    const [cipherRows] = await pool.execute<CipherRow[]>(
      'SELECT content_ciphertext,content_preview FROM crm_ai_messages WHERE company_id=1 ORDER BY id'
    );
    expect(cipherRows).toHaveLength(2);
    for (const row of cipherRows) {
      expect(row.content_ciphertext).toBeInstanceOf(Buffer);
      expect(row.content_ciphertext?.toString('utf8')).not.toContain('private');
      expect(row.content_preview).toBeNull();
    }
    const messages = await transaction(db => listAiMessages(db, tenantA, '201', key, 10));
    expect(messages.map(message => message.text)).toEqual([
      'private customer prompt', 'private assistant response'
    ]);
    expect(await count("SELECT COUNT(*) AS total FROM audit_logs WHERE action='ai_run_completed' AND company_id=1")).toBe(1);

    // The first USD 0.05 reservation exhausts this company's USD 0.05 monthly policy.
    await expect(transaction(db => reserveGeneration(db, tenantA, '201', 'qa-model', budget)))
      .rejects.toThrow();
    expect(await count('SELECT COUNT(*) AS total FROM crm_ai_runs WHERE company_id=1')).toBe(1);
  });

  it('records sanitized provider failure without refunding the fixed reservation', async () => {
    const reserved = await transaction(db =>
      reserveGeneration(db, tenantB, '202', 'qa-model', budget)
    );
    await transaction(db => markGenerationFailed(db, tenantB, reserved.runId));
    expect(await count("SELECT COUNT(*) AS total FROM crm_ai_runs WHERE company_id=2 AND status='failed'")).toBe(1);
    expect(await count('SELECT COUNT(*) AS total FROM crm_ai_usage_events WHERE company_id=2')).toBe(1);
    expect(await count("SELECT COUNT(*) AS total FROM audit_logs WHERE company_id=2 AND action='ai_run_failed'")).toBe(1);
    expect(await count('SELECT COUNT(*) AS total FROM crm_ai_messages WHERE company_id=2')).toBe(0);
  });
});
