import type { AiProvider } from './ai.types';

export type AiConfiguration =
  | Readonly<{ state: 'disabled' }>
  | Readonly<{
      state: 'misconfigured';
      reason: 'PROVIDER' | 'MODEL' | 'KEY';
    }>
  | Readonly<{
      state: 'ready';
      provider: AiProvider;
      model: string;
      apiKey: string;
    }>;

const providerKeys: Record<AiProvider, string> = {
  gemini: 'CRM_GEMINI_API_KEY',
  deepseek: 'CRM_DEEPSEEK_API_KEY',
  openai: 'CRM_OPENAI_API_KEY'
};

export function resolveAiConfiguration(
  env: Readonly<Record<string, string | undefined>>
): AiConfiguration {
  if (env.CRM_AI_ENABLED !== 'true') {
    return { state: 'disabled' };
  }

  const provider = env.CRM_AI_PROVIDER;

  if (
    provider !== 'gemini' &&
    provider !== 'deepseek' &&
    provider !== 'openai'
  ) {
    return { state: 'misconfigured', reason: 'PROVIDER' };
  }

  const model = env.CRM_AI_MODEL;

  if (!model || !/^[A-Za-z0-9._:/-]{1,100}$/.test(model)) {
    return { state: 'misconfigured', reason: 'MODEL' };
  }

  const apiKey = env[providerKeys[provider]];

  if (!apiKey || !apiKey.trim()) {
    return { state: 'misconfigured', reason: 'KEY' };
  }

  return { state: 'ready', provider, model, apiKey };
}
