import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import { AppError } from "../../../core/errors/AppError";

import type {
  TenantContext,
} from "../../../core/tenant/tenantContext";

import {
  validateFieldValue,
} from "../../customization/schemas/lead_values.schema";

import type {
  NewLeadInput,
} from "../schemas/lead_create.schema";

export type LeadCreateConnection = Pick<
  PoolConnection,
  | "execute"
  | "beginTransaction"
  | "commit"
  | "rollback"
  | "release"
  | "destroy"
>;

interface UserRow extends RowDataPacket {
  id: string | number | bigint;
  company_id: string | number | bigint;
  role: string;
  status: string;
}

interface FieldRow extends RowDataPacket {
  id: string | number | bigint;
  company_id: string | number | bigint;
  field_key: string;
  field_type: string;
  required: number | boolean | string;
  settings_json: string | null;
}

interface OptionRow extends RowDataPacket {
  option_key: string;
}

interface TeamRow extends RowDataPacket {
  id: string | number | bigint;
}

const MAX_ID = 18446744073709551615n;

function id(value: unknown): string {
  if (
    typeof value === "string" &&
    /^[1-9][0-9]{0,19}$/.test(value) &&
    BigInt(value) <= MAX_ID
  ) {
    return value;
  }

  if (
    typeof value === "bigint" &&
    value > 0n &&
    value <= MAX_ID
  ) {
    return value.toString();
  }

  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  ) {
    return String(value);
  }

  throw new Error("Invalid CRM database identifier");
}

function flag(value: unknown): boolean {
  if (
    value === true ||
    value === 1 ||
    value === "1"
  ) {
    return true;
  }

  if (
    value === false ||
    value === 0 ||
    value === "0"
  ) {
    return false;
  }

  throw new Error("Invalid CRM required flag");
}

async function activeChoice(
  db: LeadCreateConnection,
  tenant: TenantContext,
  field: string,
  option: string
): Promise<void> {
  const [rows] = await db.execute<OptionRow[]>(
    `
      SELECT option_key
      FROM picklist_options
      WHERE company_id = ?
        AND entity_type = 'leads'
        AND field_key = ?
        AND option_key = ?
        AND is_active = 1
      LIMIT 1
      FOR UPDATE
    `,
    [
      tenant.companyId,
      field,
      option,
    ]
  );

  if (
    rows.length !== 1 ||
    rows[0]?.option_key !== option
  ) {
    throw AppError.badRequest();
  }
}

async function verifyOwner(
  db: LeadCreateConnection,
  tenant: TenantContext,
  ownerId: string
): Promise<void> {
  if (
    tenant.role === "EMPLOYEE" &&
    ownerId !== tenant.actorUserId
  ) {
    throw AppError.forbidden();
  }

  const [users] = await db.execute<UserRow[]>(
    `
      SELECT id, company_id, role, status
      FROM users
      WHERE company_id = ?
        AND id = ?
      LIMIT 1
      FOR UPDATE
    `,
    [
      tenant.companyId,
      ownerId,
    ]
  );

  const user = users[0];

  if (
    !user ||
    id(user.company_id) !== tenant.companyId ||
    id(user.id) !== ownerId ||
    user.status !== "active"
  ) {
    throw AppError.forbidden();
  }

  if (ownerId === tenant.actorUserId) {
    if (
      (
        tenant.role === "MANAGER" &&
        user.role !== "manager"
      ) ||
      (
        tenant.role === "EMPLOYEE" &&
        user.role !== "employee"
      )
    ) {
      throw AppError.forbidden();
    }

    return;
  }

  if (
    tenant.role !== "MANAGER" ||
    user.role !== "employee"
  ) {
    throw AppError.forbidden();
  }

  const [team] = await db.execute<TeamRow[]>(
    `
      SELECT tm.id
      FROM team_members AS tm

      INNER JOIN teams AS t
        ON t.id = tm.team_id
        AND t.company_id = tm.company_id

      WHERE tm.company_id = ?
        AND tm.user_id = ?
        AND tm.left_at IS NULL
        AND tm.joined_at <= UTC_TIMESTAMP(3)
        AND t.manager_user_id = ?
        AND t.status = 'active'

      LIMIT 1
      FOR UPDATE
    `,
    [
      tenant.companyId,
      ownerId,
      tenant.actorUserId,
    ]
  );

  if (team.length !== 1) {
    throw AppError.forbidden();
  }
}

