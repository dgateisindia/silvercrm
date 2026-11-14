import { AppError } from "../../../core/errors/AppError";

import {
  parseRecordId,
  parseCustomKey,
  parseValueEdit,
} from "../../customization/schemas/lead_values.schema";

export interface NewLeadInput {
  readonly title: string;
  readonly status: string;
  readonly priority: string;
  readonly sourceKey: string | null;
  readonly description: string | null;
  readonly ownerUserId: string;
  readonly customValues: Readonly<Record<string, unknown>>;
}

function choice(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    !/^[a-z][a-z0-9_]*$/.test(value)
  ) {
    throw AppError.badRequest();
  }

  return value;
}

function plain(value: unknown): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}

/**
 * All customer choices and field definitions
 * are validated against MariaDB separately.
 */
export function parseNewLead(
  input: unknown,
  actorId: string
): NewLeadInput {
  if (!plain(input)) {
    throw AppError.badRequest();
  }

  const allowed = [
    "title",
    "status",
    "priority",
    "sourceKey",
    "description",
    "ownerUserId",
    "customValues",
  ];

  if (
    Object.keys(input).some(
      key => !allowed.includes(key)
    )
  ) {
    throw AppError.badRequest();
  }

  if (
    typeof input.title !== "string" ||
    input.title.trim().length < 1 ||
    input.title.trim().length > 200
  ) {
    throw AppError.badRequest();
  }

  const status = choice(input.status, 40);
  const priority = choice(input.priority, 20);

  const sourceKey =
    input.sourceKey === undefined ||
    input.sourceKey === null
      ? null
      : choice(input.sourceKey, 60);

  const description =
    input.description === undefined ||
    input.description === null
      ? null
      : input.description;

  if (
    description !== null &&
    (
      typeof description !== "string" ||
      description.length > 10000
    )
  ) {
    throw AppError.badRequest();
  }

  const ownerUserId =
    input.ownerUserId === undefined
      ? actorId
      : parseRecordId(input.ownerUserId);

  const rawFields =
    input.customValues === undefined
      ? {}
      : input.customValues;

  if (
    !plain(rawFields) ||
    Object.keys(rawFields).length > 100
  ) {
    throw AppError.badRequest();
  }

  const values: Record<string, unknown> =
    Object.create(null) as Record<string, unknown>;

  for (const [key, rawValue] of Object.entries(rawFields)) {
    const validatedKey = parseCustomKey(key);

    values[validatedKey] = parseValueEdit({
      value: rawValue,
      expectedValue: null,
    }).value;
  }

  if (
    Buffer.byteLength(
      JSON.stringify(values),
      "utf8"
    ) > 65536
  ) {
    throw AppError.badRequest();
  }

  return Object.freeze({
    title: input.title.trim(),
    status,
    priority,
    sourceKey,
    description: description as string | null,
    ownerUserId,
    customValues: Object.freeze(values),
  });
}
