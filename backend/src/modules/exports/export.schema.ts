import { AppError } from '../../core/errors/AppError';

export interface ExportQuery {
  readonly format: 'CSV' | 'JSON';
  readonly limit: number;
}

export function parseExportQuery(raw: Record<string, unknown>): ExportQuery {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw AppError.badRequest();
  if (Object.keys(raw).some(key => key !== 'format' && key !== 'limit')) throw AppError.badRequest();
  const format = raw.format === undefined ? 'CSV' : raw.format;
  if (format !== 'CSV' && format !== 'JSON') throw AppError.badRequest();
  const rawLimit = raw.limit === undefined ? '100' : raw.limit;
  if (typeof rawLimit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(rawLimit)) throw AppError.badRequest();
  const limit = Number(rawLimit);
  if (limit > 500) throw AppError.badRequest();
  return { format, limit };
}

export function parseHistoryQuery(raw: Record<string, unknown>): number {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some(key => key !== 'limit')) throw AppError.badRequest();
  const rawLimit = raw.limit === undefined ? '30' : raw.limit;
  if (typeof rawLimit !== 'string' || !/^[1-9][0-9]{0,1}$/.test(rawLimit)) throw AppError.badRequest();
  const limit = Number(rawLimit);
  if (limit > 50) throw AppError.badRequest();
  return limit;
}