/**
 * Runs inside a service-owned transaction.
 *
 * Lead, custom field values, and audit event
 * must all succeed or all roll back.
 */
export async function insertLeadWithCustomValues(
  db: LeadCreateConnection,
  tenant: TenantContext,
  input: NewLeadInput,
  requestId: string | null
) {
  await verifyOwner(
    db,
    tenant,
    input.ownerUserId
  );

  await activeChoice(
    db,
    tenant,
    "status",
    input.status
  );

  await activeChoice(
    db,
    tenant,
    "priority",
    input.priority
  );

  if (input.sourceKey !== null) {
    await activeChoice(
      db,
      tenant,
      "source_key",
      input.sourceKey
    );
  }

  const [fields] = await db.execute<FieldRow[]>(
    `
      SELECT
        id,
        company_id,
        field_key,
        field_type,
        required,
        CAST(settings_json AS CHAR) AS settings_json

      FROM custom_fields

      WHERE company_id = ?
        AND entity_type = 'leads'

      ORDER BY id ASC
      LIMIT 1001
      FOR UPDATE
    `,
    [tenant.companyId]
  );

  if (fields.length > 1000) {
    throw AppError.badRequest();
  }

  const definitions = new Map<
    string,
    FieldRow
  >();

  for (const field of fields) {
    if (
      id(field.company_id) !== tenant.companyId ||
      definitions.has(field.field_key)
    ) {
      throw AppError.forbidden();
    }

    definitions.set(
      field.field_key,
      field
    );

    if (
      flag(field.required) &&
      (
        input.customValues[field.field_key] === undefined ||
        input.customValues[field.field_key] === null
      )
    ) {
      throw AppError.badRequest();
    }
  }

  for (
    const [key, value]
    of Object.entries(input.customValues)
  ) {
    const field = definitions.get(key);

    if (!field) {
      throw AppError.badRequest();
    }

    let settings: unknown = null;

    if (field.settings_json !== null) {
      try {
        settings = JSON.parse(
          field.settings_json
        );
      } catch {
        throw new Error(
          "Invalid stored custom field JSON"
        );
      }
    }

    validateFieldValue(value, {
      fieldType: field.field_type,
      required: flag(field.required),
      settings,
    });

    if (
      [
        "select",
        "dropdown",
        "radio",
        "multiselect",
      ].includes(field.field_type) &&
      value !== null
    ) {
      const options =
        typeof value === "string"
          ? [value]
          : value as string[];

      for (const option of options) {
        await activeChoice(
          db,
          tenant,
          key,
          option
        );
      }
    }
  }

  const [result] =
    await db.execute<ResultSetHeader>(
      `
        INSERT INTO leads (
          company_id,
          title,
          status,
          priority,
          source_key,
          description,
          created_by_user_id,
          owner_user_id,
          assigned_at
        )
        VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?,
          UTC_TIMESTAMP(3)
        )
      `,
      [
        tenant.companyId,
        input.title,
        input.status,
        input.priority,
        input.sourceKey,
        input.description,
        tenant.actorUserId,
        input.ownerUserId,
      ]
    );

  const leadId = id(result.insertId);

  for (
    const [key, value]
    of Object.entries(input.customValues)
  ) {
    if (value === null) {
      continue;
    }

    const field = definitions.get(key);

    if (!field) {
      throw new Error(
        "Missing validated field"
      );
    }

    await db.execute(
      `
        INSERT INTO custom_field_values (
          company_id,
          custom_field_id,
          entity_type,
          entity_id,
          value_json
        )
        VALUES (?, ?, 'leads', ?, ?)
      `,
      [
        tenant.companyId,
        id(field.id),
        leadId,
        JSON.stringify(value),
      ]
    );
  }

  await db.execute(
    `
      INSERT INTO audit_logs (
        company_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        outcome,
        request_id,
        details_json,
        occurred_at
      )
      VALUES (
        ?, ?,
        'lead.created',
        'lead',
        ?,
        'success',
        ?, ?,
        UTC_TIMESTAMP(3)
      )
    `,
    [
      tenant.companyId,
      tenant.actorUserId,
      leadId,
      requestId,
      JSON.stringify({
        ownerUserId: input.ownerUserId,
        customFieldKeys:
          Object.keys(input.customValues).sort(),
      }),
    ]
  );

  return Object.freeze({
    id: leadId,
    ownerUserId: input.ownerUserId,
  });
}
