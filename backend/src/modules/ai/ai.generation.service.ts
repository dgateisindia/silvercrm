import type { Response } from 'express';
import { getDbPool } from '../../core/database/pool';
import { getTenantContext } from '../../core/tenant/tenantContext';
import { AppError } from '../../core/errors/AppError';
import { resolveAiConfiguration } from './ai.config';
import { createHttpAiGateway } from './ai.httpGateway';
import { runAi } from './ai.service';
import { readAiContentKey } from './ai.conversation.crypto';
import { parseAiGenerationRequest, readAiBudgetLimits } from './ai.generation.schema';
import {
  type GenerationDb, reserveGeneration, completeGeneration, markGenerationFailed
} from './ai.generation.repository';
import type { AiGateway } from './ai.types';

export interface AiGenerationDependencies {
  readonly connectionFactory?: () => Promise<GenerationDb>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly gateway?: AiGateway;
}

export function createAiGenerationService(deps: AiGenerationDependencies = {}) {
  const connectionFactory = deps.connectionFactory ?? (() => getDbPool().getConnection());
  const env = deps.environment ?? process.env;
  const gateway = deps.gateway ?? createHttpAiGateway();

  async function transact<T>(work: (db: GenerationDb) => Promise<T>): Promise<T> {
    const db = await connectionFactory();
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
    } finally { db.release(); }
  }

  return Object.freeze({
    async generate(res: Response, conversationId: unknown, body: unknown) {
      const tenant = getTenantContext(res);
      if (tenant.accessMode !== 'FULL' || tenant.role === 'OWNER') throw AppError.forbidden();
      // Explicit second activation switch. Conversation listing may be enabled independently.
      if (env.CRM_AI_GENERATION_ENABLED !== 'true') throw AppError.forbidden();
      const config = resolveAiConfiguration(env);
      const limits = readAiBudgetLimits(env);
      if (config.state !== 'ready' || !limits) throw AppError.forbidden();
      const key = readAiContentKey(env.CRM_AI_CONTENT_KEY_B64);
      const { conversationId: id, input } = parseAiGenerationRequest(conversationId, body);

      // Persistent reservation is committed BEFORE calling a paid external provider.
      const reservation = await transact(db => reserveGeneration(db, tenant, id, config.model, limits));
      try {
        const answer = await runAi(input, {
          companyId: tenant.companyId, actorUserId: tenant.actorUserId,
          role: tenant.role, accessMode: tenant.accessMode
        }, gateway, env);
        const saved = await transact(db => completeGeneration(
          db, tenant, id, reservation.runId, input.prompt, answer.text, key
        ));
        return { ...saved, text: answer.text, model: answer.model };
      } catch {
        // Best effort, sanitized failure event. A reservation remains if DB is unreachable,
        // conservatively consuming quota rather than silently allowing more provider spend.
        try {
          await transact(db => markGenerationFailed(db, tenant, reservation.runId));
        } catch { /* existing reservation deliberately retained */ }
        throw new Error('AI_GENERATION_FAILED');
      }
    }
  });
}
