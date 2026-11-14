import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { AppError } from "../../../core/errors/AppError";
import type { TenantContext } from "../../../core/tenant/tenantContext";
import { parseCustomKey, sameJson, validateFieldValue, type ValueEdit } from "../schemas/lead_values.schema";

export type LeadValuesReadConnection = Pick<PoolConnection, "execute">;
export type LeadValuesWriteConnection = Pick<PoolConnection,
  "execute" | "beginTransaction" | "commit" | "rollback" | "release" | "destroy">;
interface LeadRow extends RowDataPacket {
  id: string | number | bigint;
  company_id: string | number | bigint;
  owner_user_id: string | number | bigint;
}
interface FieldRow extends RowDataPacket {
  id: string | number | bigint;
  company_id: string | number | bigint;
  field_key: string;
  label: string;
  field_type: string;
  required: number | boolean | string;
  settings_json: string | null;
}
interface ValueRow extends RowDataPacket {
  value_json: string | null;
}
interface OptionRow extends RowDataPacket {
  option_key: string;
}
interface AllValuesRow extends RowDataPacket {
  company_id: string | number | bigint;
  field_key: string;
  label: string;
  field_type: string;
  required: number | boolean | string;
  value_json: string | null;
}

const MAX_ID = 18446744073709551615n;
function id(value: unknown): string {
  if (typeof value === "bigint" && value > 0n && value <= MAX_ID) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= MAX_ID) return value;
  throw new Error("Invalid CRM database identifier");
}
function flag(value: unknown): boolean {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  throw new Error("Invalid CRM custom field flag");
}
function json(value: string | null): unknown {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Invalid encoded CRM JSON");
  try { return JSON.parse(value) as unknown; }
  catch { throw new Error("Invalid stored CRM JSON"); }
}
/** Company + record + ownership restrictions are included in every lead read and write. */
function scope(tenant: TenantContext): { sql: string; params: string[] } {
  if (tenant.role === "OWNER") return { sql: "", params: [] };
  if (tenant.role === "EMPLOYEE") {
    return { sql: "AND l.owner_user_id = ?", params: [tenant.actorUserId] };
  }
  return {
    sql: `AND (l.owner_user_id = ? OR EXISTS (
      SELECT 1 FROM team_members AS tm
      INNER JOIN teams AS t ON t.company_id = tm.company_id AND t.id = tm.team_id
      INNER JOIN users AS u ON u.company_id = tm.company_id AND u.id = tm.user_id
      WHERE tm.company_id = l.company_id AND tm.user_id = l.owner_user_id
        AND tm.left_at IS NULL AND tm.joined_at <= UTC_TIMESTAMP(3)
        AND t.manager_user_id = ? AND t.status = 'active'
        AND u.role = 'employee' AND u.status = 'active'
    ))`,
    params: [tenant.actorUserId, tenant.actorUserId]
  };
}
async function visibleLead(db: LeadValuesReadConnection, tenant: TenantContext,
  leadId: string, locked: boolean): Promise<void> {
  const visibility = scope(tenant);
  const [rows] = await db.execute<LeadRow[]>(
    `SELECT l.id, l.company_id, l.owner_user_id FROM leads AS l
     WHERE l.company_id = ? AND l.id = ? ${visibility.sql} LIMIT 1 ${locked ? "FOR UPDATE" : ""}`,
    [tenant.companyId, leadId, ...visibility.params]
  );
  const row = rows[0];
  if (!row) throw AppError.notFound();
  if (id(row.id) !== leadId || id(row.company_id) !== tenant.companyId) throw AppError.forbidden();
  if (tenant.role === "EMPLOYEE" && id(row.owner_user_id) !== tenant.actorUserId) throw AppError.forbidden();
}

/** Read only definitions/values for an authorized lead, including unset fields. */
export async function readLeadCustomValues(db: LeadValuesReadConnection,
  tenant: TenantContext, leadId: string) {
  await visibleLead(db, tenant, leadId, false);
  const [rows] = await db.execute<AllValuesRow[]>(
    `SELECT f.company_id, f.field_key, f.label, f.field_type, f.required,
            CAST(v.value_json AS CHAR) AS value_json
     FROM custom_fields AS f
     LEFT JOIN custom_field_values AS v ON v.company_id = f.company_id
       AND v.custom_field_id = f.id AND v.entity_type = 'leads' AND v.entity_id = ?
     WHERE f.company_id = ? AND f.entity_type = 'leads'
     ORDER BY f.field_key ASC LIMIT 1001`,
    [leadId, tenant.companyId]
  );
  if (!Array.isArray(rows) || rows.length > 1000) throw new Error("Lead custom field result limit exceeded");
  return Object.freeze(rows.map(row => {
    if (id(row.company_id) !== tenant.companyId) throw AppError.forbidden();
    return Object.freeze({ fieldKey: parseCustomKey(row.field_key), label: row.label,
      fieldType: row.field_type, required: flag(row.required), value: json(row.value_json) });
  }));
}

