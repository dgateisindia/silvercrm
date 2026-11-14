import { AppError } from "../../../core/errors/AppError";

export function recordId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > 18446744073709551615n) throw AppError.badRequest();
  return value;
}
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw AppError.badRequest();
  const val = value as Record<string, unknown>;
  if (Object.keys(val).some(x => !keys.includes(x))) throw AppError.badRequest();
  return val;
}
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\x00-\x08\x0B\x0E-\x1F]/.test(value)) throw AppError.badRequest();
  return value.trim();
}
export function transferRequestInput(input: unknown) {
  const val = object(input, ["toUserId", "reason"]);
  return Object.freeze({toUserId: recordId(val.toUserId), reason: cleanText(val.reason, 500)});
}
export function decisionInput(input: unknown) {
  const val = object(input, ["decision", "notes"]);
  if (val.decision !== "approved" && val.decision !== "rejected") throw AppError.badRequest();
  if (val.notes !== undefined && val.notes !== null && (typeof val.notes !== "string" || val.notes.length > 400)) throw AppError.badRequest();
  return Object.freeze({decision: val.decision, notes: val.notes === undefined || val.notes === null ? null : val.notes as string});
}
export function followupInput(input: unknown) {
  const val = object(input, ["title", "description", "dueAt"]);
  const title = cleanText(val.title, 200);
  const description = val.description === undefined || val.description === null ? null : val.description;
  if (description !== null && (typeof description !== "string" || description.length > 10000)) throw AppError.badRequest();
  const dueAt = val.dueAt === undefined || val.dueAt === null ? null : val.dueAt;
  if (dueAt !== null) {
    if (typeof dueAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(dueAt) ||
        !Number.isFinite(Date.parse(dueAt)) || new Date(dueAt).toISOString() !== dueAt) throw AppError.badRequest();
  }
  return Object.freeze({ title, description: description as string | null, dueAt: dueAt as string | null });
}
export function boundedLimit(value: unknown, max = 100): number {
  if (value === undefined) return Math.min(25, max);
  if (typeof value !== "string" || !/^[1-9][0-9]{0,2}$/.test(value)) throw AppError.badRequest();
  const n = Number(value);
  if (n > max) throw AppError.badRequest();
  return n;
}