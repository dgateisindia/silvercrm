import { AppError } from "../../../core/errors/AppError";

export type LayoutScope = "personal" | "company";
export interface CompanyPageInput {
  readonly expectedVersion: number;
  readonly configJson: string;
}
export interface PersonalPageInput {
  readonly configJson: string;
}
export interface DashboardInput {
  readonly name: string;
  readonly scope: LayoutScope;
  readonly layoutJson: string;
}
export interface DashboardRevision {
  readonly name: string;
  readonly layoutJson: string;
  readonly expectedName: string;
  readonly expectedLayoutJson: string;
}

function objectOf(value: unknown, permitted: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw AppError.badRequest();
  }
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some(k => !permitted.includes(k))) {
    throw AppError.badRequest();
  }
  return obj;
}

export function parsePageKey(value: unknown): string {
  if (typeof value !== "string" || value.length > 80 || !/^[a-z][a-z0-9_.-]*$/.test(value)) {
    throw AppError.badRequest();
  }
  return value;
}

export function parseDashboardId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > 18446744073709551615n) {
    throw AppError.badRequest();
  }
  return value;
}

function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value >= 4294967295) {
    throw AppError.badRequest();
  }
  return value;
}

function name(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 100) {
    throw AppError.badRequest();
  }
  return value.trim();
}

/** Accepts customer-defined layout objects, not fixed widgets/sections. No code can be stored as executable values. */
export function layoutJson(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw AppError.badRequest();
  }
  const seen = new WeakSet<object>();
  let nodes = 0;
  function check(current: unknown, depth: number): void {
    nodes++;
    if (nodes > 1500 || depth > 12) throw AppError.badRequest();
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw AppError.badRequest();
      return;
    }
    if (typeof current === "string") {
      if (current.length > 4096) throw AppError.badRequest();
      return;
    }
    if (typeof current !== "object" || seen.has(current)) throw AppError.badRequest();
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.length > 300) throw AppError.badRequest();
      for (const child of current) check(child, depth + 1);
      return;
    }
    const proto = Object.getPrototypeOf(current);
    if (proto !== Object.prototype && proto !== null) throw AppError.badRequest();
    for (const [key, child] of Object.entries(current)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype" || key.length > 120) {
        throw AppError.badRequest();
      }
      check(child, depth + 1);
    }
  }
  check(value, 0);
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw AppError.badRequest(); }
  if (Buffer.byteLength(serialized, "utf8") > 32768) throw AppError.badRequest();
  return serialized;
}

export function parseCompanyPageInput(value: unknown): CompanyPageInput {
  const obj = objectOf(value, ["expectedVersion", "config"]);
  return Object.freeze({ expectedVersion: version(obj.expectedVersion), configJson: layoutJson(obj.config) });
}

export function parsePersonalPageInput(value: unknown): PersonalPageInput {
  const obj = objectOf(value, ["config"]);
  return Object.freeze({ configJson: layoutJson(obj.config) });
}

export function parseDashboardInput(value: unknown): DashboardInput {
  const obj = objectOf(value, ["name", "scope", "layout"]);
  if (obj.scope !== "personal" && obj.scope !== "company") throw AppError.badRequest();
  return Object.freeze({ name: name(obj.name), scope: obj.scope, layoutJson: layoutJson(obj.layout) });
}

export function parseDashboardRevision(value: unknown): DashboardRevision {
  const obj = objectOf(value, ["name", "layout", "expectedName", "expectedLayout"]);
  return Object.freeze({
    name: name(obj.name), layoutJson: layoutJson(obj.layout),
    expectedName: name(obj.expectedName), expectedLayoutJson: layoutJson(obj.expectedLayout),
  });
}
/** Manager-editable Lead form presentation. Does not alter protected DB columns. */
export function validateLeadFormPresentation(configJson: string): void {
  const root = JSON.parse(configJson) as unknown;
  const config = objectOf(root, ["schemaVersion", "order", "hidden", "labels"]);
  if (config.schemaVersion !== 1 || !Array.isArray(config.order) || !Array.isArray(config.hidden)) {
    throw AppError.badRequest();
  }
  if (config.order.length > 200 || config.hidden.length > 200) throw AppError.badRequest();
  const valid = (key: unknown): key is string =>
    typeof key === "string" && key.length <= 90 && /^[a-z][a-z0-9_]*$/.test(key);
  if (!config.order.every(valid) || !config.hidden.every(valid)) throw AppError.badRequest();
  if (new Set(config.order).size !== config.order.length || new Set(config.hidden).size !== config.hidden.length) {
    throw AppError.badRequest();
  }
  if (config.hidden.some(key => key === "title" || key === "status" || key === "priority" || key === "owner_user_id")) {
    throw AppError.badRequest();
  }
  const labels = objectOf(config.labels, ["title", "status", "priority", "source_key", "description"]);
  for (const value of Object.values(labels)) {
    if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 100) throw AppError.badRequest();
  }
}
