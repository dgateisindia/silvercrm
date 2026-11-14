import { describe, expect, it, vi } from 'vitest';
import { parseAiGenerationRequest, moneyToMicros, microsToMoney, readAiBudgetLimits } from '../../src/modules/ai/ai.generation.schema';
import { createAiGenerationService } from '../../src/modules/ai/ai.generation.service';

const limits = {
  CRM_AI_REQUEST_RESERVE_USD: '0.050000',
  CRM_AI_DAILY_USER_LIMIT: '10',
  CRM_AI_DAILY_COMPANY_LIMIT: '100'
};

describe('Silver CRM AI paid-execution gate', () => {
  it('uses exact micro-USD arithmetic', () => {
    expect(moneyToMicros('10.012345')).toBe(10012345n);
    expect(microsToMoney(moneyToMicros('10.012345'))).toBe('10.012345');
    expect(() => moneyToMicros('-1')).toThrow();
    expect(() => moneyToMicros('1e9')).toThrow();
    expect(() => moneyToMicros('0.1234567')).toThrow();
  });
  it('does not grant unlimited spending from absent or malformed env', () => {
    expect(readAiBudgetLimits({})).toBeNull();
    expect(readAiBudgetLimits({ ...limits, CRM_AI_REQUEST_RESERVE_USD: '0' })).toBeNull();
    expect(readAiBudgetLimits({ ...limits, CRM_AI_DAILY_USER_LIMIT: '200' })).toBeNull();
    expect(readAiBudgetLimits(limits)?.reserveMicros).toBe(50000n);
  });
  it('rejects unsafe browser metadata', () => {
    expect(parseAiGenerationRequest('1', {purpose:'chat', prompt:'hello'}).input.prompt).toBe('hello');
    expect(() => parseAiGenerationRequest('1', {purpose:'chat', prompt:'hello', companyId:'2'})).toThrow();
    expect(() => parseAiGenerationRequest('0', {purpose:'chat', prompt:'hello'})).toThrow();
    expect(() => parseAiGenerationRequest('1', {purpose:'chat', prompt:'x'.repeat(2501)})).toThrow();
  });
  it('never accesses the DB or provider while generation switch is off', async () => {
    const factory = vi.fn(async () => { throw new Error('unexpected DB connection'); });
    const generate = vi.fn(async () => ({text:'unexpected provider call'}));
    const service = createAiGenerationService({
      connectionFactory: factory,
      gateway: {generate},
      environment: { ...limits, CRM_AI_GENERATION_ENABLED: 'false' }
    });
    const fakeResponse = {} as Parameters<typeof service.generate>[0];
    await expect(service.generate(fakeResponse, '1', {purpose:'chat',prompt:'hi'})).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});
