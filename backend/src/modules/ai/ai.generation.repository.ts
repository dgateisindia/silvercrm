import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { TenantContext } from '../../core/tenant/tenantContext';
import { AppError } from '../../core/errors/AppError';
import { moneyToMicros, microsToMoney, type AiBudgetLimits } from './ai.generation.schema';
import { appendAiMessage } from './ai.conversation.repository';

export type GenerationDb = Pick<PoolConnection, 'execute' | 'beginTransaction' | 'commit' | 'rollback' | 'release'>;
interface CountRow extends RowDataPacket { count: string | number; }
interface BudgetRow extends RowDataPacket { used: string | number; }
interface CompanyRow extends RowDataPacket { id: string | number; }
interface RunRow extends RowDataPacket { id: string | number; }
interface PolicyRow extends RowDataPacket {
  assistant_id: string | number;
  model_key: string;
  max_monthly_cost: string | number | null;
  read_only: number | boolean;
  allow_external_knowledge: number | boolean;
}

export interface AiReservation {
  readonly runId: string;
  readonly assistantId: string;
  readonly model: string;
}
function integerCount(v: string | number): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('AI_BUDGET_INVALID_COUNT');
  return n;
}

/** Must be called inside an active transaction. The company row lock serializes all tenant reservations. */
export async function reserveGeneration(
  db: GenerationDb, t: TenantContext, conversationId: string,
  expectedModel: string, limits: AiBudgetLimits
): Promise<AiReservation> {
  const [companies] = await db.execute<CompanyRow[]>(
    `SELECT id FROM companies WHERE id=? AND status='active' AND platform_access_mode='FULL' LIMIT 1 FOR UPDATE`,
    [t.companyId]
  );
  if (!companies[0]) throw AppError.forbidden();

  const [policies] = await db.execute<PolicyRow[]>(
    `SELECT a.id AS assistant_id,a.model_key,p.max_monthly_cost,p.read_only,p.allow_external_knowledge
       FROM crm_ai_conversations c
       JOIN crm_ai_assistants a ON a.company_id=c.company_id AND a.id=c.assistant_id
       JOIN crm_ai_policies p ON p.company_id=a.company_id AND p.assistant_id=a.id
      WHERE c.company_id=? AND c.id=? AND c.user_id=? AND c.status='active'
        AND a.enabled=1 LIMIT 1 FOR UPDATE`,
    [t.companyId, conversationId, t.actorUserId]
  );
  const policy = policies[0];
  if (!policy || policy.model_key !== expectedModel ||
      !(policy.read_only === 1 || policy.read_only === true) ||
      (policy.allow_external_knowledge === 1 || policy.allow_external_knowledge === true) ||
      policy.max_monthly_cost === null) throw AppError.forbidden();

  // The CRM schema's AI policy has no currency column. The deployment convention here is USD.
  const monthlyBudget = moneyToMicros(String(policy.max_monthly_cost));
  if (monthlyBudget < limits.reserveMicros) throw AppError.conflict();

  const [spentRows] = await db.execute<BudgetRow[]>(
    `SELECT COALESCE(SUM(estimated_cost),0) AS used
       FROM crm_ai_usage_events
      WHERE company_id=? AND currency='USD'
        AND created_at >= DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-01 00:00:00')`,
    [t.companyId]
  );
  const used = moneyToMicros(String(spentRows[0]?.used ?? '0'));
  if (used + limits.reserveMicros > monthlyBudget) throw AppError.conflict();

  const [companyDay] = await db.execute<CountRow[]>(
    `SELECT COUNT(*) AS count FROM crm_ai_runs
       WHERE company_id=? AND started_at>=UTC_DATE()`, [t.companyId]
  );
  const [userDay] = await db.execute<CountRow[]>(
    `SELECT COUNT(*) AS count FROM crm_ai_runs
       WHERE company_id=? AND initiated_by_id=? AND started_at>=UTC_DATE()`,
    [t.companyId, t.actorUserId]
  );
  if (integerCount(companyDay[0]?.count ?? 0) >= limits.perCompanyDaily ||
      integerCount(userDay[0]?.count ?? 0) >= limits.perUserDaily) throw AppError.conflict();

  const [running] = await db.execute<CountRow[]>(
    `SELECT COUNT(*) AS count FROM crm_ai_runs
       WHERE company_id=? AND conversation_id=? AND status='running'`,
    [t.companyId, conversationId]
  );
  if (integerCount(running[0]?.count ?? 0) !== 0) throw AppError.conflict();

  const [insert] = await db.execute<ResultSetHeader>(
    `INSERT INTO crm_ai_runs
       (company_id,conversation_id,assistant_id,initiated_by_id,model_key,status,started_at)
     VALUES (?,?,?,?,?,'running',UTC_TIMESTAMP(3))`,
    [t.companyId, conversationId, String(policy.assistant_id), t.actorUserId, expectedModel]
  );
  const runId = String(insert.insertId);
  if (!/^[1-9]\d*$/.test(runId)) throw new Error('AI_RUN_INSERT_FAILED');

  // Conservative fixed reservation; never reported as measured provider spend or token count.
  await db.execute(
    `INSERT INTO crm_ai_usage_events
      (company_id,run_id,model_key,prompt_tokens,completion_tokens,estimated_cost,currency)
      VALUES (?,?,?,0,0,?,'USD')`,
    [t.companyId, runId, expectedModel, microsToMoney(limits.reserveMicros)]
  );
  await db.execute(
    `INSERT INTO audit_logs
      (company_id,actor_user_id,action,entity_type,entity_id,outcome,details_json,occurred_at)
      VALUES (?,?,'ai_run_reserved','ai_run',?,'success',?,UTC_TIMESTAMP(3))`,
    [t.companyId, t.actorUserId, runId, JSON.stringify({conversationId, reservedUsd: microsToMoney(limits.reserveMicros)})]
  );
  return { runId, assistantId: String(policy.assistant_id), model: expectedModel };
}

