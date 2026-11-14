import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import { AppError } from "../../../core/errors/AppError";

import type {
  TenantContext,
} from "../../../core/tenant/tenantContext";

import type {
  NewCustomField,
  RevisedCustomField,
} from "../schemas/customization.write.schema";

export type FieldWriteConnection = Pick<
  PoolConnection,
  | "execute"
  | "beginTransaction"
  | "commit"
  | "rollback"
  | "release"
  | "destroy"
>;

interface ExistingFieldRow extends RowDataPacket {
  id: string | number | bigint;
  company_id: string | number | bigint;
  entity_type: string;
  field_key: string;
  field_type: string;
}

interface VersionRow extends RowDataPacket {
  version_no: number;
}

export interface SavedCustomField {
  readonly id: string;
  readonly version: number;
}

function safeId(
  value: unknown
): string {
  if (
    typeof value === "bigint" &&
    value > 0n
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

  if (
    typeof value === "string" &&
    /^[1-9][0-9]*$/.test(value)
  ) {
    return value;
  }

  throw new Error(
    "Invalid CRM database identifier"
  );
}

function definitionJson(
  data: NewCustomField
): string {
  return JSON.stringify({
    entityType: data.entityType,
    fieldKey: data.fieldKey,
    label: data.label,
    fieldType: data.fieldType,
    required: data.required,
    settings: data.settingsJson === null
      ? null
      : JSON.parse(data.settingsJson),
  });
}

async function insertHistory(
  connection: FieldWriteConnection,
  tenant: TenantContext,
  id: string,
  version: number,
  definition: NewCustomField
): Promise<void> {
  await connection.execute(
    `
      INSERT INTO custom_field_versions (
        company_id,
        custom_field_id,
        version_no,
        definition_json,
        changed_by_id
      )
      VALUES (?, ?, ?, ?, ?)
    `,
    [
      tenant.companyId,
      id,
      version,
      definitionJson(definition),
      tenant.actorUserId,
    ]
  );
}

async function insertAudit(
  connection: FieldWriteConnection,
  tenant: TenantContext,
  id: string,
  action: string,
  version: number,
  definition: NewCustomField,
  requestId: string | null
): Promise<void> {
  await connection.execute(
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
        ?, ?, ?, ?, ?, ?, ?, ?,
        UTC_TIMESTAMP(3)
      )
    `,
    [
      tenant.companyId,
      tenant.actorUserId,
      action,
      "custom_field",
      id,
      "success",
      requestId,
      JSON.stringify({
        entityType: definition.entityType,
        fieldKey: definition.fieldKey,
        version,
      }),
    ]
  );
}

/**
 * These methods must execute inside an
 * already-started database transaction.
 *
 * Definition, history and audit writes
 * belong to the same transaction.
 */
export function createCustomFieldWriteRepository(
  connection: FieldWriteConnection
) {
  async function create(
    tenant: TenantContext,
    definition: NewCustomField,
    requestId: string | null
  ): Promise<SavedCustomField> {
    const [result] =
      await connection.execute<ResultSetHeader>(
        `
          INSERT INTO custom_fields (
            company_id,
            entity_type,
            field_key,
            label,
            field_type,
            required,
            settings_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          tenant.companyId,
          definition.entityType,
          definition.fieldKey,
          definition.label,
          definition.fieldType,
          definition.required ? 1 : 0,
          definition.settingsJson,
        ]
      );

    const id = safeId(result.insertId);

    await insertHistory(
      connection,
      tenant,
      id,
      1,
      definition
    );

    await insertAudit(
      connection,
      tenant,
      id,
      "custom_field.created",
      1,
      definition,
      requestId
    );

    return Object.freeze({
      id,
      version: 1,
    });
  }

  async function revise(
    tenant: TenantContext,
    id: string,
    revision: RevisedCustomField,
    requestId: string | null
  ): Promise<SavedCustomField> {
    const [existingRows] =
      await connection.execute<ExistingFieldRow[]>(
        `
          SELECT
            id,
            company_id,
            entity_type,
            field_key,
            field_type
          FROM custom_fields
          WHERE company_id = ?
            AND id = ?
          FOR UPDATE
        `,
        [tenant.companyId, id]
      );

    const existing = existingRows[0];

    if (!existing) {
      throw AppError.notFound();
    }

    if (
      safeId(existing.company_id) !==
        tenant.companyId ||
      safeId(existing.id) !== id
    ) {
      throw AppError.forbidden();
    }

    const [versionRows] =
      await connection.execute<VersionRow[]>(
        `
          SELECT
            COALESCE(MAX(version_no), 0)
              AS version_no
          FROM custom_field_versions
          WHERE company_id = ?
            AND custom_field_id = ?
        `,
        [tenant.companyId, id]
      );

    const currentVersion =
      Number(versionRows[0]?.version_no);

    if (
      !Number.isSafeInteger(currentVersion) ||
      currentVersion < 0
    ) {
      throw new Error(
        "Invalid custom field history"
      );
    }

    if (
      currentVersion !==
      revision.expectedVersion
    ) {
      throw AppError.conflict();
    }

    const nextVersion = currentVersion + 1;

    const definition: NewCustomField = {
      entityType: existing.entity_type,
      fieldKey: existing.field_key,
      fieldType: existing.field_type,
      label: revision.label,
      required: revision.required,
      settingsJson: revision.settingsJson,
    };

    await connection.execute(
      `
        UPDATE custom_fields
        SET
          label = ?,
          required = ?,
          settings_json = ?
        WHERE company_id = ?
          AND id = ?
      `,
      [
        revision.label,
        revision.required ? 1 : 0,
        revision.settingsJson,
        tenant.companyId,
        id,
      ]
    );

    await insertHistory(
      connection,
      tenant,
      id,
      nextVersion,
      definition
    );

    await insertAudit(
      connection,
      tenant,
      id,
      "custom_field.updated",
      nextVersion,
      definition,
      requestId
    );

    return Object.freeze({
      id,
      version: nextVersion,
    });
  }

  return Object.freeze({
    create,
    revise,
  });
}