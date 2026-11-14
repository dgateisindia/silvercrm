import type { AiInput, AiPurpose } from './ai.types';

const purposes: readonly AiPurpose[] = [
  'lead_summary',
  'followup_draft',
  'email_draft',
  'chat'
];

export function parseAiInput(value: unknown): AiInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AI_INVALID_INPUT');
  }

  const candidate = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(candidate);

  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('AI_INVALID_INPUT');
  }

  if (Object.keys(candidate).some(
    key => !['purpose', 'prompt'].includes(key)
  )) {
    throw new Error('AI_INVALID_INPUT');
  }

  if (
    typeof candidate.purpose !== 'string' ||
    !purposes.includes(candidate.purpose as AiPurpose)
  ) {
    throw new Error('AI_INVALID_PURPOSE');
  }

  if (typeof candidate.prompt !== 'string') {
    throw new Error('AI_INVALID_PROMPT');
  }

  const prompt = candidate.prompt.trim();

  if (
    !prompt ||
    prompt.length > 4000 ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(prompt)
  ) {
    throw new Error('AI_INVALID_PROMPT');
  }

  return Object.freeze({
    purpose: candidate.purpose as AiPurpose,
    prompt
  });
}
