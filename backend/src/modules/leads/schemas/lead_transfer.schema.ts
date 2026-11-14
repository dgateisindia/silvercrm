import { AppError } from "../../../core/errors/AppError";
import { leadRecordId } from "./lead_edit.schema";

export interface DirectTransferInput {
  readonly expectedOwnerUserId: string;
  readonly toUserId: string;
  readonly reason: string;
}

export function parseDirectTransfer(input: unknown): DirectTransferInput {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  ) {
    throw AppError.badRequest();
  }

  const item = input as Record<string, unknown>;

  if (
    Object.keys(item).length !== 3 ||
    Object.keys(item).some(
      key => !["expectedOwnerUserId", "toUserId", "reason"].includes(key)
    )
  ) {
    throw AppError.badRequest();
  }

  const expectedOwnerUserId = leadRecordId(item.expectedOwnerUserId);
  const toUserId = leadRecordId(item.toUserId);

  if (
    expectedOwnerUserId === toUserId ||
    typeof item.reason !== "string" ||
    !item.reason.trim() ||
    item.reason.trim().length > 500
  ) {
    throw AppError.badRequest();
  }

  return Object.freeze({
    expectedOwnerUserId,
    toUserId,
    reason: item.reason.trim(),
  });
}