/** Caller starts a transaction. Locks lead and field before comparing expected value. */
export async function updateLeadCustomValue(db: LeadValuesWriteConnection, tenant: TenantContext,
  leadId: string, fieldKey: string, input: ValueEdit, requestId: string | null) {
  await visibleLead(db, tenant, leadId, true);
  const [definitions] = await db.execute<FieldRow[]>(
    `SELECT id, company_id, field_key, label, field_type, required,
            CAST(settings_json AS CHAR) AS settings_json
     FROM custom_fields WHERE company_id = ? AND entity_type = 'leads' AND field_key = ?
     LIMIT 1 FOR UPDATE`,
    [tenant.companyId, fieldKey]
  );
  const definition = definitions[0];
  if (!definition) throw AppError.notFound();
  if (id(definition.company_id) !== tenant.companyId || definition.field_key !== fieldKey) throw AppError.forbidden();
  validateFieldValue(input.value, {
    fieldType: definition.field_type, required: flag(definition.required),
    settings: json(definition.settings_json)
  });
  const fieldId = id(definition.id);
  const [values] = await db.execute<ValueRow[]>(
    `SELECT CAST(value_json AS CHAR) AS value_json
     FROM custom_field_values
     WHERE company_id = ? AND custom_field_id = ? AND entity_type = 'leads' AND entity_id = ?
     LIMIT 1 FOR UPDATE`,
    [tenant.companyId, fieldId, leadId]
  );
  const current = values.length > 0 ? json(values[0]!.value_json) : null;
  if (!sameJson(current, input.expectedValue)) throw AppError.conflict();
  const optionTypes = ["select", "dropdown", "radio", "multiselect"];
  if (optionTypes.includes(definition.field_type) && input.value !== null) {
    const choices: string[] = typeof input.value === "string" ? [input.value] : input.value as string[];
    if (choices.length > 0) {
      const [rows] = await db.execute<OptionRow[]>(
        `SELECT option_key FROM picklist_options
         WHERE company_id = ? AND entity_type = 'leads' AND field_key = ? AND is_active = 1
           AND option_key IN (${choices.map(() => "?").join(",")})`,
        [tenant.companyId, fieldKey, ...choices]
      );
      if (rows.length !== choices.length || rows.some(row => !choices.includes(row.option_key))) {
        throw AppError.badRequest();
      }
    }
  }
  const encoded = JSON.stringify(input.value);
  if (values.length > 0) {
    const [result] = await db.execute<ResultSetHeader>(
      `UPDATE custom_field_values SET value_json = ?
       WHERE company_id = ? AND custom_field_id = ? AND entity_type = 'leads' AND entity_id = ?`,
      [encoded, tenant.companyId, fieldId, leadId]
    );
    if (result.affectedRows !== 1) throw AppError.conflict();
  } else {
    await db.execute<ResultSetHeader>(
      `INSERT INTO custom_field_values
        (company_id, custom_field_id, entity_type, entity_id, value_json)
       VALUES (?, ?, 'leads', ?, ?)`,
      [tenant.companyId, fieldId, leadId, encoded]
    );
  }
  // Keep Lead updated_at meaningful when its dynamic fields change.
  await db.execute(
    `UPDATE leads SET updated_at = UTC_TIMESTAMP(3) WHERE company_id = ? AND id = ?`,
    [tenant.companyId, leadId]
  );
  // Audit the identity and changed field, not possibly sensitive business values.
  await db.execute(
    `INSERT INTO audit_logs
       (company_id, actor_user_id, action, entity_type, entity_id,
        outcome, request_id, details_json, occurred_at)
     VALUES (?, ?, 'lead.custom_field.updated', 'lead', ?, 'success', ?, ?, UTC_TIMESTAMP(3))`,
    [tenant.companyId, tenant.actorUserId, leadId, requestId,
      JSON.stringify({ fieldKey, customFieldId: fieldId })]
  );
  return Object.freeze({ leadId, fieldKey, value: input.value });
}