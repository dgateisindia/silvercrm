import { AppError } from "../../../core/errors/AppError";

export interface LeadCore {
  readonly title: string;
  readonly status: string;
  readonly priority: string;
  readonly sourceKey: string | null;
  readonly description: string | null;
}

export interface LeadEditInput {
  readonly expectedRevision: string;
  readonly changes: Partial<LeadCore>;
}

export function leadRecordId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  ) {
    throw AppError.badRequest();
  }

  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(
      Object.getPrototypeOf(value)
    )
  ) {
    throw AppError.badRequest();
  }

  return value as Record<string, unknown>;
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

export function parseLeadEdit(input: unknown): LeadEditInput {
  const request = object(input);

  if (
    Object.keys(request).some(
      key => !["expectedRevision", "changes"].includes(key)
    )
  ) {
    throw AppError.badRequest();
  }

  if (
    typeof request.expectedRevision !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/.test(
      request.expectedRevision
    )
  ) {
    throw AppError.badRequest();
  }

  const changes = object(request.changes);
  const names = Object.keys(changes);

  if (
    names.length === 0 ||
    names.some(
      key => ![
        "title",
        "status",
        "priority",
        "sourceKey",
        "description",
      ].includes(key)
    )
  ) {
    throw AppError.badRequest();
  }

  const parsed: {
    -readonly [K in keyof LeadCore]?: LeadCore[K]
  } = {};

  if (Object.hasOwn(changes, "title")) {
    if (
      typeof changes.title !== "string" ||
      !changes.title.trim() ||
      changes.title.trim().length > 200
    ) {
      throw AppError.badRequest();
    }

    parsed.title = changes.title.trim();
  }

  if (Object.hasOwn(changes, "status")) {
    parsed.status = choice(changes.status, 40);
  }

  if (Object.hasOwn(changes, "priority")) {
    parsed.priority = choice(changes.priority, 20);
  }

  if (Object.hasOwn(changes, "sourceKey")) {
    parsed.sourceKey =
      changes.sourceKey === null
        ? null
        : choice(changes.sourceKey, 60);
  }

  if (Object.hasOwn(changes, "description")) {
    if (
      changes.description !== null &&
      (
        typeof changes.description !== "string" ||
        changes.description.length > 10000
      )
    ) {
      throw AppError.badRequest();
    }

    parsed.description =
      changes.description as string | null;
  }

  return Object.freeze({
    expectedRevision: request.expectedRevision,
    changes: Object.freeze(parsed),
  });
}