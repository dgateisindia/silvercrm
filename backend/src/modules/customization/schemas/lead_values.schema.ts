import { AppError } from "../../../core/errors/AppError";

const MAX_ID = 18446744073709551615n;
export interface ValueEdit { readonly value: unknown; readonly expectedValue: unknown; }
export interface FieldDefinitionForValidation {
  readonly fieldType: string;
  readonly required: boolean;
  readonly settings: unknown;
}

export function parseRecordId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > MAX_ID) {
    throw AppError.badRequest();
  }
  return value;
}
export function parseCustomKey(value: unknown): string {
  if (typeof value !== "string" || value.length > 90 || !/^[a-z][a-z0-9_]*$/.test(value)) {
    throw AppError.badRequest();
  }
  return value;
}
/** JSON-only input, bounded to avoid surprising functions, cycles and oversized values. */
function safeJson(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let nodes = 0;
  function walk(node: unknown, depth: number): void {
    if (++nodes > 500 || depth > 8) throw AppError.badRequest();
    if (node === null || typeof node === "boolean") return;
    if (typeof node === "string") { if (node.length > 4096) throw AppError.badRequest(); return; }
    if (typeof node === "number") { if (!Number.isFinite(node)) throw AppError.badRequest(); return; }
    if (typeof node !== "object" || seen.has(node)) throw AppError.badRequest();
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.length > 50) throw AppError.badRequest();
      node.forEach(child => walk(child, depth + 1));
      return;
    }
    const prototype = Object.getPrototypeOf(node);
    if (prototype !== Object.prototype && prototype !== null) throw AppError.badRequest();
    for (const [key, child] of Object.entries(node)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw AppError.badRequest();
      walk(child, depth + 1);
    }
  }
  walk(value, 0);
  const text = JSON.stringify(value);
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 8192) throw AppError.badRequest();
  return JSON.parse(text) as unknown;
}
export function parseValueEdit(value: unknown): ValueEdit {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw AppError.badRequest();
  const input = value as Record<string, unknown>;
  if (!Object.hasOwn(input, "value") || !Object.hasOwn(input, "expectedValue") ||
      Object.keys(input).some(key => key !== "value" && key !== "expectedValue")) {
    throw AppError.badRequest();
  }
  return Object.freeze({ value: safeJson(input.value), expectedValue: safeJson(input.expectedValue) });
}
function exactDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}
/** Technical input primitives; never hardcodes business field names, labels or choices. */
export function validateFieldValue(value: unknown, definition: FieldDefinitionForValidation): void {
  if (value === null) {
    if (definition.required) throw AppError.badRequest();
    return;
  }
  const type = definition.fieldType;
  const settings = definition.settings;
  const config = settings !== null && typeof settings === "object" && !Array.isArray(settings)
    ? settings as Record<string, unknown> : {};
  const textTypes = ["text", "textarea", "email", "phone", "url"];
  const selectTypes = ["select", "dropdown", "radio"];
  if (textTypes.includes(type) || selectTypes.includes(type)) {
    if (typeof value !== "string" || value.length > 4096) throw AppError.badRequest();
    if (definition.required && value.trim().length === 0) throw AppError.badRequest();
    if (typeof config.maxLength === "number" && Number.isSafeInteger(config.maxLength) &&
        config.maxLength >= 0 && value.length > config.maxLength) throw AppError.badRequest();
    if (typeof config.minLength === "number" && Number.isSafeInteger(config.minLength) &&
        config.minLength >= 0 && value.length < config.minLength) throw AppError.badRequest();
    if (selectTypes.includes(type) && !/^[a-z][a-z0-9_]*$/.test(value)) throw AppError.badRequest();
    return;
  }
  if (type === "multiselect") {
    if (!Array.isArray(value) || value.length > 50 || (definition.required && !value.length) ||
        new Set(value).size !== value.length ||
        value.some(item => typeof item !== "string" || !/^[a-z][a-z0-9_]*$/.test(item))) {
      throw AppError.badRequest();
    }
    return;
  }
  if (["number", "integer", "decimal", "currency"].includes(type)) {
    if (typeof value !== "number" || !Number.isFinite(value) ||
        (type === "integer" && !Number.isSafeInteger(value))) throw AppError.badRequest();
    if (typeof config.min === "number" && value < config.min) throw AppError.badRequest();
    if (typeof config.max === "number" && value > config.max) throw AppError.badRequest();
    return;
  }
  if (type === "boolean" || type === "checkbox") {
    if (typeof value !== "boolean") throw AppError.badRequest();
    return;
  }
  if (type === "date") {
    if (typeof value !== "string" || !exactDate(value)) throw AppError.badRequest();
    return;
  }
  if (type === "datetime") {
    if (typeof value !== "string" || value.length > 40 ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
        !Number.isFinite(Date.parse(value))) throw AppError.badRequest();
    return;
  }
  // A new UI field type needs an explicit validated write handler.
  throw AppError.badRequest();
}
/** JSON canonicalization ensures key-order differences aren't false conflicts. */
export function sameJson(left: unknown, right: unknown): boolean {
  function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }
  return canonical(left) === canonical(right);
}