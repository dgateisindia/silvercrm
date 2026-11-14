import { resolveAiConfiguration } from './ai.config';
import { parseAiInput } from './ai.schema';

import type {
  AiGateway,
  AiPurpose,
  AiProvider,
  TrustedAiContext
} from './ai.types';

function positiveId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,19}$/.test(value) &&
    BigInt(value) <= 18446744073709551615n
  );
}

export async function runAi(
  input: unknown,
  actor: TrustedAiContext,
  gateway: AiGateway,
  env: Readonly<Record<string, string | undefined>>
): Promise<Readonly<{
  purpose: AiPurpose;
  provider: AiProvider;
  model: string;
  text: string;
}>> {
  if (
    !actor ||
    !positiveId(actor.companyId) ||
    !positiveId(actor.actorUserId) ||
    !['OWNER', 'MANAGER', 'EMPLOYEE'].includes(actor.role) ||
    actor.accessMode !== 'FULL'
  ) {
    throw new Error('AI_ACCESS_DENIED');
  }

  const config = resolveAiConfiguration(env);

  if (config.state === 'disabled') {
    throw new Error('AI_DISABLED');
  }

  if (config.state !== 'ready') {
    throw new Error('AI_NOT_CONFIGURED');
  }

  const request = parseAiInput(input);

  const result = await gateway.generate({
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    companyId: actor.companyId,
    actorUserId: actor.actorUserId,
    purpose: request.purpose,
    prompt: request.prompt
  });

  if (
    !result ||
    typeof result.text !== 'string' ||
    !result.text.trim() ||
    result.text.length > 12000
  ) {
    throw new Error('AI_INVALID_PROVIDER_RESPONSE');
  }

  return Object.freeze({
    purpose: request.purpose,
    provider: config.provider,
    model: config.model,
    text: result.text
  });
}