/** Transaction must enclose both encrypted messages, outcome and audit. */
export async function completeGeneration(
  db: GenerationDb, t: TenantContext, conversationId: string, runId: string,
  prompt: string, answer: string, key: Buffer
): Promise<{runId: string; userMessageId: string; assistantMessageId: string}> {
  const [companyRows] = await db.execute<CompanyRow[]>(
    `SELECT id FROM companies WHERE id=? AND status='active' AND platform_access_mode='FULL' LIMIT 1 FOR UPDATE`,
    [t.companyId]
  );
  if (!companyRows[0]) throw AppError.forbidden();
  const [rows] = await db.execute<RunRow[]>(
    `SELECT r.id FROM crm_ai_runs r
       JOIN crm_ai_conversations c ON c.company_id=r.company_id AND c.id=r.conversation_id
      WHERE r.id=? AND r.company_id=? AND r.conversation_id=? AND r.initiated_by_id=?
        AND r.status='running' AND c.status='active' AND c.user_id=? LIMIT 1 FOR UPDATE`,
    [runId, t.companyId, conversationId, t.actorUserId, t.actorUserId]
  );
  if (rows.length !== 1) throw AppError.conflict();
  const userMessageId = await appendAiMessage(db, t, conversationId, 'user', prompt, key);
  const assistantMessageId = await appendAiMessage(db, t, conversationId, 'assistant', answer, key);
  await db.execute(
    `UPDATE crm_ai_runs SET status='completed',completed_at=UTC_TIMESTAMP(3)
      WHERE id=? AND company_id=? AND initiated_by_id=? AND status='running'`,
    [runId, t.companyId, t.actorUserId]
  );
  await db.execute(
    `INSERT INTO audit_logs
      (company_id,actor_user_id,action,entity_type,entity_id,outcome,details_json,occurred_at)
      VALUES (?,?,'ai_run_completed','ai_run',?,'success',?,UTC_TIMESTAMP(3))`,
    [t.companyId, t.actorUserId, runId, JSON.stringify({conversationId})]
  );
  return { runId, userMessageId, assistantMessageId };
}

export async function markGenerationFailed(db: GenerationDb, t: TenantContext, runId: string): Promise<void> {
  await db.execute(
    `UPDATE crm_ai_runs SET status='failed',error_code='AI_PROVIDER_OR_STORAGE_FAILURE',
      completed_at=UTC_TIMESTAMP(3) WHERE company_id=? AND id=? AND initiated_by_id=? AND status='running'`,
    [t.companyId, runId, t.actorUserId]
  );
  await db.execute(
    `INSERT INTO audit_logs
      (company_id,actor_user_id,action,entity_type,entity_id,outcome,details_json,occurred_at)
      VALUES (?,?,'ai_run_failed','ai_run',?,'failure',NULL,UTC_TIMESTAMP(3))`,
    [t.companyId,t.actorUserId,runId]
  );
}
