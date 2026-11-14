import { AppError } from "../../../core/errors/AppError";

export interface NewPicklistChoice {
  readonly entityType: string;
  readonly fieldKey: string;
  readonly optionKey: string;
  readonly label: string;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface PicklistChoiceState {
  readonly label: string;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface RevisedPicklistChoice extends PicklistChoiceState {
  readonly expected: PicklistChoiceState;
}

const MAX_ID = 18446744073709551615n;

function shape(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw AppError.badRequest();
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => !fields.includes(key))) {
    throw AppError.badRequest();
  }
  return object;
}

function key(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max || !/^[a-z][a-z0-9_]*$/.test(value)) {
    throw AppError.badRequest();
  }
  return value;
}

function label(value: unknown): string {
  if (typeof value !== "string") throw AppError.badRequest();
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > 180) throw AppError.badRequest();
  return cleaned;
}

function sortOrder(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647) {
    throw AppError.badRequest();
  }
  return value;
}

function active(value: unknown): boolean {
  if (typeof value !== "boolean") throw AppError.badRequest();
  return value;
}

function state(value: unknown): PicklistChoiceState {
  const object = shape(value, ["label", "sortOrder", "isActive"]);
  return Object.freeze({
    label: label(object.label),
    sortOrder: sortOrder(object.sortOrder),
    isActive: active(object.isActive),
  });
}

/** No fixed statuses, labels, sources, categories, or option keys. */
export function parseNewPicklistChoice(value: unknown): NewPicklistChoice {
  const object = shape(value, ["entityType", "fieldKey", "optionKey", "label", "sortOrder", "isActive"]);
  return Object.freeze({
    entityType: key(object.entityType, 40),
    fieldKey: key(object.fieldKey, 80),
    optionKey: key(object.optionKey, 80),
    label: label(object.label),
    sortOrder: object.sortOrder === undefined ? 0 : sortOrder(object.sortOrder),
    isActive: object.isActive === undefined ? true : active(object.isActive),
  });
}

/** Clients provide the state they actually read, enabling conflict detection. */
export function parseRevisedPicklistChoice(value: unknown): RevisedPicklistChoice {
  const object = shape(value, ["label", "sortOrder", "isActive", "expected"]);
  return Object.freeze({
    label: label(object.label),
    sortOrder: sortOrder(object.sortOrder),
    isActive: active(object.isActive),
    expected: state(object.expected),
  });
}

export function parsePicklistChoiceId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > MAX_ID) {
    throw AppError.badRequest();
  }
  return value;
}