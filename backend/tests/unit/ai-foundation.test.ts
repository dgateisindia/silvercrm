import { describe, expect, it, vi } from 'vitest';

import { resolveAiConfiguration } from '../../src/modules/ai/ai.config';
import { parseAiInput } from '../../src/modules/ai/ai.schema';
import { runAi } from '../../src/modules/ai/ai.service';

import type {
  AiGateway,
  TrustedAiContext
} from '../../src/modules/ai/ai.types';

const actor: TrustedAiContext = {
  companyId: '1',
  actorUserId: '2',
  role: 'EMPLOYEE',
  accessMode: 'FULL'
};

const enabled = {
  CRM_AI_ENABLED: 'true',
  CRM_AI_PROVIDER: 'openai',
  CRM_AI_MODEL: 'example-model',
  CRM_OPENAI_API_KEY: 'unit-test-placeholder'
};

describe('Silver AI foundation - no provider calls', () => {
  it('is disabled by default', () => {
    expect(resolveAiConfiguration({}).state).toBe('disabled');
  });

  it('requires provider credentials', () => {
    const config = resolveAiConfiguration({
      ...enabled,
      CRM_OPENAI_API_KEY: ''
    });

    expect(config.state).toBe('misconfigured');
  });

  it('rejects browser-supplied company and role', () => {
    expect(() => parseAiInput({
      purpose: 'chat',
      prompt: 'Hello',
      companyId: '999'
    })).toThrow();

    expect(() => parseAiInput({
      purpose: 'chat',
      prompt: 'Hello',
      role: 'OWNER'
    })).toThrow();
  });

  it('enforces prompt limits', () => {
    expect(() => parseAiInput({
      purpose: 'chat',
      prompt: 'x'.repeat(4001)
    })).toThrow();

    expect(parseAiInput({
      purpose: 'chat',
      prompt: ' Hello '
    }).prompt).toBe('Hello');
  });

  it('never invokes a gateway while disabled', async () => {
    const generate = vi.fn(
      async (_request: Parameters<AiGateway['generate']>[0]) =>
        ({ text: 'unused' })
    );

    await expect(runAi(
      { purpose: 'chat', prompt: 'hello' },
      actor,
      { generate },
      {}
    )).rejects.toThrow('AI_DISABLED');

    expect(generate).not.toHaveBeenCalled();
  });

  it('passes validated inputs to a mock gateway', async () => {
    const generate = vi.fn(
      async (_request: Parameters<AiGateway['generate']>[0]) =>
        ({ text: 'Safe test output' })
    );

    const result = await runAi(
      { purpose: 'chat', prompt: ' hello ' },
      actor,
      { generate },
      enabled
    );

    expect(result.text).toBe('Safe test output');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      companyId: '1',
      actorUserId: '2',
      purpose: 'chat',
      prompt: 'hello'
    });
  });
});
