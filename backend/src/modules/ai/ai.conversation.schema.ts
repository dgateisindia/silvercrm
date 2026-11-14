import { AppError } from '../../core/errors/AppError';

export function aiDbId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,19}$/.test(raw) ||
      BigInt(raw) > 18446744073709551615n) throw AppError.badRequest();
  return raw;
}
export function aiConversationLimit(raw: Record<string, unknown>): number {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some(k => k !== 'limit')) throw AppError.badRequest();
  if (raw.limit === undefined) return 20;
  if (typeof raw.limit !== 'string' || !/^[1-9][0-9]?$/.test(raw.limit)) throw AppError.badRequest();
  const limit = Number(raw.limit);
  if (limit < 1 || limit > 50) throw AppError.badRequest();
  return limit;
}
export function aiNoQuery(raw: Record<string, unknown>): void {
  if (!raw || Object.keys(raw).length !== 0) throw AppError.badRequest();
}
export interface NewAiConversation { readonly assistantId: string; readonly title: string | null; }
export function parseNewConversation(raw: unknown): NewAiConversation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw AppError.badRequest();
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).some(k => k !== 'assistantId' && k !== 'title')) throw AppError.badRequest();
  const assistantId = aiDbId(obj.assistantId);
  if (obj.title !== undefined && obj.title !== null && typeof obj.title !== 'string') throw AppError.badRequest();
  const title = typeof obj.title === 'string' ? obj.title.trim() : null;
  if (title !== null && (!title || title.length > 120 || /[\x00-\x1f\x7f]/.test(title))) throw AppError.badRequest();
  return { assistantId, title };
}
