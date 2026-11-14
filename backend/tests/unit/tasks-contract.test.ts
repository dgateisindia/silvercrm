import { describe, expect, it } from 'vitest';
import { taskId, createTaskBody, patchTaskBody, completeTaskBody, taskListQuery } from '../../src/modules/tasks/schemas/task.schema';

const revision = '2026-11-03T08:01:02.123456Z';
describe('General Tasks validation (no database)', () => {
  it('parses a valid task with safe defaults', () => {
    const task = createTaskBody({ title: ' Follow up on proposal ' });
    expect(task.title).toBe('Follow up on proposal');
    expect(task.priority).toBe('normal');
    expect(task.ownerUserId).toBeNull();
    expect(task.dealId).toBeNull();
  });
  it('parses permitted deal/contact links and due date', () => {
    const task = createTaskBody({ title: 'Call client', dealId: '5', contactId: '8',
      dueAt: '2026-11-05T14:15:16.123Z', priority: 'high' });
    expect(task.dealId).toBe('5');
    expect(task.contactId).toBe('8');
    expect(task.dueAt).toBe('2026-11-05 14:15:16.123');
  });
  it('rejects cross-scope/browser-supplied fields', () => {
    for (const extra of ['companyId', 'createdBy', 'leadId', 'status']) {
      expect(() => createTaskBody({ title: 'A task', [extra]: '123' })).toThrow();
    }
  });
  it('rejects invalid task values', () => {
    expect(() => createTaskBody({ title: '' })).toThrow();
    expect(() => createTaskBody({ title: 'Task', priority: 'critical' })).toThrow();
    expect(() => createTaskBody({ title: 'Task', dueAt: '2026-02-30T00:00:00.000Z' })).toThrow();
  });
  it('requires revision token for every change', () => {
    expect(() => patchTaskBody({ title: 'new' })).toThrow();
    expect(() => patchTaskBody({ expectedRevision: revision })).toThrow();
    expect(patchTaskBody({ title: 'new', expectedRevision: revision }).title).toBe('new');
    expect(completeTaskBody({ expectedRevision: revision }).expectedRevision).toBe(revision);
    expect(() => completeTaskBody({})).toThrow();
  });
  it('limits task listing and validates statuses', () => {
    expect(taskListQuery({})).toEqual({ limit: 50, status: 'all' });
    expect(taskListQuery({ limit: '100', status: 'open' })).toEqual({ limit: 100, status: 'open' });
    for (const input of [{ limit: '101' }, { limit: '0' }, { status: 'deleted' }, { companyId: '1' }]) {
      expect(() => taskListQuery(input)).toThrow();
    }
  });
  it('rejects unsafe or overflowing task ids', () => {
    expect(taskId('18446744073709551615')).toBe('18446744073709551615');
    for (const invalid of ['0', '-1', '18446744073709551616', 0, 1.5, {}, '0001']) {
      expect(() => taskId(invalid)).toThrow();
    }
  });
});
