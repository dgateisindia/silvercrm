import { AppError } from "../../../core/errors/AppError";
import { obj, scaled } from "../../sales/schemas/sales.schema";
import { money } from "../../finance/schemas/finance.schema";
import { date, reportFormat } from "../../operations/schemas/operations.schema";

const invalid = (): never => { throw AppError.badRequest(); };

export function rolloverBody(value: unknown) {
  const row = obj(value, ["nextStartsOn", "nextEndsOn", "baseAmount", "expectedEffective"]);
  if (Object.keys(row).length !== 4) return invalid();
  const nextStartsOn = date(row.nextStartsOn);
  const nextEndsOn = date(row.nextEndsOn);
  if (nextEndsOn < nextStartsOn ||
      (Date.parse(nextEndsOn) - Date.parse(nextStartsOn)) / 86400000 > 370) return invalid();
  return {
    nextStartsOn, nextEndsOn,
    baseAmount: money(row.baseAmount),
    expectedEffective: money(row.expectedEffective)
  };
}

export function refundReviewBody(value: unknown) {
  const row = obj(value, ["decision", "expectedStatus", "reason"]);
  if (Object.keys(row).length !== 3 || row.expectedStatus !== "pending" ||
      (row.decision !== "approved" && row.decision !== "rejected") ||
      typeof row.reason !== "string" || !row.reason.trim() ||
      row.reason.trim().length > 350 || /[\x00-\x08\x0B\x0E-\x1F]/.test(row.reason)) return invalid();
  return { decision: row.decision, expectedStatus: "pending" as const, reason: row.reason.trim() };
}

export function analyticsRange(from: unknown, to: unknown) {
  const first = date(from), last = date(to);
  if (first > last || (Date.parse(last) - Date.parse(first)) / 86400000 > 366) return invalid();
  return { from: first, to: last };
}

export function analyticsFormat(value: unknown) { return reportFormat(value); }

export function safeAmount(input: string): bigint {
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/.test(input)) return invalid();
  return scaled(input, 2);
}