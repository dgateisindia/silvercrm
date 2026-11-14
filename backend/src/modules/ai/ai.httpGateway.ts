import type { AiGateway, AiProvider } from './ai.types';

const TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 262_144;
const MAX_OUTPUT_CHARS = 12_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' &&
    value !== null && !Array.isArray(value);
}

function extractOpenAi(value: unknown): string | null {
  if (!isObject(value) || !Array.isArray(value.output)) return null;

  const parts: string[] = [];

  for (const item of value.output) {
    if (!isObject(item) || item.type !== 'message' ||
        !Array.isArray(item.content)) continue;

    for (const segment of item.content) {
      if (isObject(segment) && segment.type === 'output_text' &&
          typeof segment.text === 'string') {
        parts.push(segment.text);
      }
    }
  }

  return parts.length ? parts.join('\n') : null;
}

function extractDeepSeek(value: unknown): string | null {
  if (!isObject(value) || !Array.isArray(value.choices)) return null;

  const first: unknown = value.choices[0];

  if (!isObject(first) || !isObject(first.message)) return null;

  return typeof first.message.content === 'string'
    ? first.message.content
    : null;
}

function extractGemini(value: unknown): string | null {
  if (!isObject(value) || !Array.isArray(value.candidates)) return null;

  const first: unknown = value.candidates[0];

  if (!isObject(first) || !isObject(first.content) ||
      !Array.isArray(first.content.parts)) return null;

  const texts: string[] = [];

  for (const part of first.content.parts) {
    if (isObject(part) && typeof part.text === 'string') {
      texts.push(part.text);
    }
  }

  return texts.length ? texts.join('\n') : null;
}

function makeRequest(
  provider: AiProvider,
  model: string,
  apiKey: string,
  prompt: string
): {
  url: string;
  headers: Record<string, string>;
  body: string;
} {
  if (provider === 'gemini') {
    return {
      url:
        'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(model) + ':generateContent',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{ text: prompt }]
        }],
        generationConfig: { maxOutputTokens: 1024 }
      })
    };
  }

  if (provider === 'deepseek') {
    return {
      url: 'https://api.deepseek.com/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        thinking: { type: 'disabled' },
        max_tokens: 1024
      })
    };
  }

  if (provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/responses',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        input: prompt,
        max_output_tokens: 1024,
        store: false
      })
    };
  }

  throw new Error('AI_PROVIDER_UNSUPPORTED');
}

async function readJsonBounded(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';

  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    throw new Error('AI_PROVIDER_INVALID_CONTENT_TYPE');
  }

  const lengthHeader = response.headers.get('content-length');

  if (lengthHeader && Number(lengthHeader) > MAX_RESPONSE_BYTES) {
    throw new Error('AI_PROVIDER_RESPONSE_TOO_LARGE');
  }

  if (!response.body) throw new Error('AI_PROVIDER_EMPTY_RESPONSE');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let received = 0;
  let content = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      received += value.byteLength;

      if (received > MAX_RESPONSE_BYTES) {
        throw new Error('AI_PROVIDER_RESPONSE_TOO_LARGE');
      }

      content += decoder.decode(value, { stream: true });
    }

    content += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error('AI_PROVIDER_INVALID_JSON');
  }
}

export function createHttpAiGateway(
  fetcher: typeof fetch = fetch
): AiGateway {
  return {
    async generate(request) {
      if (
        !request ||
        !/^[A-Za-z0-9._:/-]{1,100}$/.test(request.model) ||
        typeof request.apiKey !== 'string' ||
        !request.apiKey.trim() ||
        typeof request.prompt !== 'string' ||
        !request.prompt.trim() ||
        request.prompt.length > 4000
      ) {
        throw new Error('AI_GATEWAY_INVALID_REQUEST');
      }

      const { url, headers, body } = makeRequest(
        request.provider,
        request.model,
        request.apiKey,
        request.prompt
      );

      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        TIMEOUT_MS
      );

      try {
        let response: Response;

        try {
          response = await fetcher(url, {
            method: 'POST',
            headers,
            body,
            signal: controller.signal,
            redirect: 'error'
          });
        } catch {
          throw new Error('AI_PROVIDER_NETWORK_ERROR');
        }

        if (!response.ok) {
          throw new Error(`AI_PROVIDER_HTTP_${response.status}`);
        }

        const data = await readJsonBounded(response);

        const text =
          request.provider === 'gemini'
            ? extractGemini(data)
            : request.provider === 'deepseek'
              ? extractDeepSeek(data)
              : extractOpenAi(data);

        if (
          typeof text !== 'string' ||
          !text.trim() ||
          text.length > MAX_OUTPUT_CHARS
        ) {
          throw new Error('AI_PROVIDER_INVALID_OUTPUT');
        }

        return { text: text.trim() };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
