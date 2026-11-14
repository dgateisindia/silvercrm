import { AppError } from '../../core/errors/AppError';

export type InviteRole = 'manager' | 'employee';
export interface InviteRequest {
  readonly email: string;
  readonly fullName: string;
  readonly role: InviteRole;
  readonly teamId: string | null;
  readonly idempotencyKey: string;
}

export function inviteId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value) ||
      BigInt(value) > 18446744073709551615n) throw AppError.badRequest();
  return value;
}

export function inviteRequest(raw: unknown): InviteRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw AppError.badRequest();
  const x = raw as Record<string, unknown>;
  if (Object.keys(x).some(k => !['email', 'fullName', 'role', 'teamId', 'idempotencyKey'].includes(k)))
    throw AppError.badRequest();
  if (typeof x.email !== 'string' || x.email.length > 254) throw AppError.badRequest();
  const email = x.email.trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,185}\.[a-z]{2,24}$/.test(email)) throw AppError.badRequest();
  if (typeof x.fullName !== 'string' || !x.fullName.trim() ||
      x.fullName.trim().length > 180 || /[\x00-\x1f\x7f]/.test(x.fullName)) throw AppError.badRequest();
  if (x.role !== 'manager' && x.role !== 'employee') throw AppError.badRequest();
  if (typeof x.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,120}$/.test(x.idempotencyKey))
    throw AppError.badRequest();
  const teamId = x.teamId === undefined || x.teamId === null ? null : inviteId(x.teamId);
  if ((x.role === 'manager' && teamId !== null) || (x.role === 'employee' && teamId === null))
    throw AppError.badRequest();
  return Object.freeze({ email, fullName: x.fullName.trim(), role: x.role,
    teamId, idempotencyKey: x.idempotencyKey });
}

export function inviteLimit(query: Record<string, unknown>): number {
  if (Object.keys(query).some(k => k !== 'limit')) throw AppError.badRequest();
  if (query.limit === undefined) return 30;
  if (typeof query.limit !== 'string' || !/^[1-9][0-9]?$/.test(query.limit)) throw AppError.badRequest();
  const limit = Number(query.limit);
  if (limit < 1 || limit > 50) throw AppError.badRequest();
  return limit;
}
