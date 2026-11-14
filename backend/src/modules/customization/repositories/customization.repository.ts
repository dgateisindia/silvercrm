import type { Response } from "express";

import type {
  PoolConnection,
  RowDataPacket,
} from "mysql2/promise";

import {
  getDbPool,
} from "../../../core/database/pool";

import {
  getTenantContext,
} from "../../../core/tenant/tenantContext";

export type CustomizationQueryConnection =
  Pick<PoolConnection, "execute">;

interface CustomFieldRow extends RowDataPacket {
  id: string | number | bigint;
  company_id: string | number | bigint;
  entity_type: string;
  field_key: string;
  label: string;
  field_type: string;
  required: boolean | number | string;
  settings_json: unknown;
  version_no: number | string;
}

interface PicklistRow extends RowDataPacket {
  id: string | number | bigint;
  company_id: string | number | bigint;
  entity_type: string;
  field_key: string;
  option_key: string;
  label: string;
  sort_order: number;
  is_active: boolean | number | string;
}

export interface CustomFieldDefinition {
  readonly id: string;
  readonly entityType: string;
  readonly fieldKey: string;
  readonly label: string;
  readonly fieldType: string;
  readonly required: boolean;
  readonly settings: unknown;
  readonly version: number;
}

export interface PicklistOption {
  readonly id: string;
  readonly entityType: string;
  readonly fieldKey: string;
  readonly optionKey: string;
  readonly label: string;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface PicklistReadOptions {
  readonly includeInactive?: boolean;
}

const MAX_ID = 18446744073709551615n;
const MAX_CONFIGURATION_ROWS = 1000;

/**
 * Entity types and keys are data, not SQL.
 *
 * We validate their format and bind them as
 * SQL parameters. No fixed list of customer
 * field names or statuses is imposed.
 */
function validateKey(
  value: unknown,
  maxLength: number,
  description: string
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(value)
  ) {
    throw new Error(
      `Invalid CRM customization ${description}`
    );
  }
}

function normalizeId(value: unknown): string {
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

  throw new Error(
    "Invalid CRM customization database identifier"
  );
}

function normalizeBoolean(
  value: unknown
): boolean {
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

  throw new Error(
    "Invalid CRM customization boolean"
  );
}

/**
 * JSON settings are customer-controlled
 * configuration data.
 *
 * Preserve their actual JSON structure.
 * Do not replace them with hardcoded forms
 * or fixed field-type configurations.
 */
function copyAndFreezeJson(
  value: unknown
): unknown {
  if (value === null) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed =
      typeof value === "string"
        ? JSON.parse(value)
        : JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error(
      "Invalid CRM customization JSON"
    );
  }

  const pending: unknown[] = [parsed];

  while (pending.length > 0) {
    const current = pending.pop();

    if (
      current === null ||
      typeof current !== "object"
    ) {
      continue;
    }

    const object = current as Record<
      string,
      unknown
    >;

    for (const child of Object.values(object)) {
      if (
        child !== null &&
        typeof child === "object"
      ) {
        pending.push(child);
      }
    }

    Object.freeze(object);
  }

  return parsed;
}

function assertRowScope(
  rowCompanyId: unknown,
  expectedCompanyId: string,
  rowEntityType: unknown,
  expectedEntityType: string
): void {
  if (
    normalizeId(rowCompanyId) !== expectedCompanyId ||
    rowEntityType !== expectedEntityType
  ) {
    throw new Error(
      "CRM customization tenant scope integrity violation"
    );
  }
}

/**
 * Read customer-defined CRM fields.
 *
 * Examples:
 * - Leads: vehicle_model, test_drive_date
 * - Contacts: preferred_language
 * - Deals: expected_delivery_date
 *
 * These are examples only, not fixed fields.
 *
 * The repository never accepts a company ID
 * from the browser.
 */
