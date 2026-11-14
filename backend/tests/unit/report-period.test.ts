import { describe, expect, it } from 'vitest';
import { period } from '../../src/modules/reports/report.schema';

describe('Sales activity report date range (no database)', () => {
  it('allows a one-day report', () => {
    expect(period({ from: '2026-11-03', to: '2026-11-03' })).toEqual({
      from: '2026-11-03', to: '2026-11-03', days: 1
    });
  });
  it('handles leap year boundaries', () => {
    expect(period({ from: '2028-02-28', to: '2028-03-01' }).days).toBe(3);
  });
  it('supports the 93-day maximum', () => {
    expect(period({ from: '2026-01-01', to: '2026-04-03' }).days).toBe(93);
  });
  it('rejects inverted, excessive or partial date ranges', () => {
    for (const input of [
      { from: '2026-11-04', to: '2026-11-03' },
      { from: '2026-01-01', to: '2026-04-04' },
      { from: '2026-11-03' }, { to: '2026-11-03' }
    ]) expect(() => period(input)).toThrow();
  });
  it('rejects invalid calendar dates and unapproved filters', () => {
    for (const input of [
      { from: '2026-02-30', to: '2026-03-01' },
      { from: '2026-01-01', to: 'bad-date' },
      { from: '2026-01-01', to: '2026-01-02', companyId: '2' }
    ]) expect(() => period(input)).toThrow();
  });
});
