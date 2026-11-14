import { AppError } from "../../../core/errors/AppError";

export interface ViewFilter {
  readonly field: string;
  readonly operator: "equals" | "not_equals" | "in" | "contains" | "gte" | "lte";
  readonly value?: string | number | boolean | null;
  readonly values?: readonly (string | number | boolean)[];
}
export interface ViewSort { readonly field: string; readonly direction: "asc" | "desc"; }
export interface ExecutableViewConfig {
  readonly columns: readonly string[];
  readonly filters: readonly ViewFilter[];
  readonly sorting: readonly ViewSort[];
}
export interface ViewQueryOptions { readonly limit: number; readonly offset: number; }

export const LEAD_BASE_COLUMNS = Object.freeze({
  id: "l.id", title: "l.title", status: "l.status", priority: "l.priority",
  source_key: "l.source_key", contact_id: "l.contact_id", account_id: "l.account_id",
  owner_user_id: "l.owner_user_id", created_by_user_id: "l.created_by_user_id",
  assigned_at: "l.assigned_at", next_followup_at: "l.next_followup_at",
  description: "l.description", created_at: "l.created_at", updated_at: "l.updated_at",
} as const);

function bad(): never { throw AppError.badRequest(); }
function key(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 90 || !/^[a-z][a-z0-9_]*$/.test(raw)) bad();
  return raw as string;
}
function record(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) bad();
  return raw as Record<string, unknown>;
}
function scalar(raw: unknown): raw is string | number | boolean | null {
  return raw === null || typeof raw === "string" && raw.length <= 500 ||
    typeof raw === "number" && Number.isFinite(raw) || typeof raw === "boolean";
}
function keys(raw: unknown, max: number): readonly string[] {
  if (!Array.isArray(raw) || raw.length > max) bad();
  const list = raw.map(key);
  if (new Set(list).size !== list.length) bad();
  return Object.freeze(list);
}
function filter(raw: unknown): ViewFilter {
  const item = record(raw);
  if (Object.keys(item).some(k => !["field", "operator", "value", "values"].includes(k))) bad();
  const field = key(item.field);
  const op = item.operator;
  if (!["equals", "not_equals", "in", "contains", "gte", "lte"].includes(String(op))) bad();
  if (op === "in") {
    const values = item.values;
    if (!Array.isArray(values) || values.length < 1 || values.length > 30 ||
        values.some(x => x === null || !scalar(x)) || Object.hasOwn(item, "value")) bad();
    return Object.freeze({ field, operator: "in", values: Object.freeze([...values]) });
  }
  if (!Object.hasOwn(item, "value") || !scalar(item.value) || Object.hasOwn(item, "values")) bad();
  if ((op === "contains" || op === "gte" || op === "lte") && item.value === null) bad();
  return Object.freeze({ field, operator: op as ViewFilter["operator"], value: item.value as ViewFilter["value"] });
}
function sort(raw: unknown): ViewSort {
  const item = record(raw);
  if (Object.keys(item).some(k => !["field", "direction"].includes(k))) bad();
  if (item.direction !== "asc" && item.direction !== "desc") bad();
  return Object.freeze({ field: key(item.field), direction: item.direction });
}
/** A saved view is inert configuration until this restricted grammar accepts it. */
export function parseExecutableView(raw: unknown): ExecutableViewConfig {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { bad(); }
  }
  const data = record(value);
  const columns = data.columns === undefined ? Object.freeze(["title"]) : keys(data.columns, 25);
  if (columns.length === 0) bad();
  if (data.filters !== undefined && (!Array.isArray(data.filters) || data.filters.length > 12)) bad();
  if (data.sorting !== undefined && (!Array.isArray(data.sorting) || data.sorting.length > 3)) bad();
  const filters = Object.freeze((data.filters as unknown[] | undefined ?? []).map(filter));
  const sorting = Object.freeze((data.sorting as unknown[] | undefined ?? []).map(sort));
  const seenSort = new Set<string>();
  for (const item of sorting) { if (seenSort.has(item.field)) bad(); seenSort.add(item.field); }
  return Object.freeze({ columns, filters, sorting });
}
export function parseViewId(raw: unknown): string {
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,19}$/.test(raw) ||
      BigInt(raw) > 18446744073709551615n) bad();
  return raw as string;
}
export function parseViewQuery(raw: string): ViewQueryOptions {
  const url = new URL(raw, "http://localhost");
  const permitted = new Set(["limit", "offset"]);
  const values = new Map<string, string>();
  for (const [k, v] of url.searchParams) {
    if (!permitted.has(k) || values.has(k)) bad();
    values.set(k, v);
  }
  const limitRaw = values.get("limit") ?? "25";
  const offsetRaw = values.get("offset") ?? "0";
  if (!/^[1-9][0-9]{0,2}$/.test(limitRaw) || !/^(0|[1-9][0-9]{0,5})$/.test(offsetRaw)) bad();
  const limit = Number(limitRaw);
  const offset = Number(offsetRaw);
  if (limit > 100 || offset > 10000) bad();
  return Object.freeze({ limit, offset });
}