export async function listCustomFieldDefinitions(
  res: Response,
  entityType: string,
  connection?: CustomizationQueryConnection
): Promise<readonly CustomFieldDefinition[]> {
  const tenant = getTenantContext(res);

  validateKey(
    entityType,
    40,
    "entity type"
  );

  const executor = connection ?? getDbPool();

  const [rows] =
    await executor.execute<CustomFieldRow[]>(
      `
        SELECT
          id,
          company_id,
          entity_type,
          field_key,
          label,
          field_type,
          required,
          settings_json,
          (SELECT COALESCE(MAX(v.version_no), 0)
           FROM custom_field_versions v
           WHERE v.company_id = custom_fields.company_id
             AND v.custom_field_id = custom_fields.id) AS version_no

        FROM custom_fields

        WHERE company_id = ?
          AND entity_type = ?

        ORDER BY field_key ASC, id ASC
        LIMIT 1001
      `,
      [
        tenant.companyId,
        entityType,
      ]
    );

  if (
    !Array.isArray(rows) ||
    rows.length > MAX_CONFIGURATION_ROWS
  ) {
    throw new Error(
      "CRM custom field result limit exceeded"
    );
  }

  const definitions = rows.map(row => {
    assertRowScope(
      row.company_id,
      tenant.companyId,
      row.entity_type,
      entityType
    );

    validateKey(
      row.field_key,
      90,
      "field key"
    );

    validateKey(
      row.field_type,
      30,
      "field type"
    );

    if (typeof row.label !== "string") {
      throw new Error(
        "Invalid CRM custom field label"
      );
    }

    return Object.freeze({
      id: normalizeId(row.id),
      entityType: row.entity_type,
      fieldKey: row.field_key,
      label: row.label,
      fieldType: row.field_type,
      required: normalizeBoolean(row.required),
      settings: copyAndFreezeJson(
        row.settings_json
      ),
      version: Number.isSafeInteger(Number(row.version_no)) && Number(row.version_no) >= 0
        ? Number(row.version_no) : 0,
    });
  });

  return Object.freeze(definitions);
}

/**
 * Read customer-configured choices.
 *
 * Supports any valid entity + field key.
 *
 * Inactive choices are hidden by default,
 * but can be retrieved by an authorized
 * settings-management service.
 *
 * Permission checks belong in that service.
 */
export async function listPicklistOptions(
  res: Response,
  entityType: string,
  fieldKey: string,
  options: PicklistReadOptions = {},
  connection?: CustomizationQueryConnection
): Promise<readonly PicklistOption[]> {
  const tenant = getTenantContext(res);

  validateKey(
    entityType,
    40,
    "entity type"
  );

  validateKey(
    fieldKey,
    80,
    "field key"
  );

  if (
    options.includeInactive !== undefined &&
    typeof options.includeInactive !== "boolean"
  ) {
    throw new Error(
      "Invalid picklist visibility option"
    );
  }

  const executor = connection ?? getDbPool();

  const activeFilter =
    options.includeInactive === true
      ? ""
      : "AND is_active = 1";

  const [rows] =
    await executor.execute<PicklistRow[]>(
      `
        SELECT
          id,
          company_id,
          entity_type,
          field_key,
          option_key,
          label,
          sort_order,
          is_active

        FROM picklist_options

        WHERE company_id = ?
          AND entity_type = ?
          AND field_key = ?
          ${activeFilter}

        ORDER BY sort_order ASC, id ASC
        LIMIT 1001
      `,
      [
        tenant.companyId,
        entityType,
        fieldKey,
      ]
    );

  if (
    !Array.isArray(rows) ||
    rows.length > MAX_CONFIGURATION_ROWS
  ) {
    throw new Error(
      "CRM picklist result limit exceeded"
    );
  }

  const definitions = rows.map(row => {
    assertRowScope(
      row.company_id,
      tenant.companyId,
      row.entity_type,
      entityType
    );

    if (row.field_key !== fieldKey) {
      throw new Error(
        "CRM picklist field scope integrity violation"
      );
    }

    if (
      typeof row.option_key !== "string" ||
      typeof row.label !== "string" ||
      !Number.isSafeInteger(row.sort_order)
    ) {
      throw new Error(
        "Invalid CRM picklist database row"
      );
    }

    const isActive = normalizeBoolean(
      row.is_active
    );

    if (
      options.includeInactive !== true &&
      !isActive
    ) {
      throw new Error(
        "CRM picklist active filter integrity violation"
      );
    }

    return Object.freeze({
      id: normalizeId(row.id),
      entityType: row.entity_type,
      fieldKey: row.field_key,
      optionKey: row.option_key,
      label: row.label,
      sortOrder: row.sort_order,
      isActive,
    });
  });

  return Object.freeze(definitions);
}
