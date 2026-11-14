import { describe, expect, it } from 'vitest';

import { createHttpAiGateway } from '../../src/modules/ai/ai.httpGateway';
import type { AiProvider } from '../../src/modules/ai/ai.types';

const sample: Record<AiProvider, unknown> = {
  gemini: {
    candidates: [{ content: { parts: [{ text: 'Gemini OK' }] } }]
  },
  deepseek: {
    choices: [{ message: { content: 'DeepSeek OK' } }]
  },
  openai: {
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: 'OpenAI OK' }]
    }]
  }
};

const request = (provider: AiProvider) => ({
  provider,
  model: 'unit-test-model',
  apiKey: 'unit-test-secret',
  prompt: 'test',
  companyId: '1',
  actorUserId: '2',
  purpose: 'chat' as const
});

describe('AI provider adapters - mocked HTTP', () => {
  for (const provider of ['gemini', 'deepseek', 'openai'] as const) {
    it(`handles ${provider} output safely`, async () => {
      let calledUrl = '';
      let calledInit: RequestInit | undefined;

      const fakeFetch: typeof fetch = async (url, init) => {
        calledUrl = String(url);
        calledInit = init;

        return new Response(JSON.stringify(sample[provider]), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      };

      const result = await createHttpAiGateway(fakeFetch)
        .generate(request(provider));

      expect(result.text).toContain('OK');
      expect(calledUrl).toMatch(/^https:\/\//);
      expect(calledInit?.method).toBe('POST');
      expect(calledInit?.redirect).toBe('error');
      expect(calledInit?.body).not.toContain('unit-test-secret');
      expect(calledUrl).not.toContain('unit-test-secret');

      if (provider === 'gemini') {
        expect(calledUrl).toContain('generativelanguage.googleapis.com');
      } else if (provider === 'deepseek') {
        expect(calledUrl).toContain('api.deepseek.com');
      } else {
        expect(calledUrl).toContain('api.openai.com');
      }
    });
  }

  it('handles upstream HTTP failures', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('private error', { status: 401 });

    await expect(
      createHttpAiGateway(fakeFetch).generate(request('openai'))
    ).rejects.toThrow('AI_PROVIDER_HTTP_401');
  });

  it('rejects malformed responses', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('bad-json', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });

    await expect(
      createHttpAiGateway(fakeFetch).generate(request('gemini'))
    ).rejects.toThrow('AI_PROVIDER_INVALID_JSON');
  });

  it('rejects oversized responses', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('x'.repeat(262145), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });

    await expect(
      createHttpAiGateway(fakeFetch).generate(request('deepseek'))
    ).rejects.toThrow('AI_PROVIDER_RESPONSE_TOO_LARGE');
  });
});
