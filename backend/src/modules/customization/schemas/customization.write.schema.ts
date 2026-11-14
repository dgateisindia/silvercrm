import { AppError } from "../../../core/errors/AppError";

export interface NewCustomField {
  readonly entityType: string;
  readonly fieldKey: string;
  readonly label: string;
  readonly fieldType: string;
  readonly required: boolean;
  readonly settingsJson: string | null;
}

export interface RevisedCustomField {
  readonly label: string;
  readonly required: boolean;
  readonly settingsJson: string | null;
  readonly expectedVersion: number;
}

const MAX_ID = 18446744073709551615n;

const PROTECTED_FIELD_KEYS = new Set([
  "id",
  "company_id",
  "created_at",
  "updated_at",
  "created_by_user_id",
  "owner_user_id",
  "contact_id",
  "account_id",
  "assigned_at",
  "next_followup_at",
  "title",
  "status",
  "priority",
  "source_key",
  "description",
]);

function objectInput(
  value: unknown,
  allowed: readonly string[]
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw AppError.badRequest();
  }

  const object = value as Record<string, unknown>;

  if (
    Object.keys(object).some(
      key => !allowed.includes(key)
    )
  ) {
    throw AppError.badRequest();
  }

  return object;
}

function key(
  value: unknown,
  maximum: number
): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    !/^[a-z][a-z0-9_]*$/.test(value)
  ) {
    throw AppError.badRequest();
  }

  return value;
}

function label(value: unknown): string {
  if (typeof value !== "string") {
    throw AppError.badRequest();
  }

  const result = value.trim();

  if (
    result.length < 1 ||
    result.length > 160
  ) {
    throw AppError.badRequest();
  }

  return result;
}

function settingsToJson(
  value: unknown
): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw AppError.badRequest();
  }

  const visited = new WeakSet<object>();
  let count = 0;

  function inspect(
    item: unknown,
    depth: number
  ): void {
    count++;

    if (count > 500 || depth > 8) {
      throw AppError.badRequest();
    }

    if (
      item === null ||
      typeof item === "boolean"
    ) {
      return;
    }

    if (typeof item === "string") {
      if (item.length > 4096) {
        throw AppError.badRequest();
      }

      return;
    }

    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        throw AppError.badRequest();
      }

      return;
    }

    if (
      typeof item !== "object" ||
      visited.has(item)
    ) {
      throw AppError.badRequest();
    }

    visited.add(item);

    if (Array.isArray(item)) {
      if (item.length > 200) {
        throw AppError.badRequest();
      }

      for (const child of item) {
        inspect(child, depth + 1);
      }

      return;
    }

    const prototype = Object.getPrototypeOf(item);

    if (
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw AppError.badRequest();
    }

    for (
      const [property, child]
      of Object.entries(item)
    ) {
      if (
        property === "__proto__" ||
        property === "constructor" ||
        property === "prototype"
      ) {
        throw AppError.badRequest();
      }

      inspect(child, depth + 1);
    }
  }

  inspect(value, 0);

  let json: string;

  try {
    json = JSON.stringify(value);
  } catch {
    throw AppError.badRequest();
  }

  if (
    Buffer.byteLength(json, "utf8") > 16384
  ) {
    throw AppError.badRequest();
  }

  return json;
}

/**
 * Customer-defined business fields.
 *
 * The application does not impose fixed
 * customer field names, statuses or labels.
 *
 * Protected system columns remain separate
 * from customer-created custom fields.
 */
export function parseNewCustomField(
  input: unknown
): NewCustomField {
  const data = objectInput(
    input,
    [
      "entityType",
      "fieldKey",
      "label",
      "fieldType",
      "required",
      "settings",
    ]
  );

  const entityType = key(
    data.entityType,
    40
  );

  const fieldKey = key(
    data.fieldKey,
    90
  );

  const fieldType = key(
    data.fieldType,
    30
  );

  if (PROTECTED_FIELD_KEYS.has(fieldKey)) {
    throw AppError.badRequest();
  }

  if (typeof data.required !== "boolean") {
    throw AppError.badRequest();
  }

  return Object.freeze({
    entityType,
    fieldKey,
    label: label(data.label),
    fieldType,
    required: data.required,
    settingsJson: settingsToJson(
      data.settings
    ),
  });
}

/**
 * Existing field keys and types cannot
 * be silently changed because records may
 * already contain values for those fields.
 *
 * Type migration is a separate workflow.
 */
export function parseRevisedCustomField(
  input: unknown
): RevisedCustomField {
  const data = objectInput(
    input,
    [
      "label",
      "required",
      "settings",
      "expectedVersion",
    ]
  );

  if (typeof data.required !== "boolean") {
    throw AppError.badRequest();
  }

  if (
    typeof data.expectedVersion !== "number" ||
    !Number.isSafeInteger(data.expectedVersion) ||
    data.expectedVersion < 0 ||
    data.expectedVersion >= 4294967295
  ) {
    throw AppError.badRequest();
  }

  return Object.freeze({
    label: label(data.label),
    required: data.required,
    settingsJson: settingsToJson(
      data.settings
    ),
    expectedVersion: data.expectedVersion,
  });
}

export function parseFieldId(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value) ||
    BigInt(value) > MAX_ID
  ) {
    throw AppError.badRequest();
  }

  return value;
}