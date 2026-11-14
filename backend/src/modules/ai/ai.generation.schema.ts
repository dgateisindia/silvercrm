import { AppError } from '../../core/errors/AppError';
import { aiDbId } from './ai.conversation.schema';
import type { AiInput } from './ai.types';
import { parseAiInput } from './ai.schema';

export interface GenerateAiRequest {
  readonly conversationId: string;
  readonly input: AiInput;
}

export function parseAiGenerationRequest(conversationId: unknown, body: unknown): GenerateAiRequest {
  const id = aiDbId(conversationId);
  const input = parseAiInput(body);
  // A single model call is deliberately bounded and contains no tools, attachments or company identifiers.
  if (input.prompt.length > 2500 || Buffer.byteLength(input.prompt, 'utf8') > 8000) {
    throw AppError.badRequest();
  }
  return { conversationId: id, input };
}

/** DECIMAL(18,6) to integral micro-dollars, exact; rejects scientific notation and negatives. */
export function moneyToMicros(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(value)) {
    throw new Error('AI_BUDGET_INVALID_DECIMAL');
  }
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1000000n + BigInt((fraction + '000000').slice(0, 6));
}

export function microsToMoney(value: bigint): string {
  if (value < 0n) throw new Error('AI_BUDGET_INVALID_VALUE');
  const whole = value / 1000000n;
  const fraction = (value % 1000000n).toString().padStart(6, '0');
  return `${whole}.${fraction}`;
}

function boundInt(value: string | undefined, min: number, max: number): number | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,3}$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

export interface AiBudgetLimits {
  readonly reserveMicros: bigint;
  readonly perUserDaily: number;
  readonly perCompanyDaily: number;
}
export function readAiBudgetLimits(env: Readonly<Record<string, string | undefined>>): AiBudgetLimits | null {
  // Require the deployment owner to explicitly provision limits; no unlimited fallback.
  try {
    const reserveMicros = moneyToMicros(env.CRM_AI_REQUEST_RESERVE_USD);
    const perUserDaily = boundInt(env.CRM_AI_DAILY_USER_LIMIT, 1, 100);
    const perCompanyDaily = boundInt(env.CRM_AI_DAILY_COMPANY_LIMIT, 1, 1000);
    if (reserveMicros < 100n || reserveMicros > 5000000n ||
        perUserDaily === null || perCompanyDaily === null || perUserDaily > perCompanyDaily) return null;
    return { reserveMicros, perUserDaily, perCompanyDaily };
  } catch {
    return null;
  }
}
