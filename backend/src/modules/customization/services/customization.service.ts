import type { Response } from "express";

import { AppError } from "../../../core/errors/AppError";

import {
  getTenantContext,
  type TenantContext,
} from "../../../core/tenant/tenantContext";

import {
  requirePermission,
} from "../../../core/permissions/policies";

import {
  listCustomFieldDefinitions,
  listPicklistOptions,
  type CustomizationQueryConnection,
  type CustomFieldDefinition,
  type PicklistOption,
} from "../repositories/customization.repository";

/**
 * Other CRM modules must supply their own
 * trusted entity-level permission check.
 *
 * This callback is server-owned, never
 * supplied by the browser.
 */
export type CustomizationEntityReadAuthorizer = (
  tenant: TenantContext,
  entityType: string
) => void | Promise<void>;

export interface CustomizationServiceDependencies {
  readonly connection?: CustomizationQueryConnection;
  readonly authorizeEntityRead?:
    CustomizationEntityReadAuthorizer;
}

export interface CustomizationReadOptions {
  readonly includeInactive?: boolean;
}

export interface DynamicFormMetadata {
  readonly entityType: string;
  readonly fields: readonly CustomFieldDefinition[];
  readonly picklists: Readonly<
    Record<string, readonly PicklistOption[]>
  >;
}

export interface CustomizationService {
  listFields(
    res: Response,
    entityType: string
  ): Promise<readonly CustomFieldDefinition[]>;

  listOptions(
    res: Response,
    entityType: string,
    fieldKey: string,
    options?: CustomizationReadOptions
  ): Promise<readonly PicklistOption[]>;

  getFormMetadata(
    res: Response,
    entityType: string,
    picklistKeys?: readonly string[],
    options?: CustomizationReadOptions
  ): Promise<DynamicFormMetadata>;
}

function validateKey(
  value: unknown,
  maxLength: number
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(value)
  ) {
    throw AppError.badRequest();
  }
}

function validateOptions(
  value: unknown
): CustomizationReadOptions {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw AppError.badRequest();
  }

  const options = value as Record<
    string,
    unknown
  >;

  if (
    Object.keys(options).some(
      key => key !== "includeInactive"
    )
  ) {
    throw AppError.badRequest();
  }

  if (
    options.includeInactive !== undefined &&
    typeof options.includeInactive !== "boolean"
  ) {
    throw AppError.badRequest();
  }

  return {
    includeInactive:
      options.includeInactive === true,
  };
}

/**
 * Customizations are company-specific data.
 *
 * For Leads, the existing leads.read policy
 * controls access.
 *
 * Other entity types require a trusted
 * module-specific read authorizer.
 *
 * Inactive Lead status/priority choices require dedicated management access;
 * other inactive choices still require settings.manage,
 * which also respects READ_ONLY restrictions.
 */
export function createCustomizationService(
  dependencies: CustomizationServiceDependencies = {}
): CustomizationService {
  async function authorizeRead(
    res: Response,
    entityType: string,
    includeInactive: boolean,
    picklistKeys: readonly string[] = []
  ): Promise<void> {
    const tenant = getTenantContext(res);

    validateKey(entityType, 40);

    if (entityType === "leads") {
      requirePermission(
        tenant,
        "leads.read"
      );
    } else {
      if (
        typeof dependencies.authorizeEntityRead !==
        "function"
      ) {
        throw AppError.forbidden();
      }

      await dependencies.authorizeEntityRead(
        tenant,
        entityType
      );
    }

    if (includeInactive) {
      const leadChoiceEditor =
        entityType === "leads" &&
        picklistKeys.length > 0 &&
        picklistKeys.every(key => key === "status" || key === "priority");
      requirePermission(
        tenant,
        leadChoiceEditor
          ? "customization.leads.picklists.manage"
          : "settings.manage"
      );
    }
  }

  async function listFields(
    res: Response,
    entityType: string
  ): Promise<readonly CustomFieldDefinition[]> {
    await authorizeRead(
      res,
      entityType,
      false
    );

    return listCustomFieldDefinitions(
      res,
      entityType,
      dependencies.connection
    );
  }

  async function listOptions(
    res: Response,
    entityType: string,
    fieldKey: string,
    options: CustomizationReadOptions = {}
  ): Promise<readonly PicklistOption[]> {
    validateKey(fieldKey, 80);

    const validated = validateOptions(
      options
    );

    await authorizeRead(
      res,
      entityType,
      validated.includeInactive === true,
      [fieldKey]
    );

    return listPicklistOptions(
      res,
      entityType,
      fieldKey,
      validated,
      dependencies.connection
    );
  }

  /**
   * Prepare metadata for a configurable form.
   *
   * Choice fields are explicitly requested
   * by the trusted calling feature.
   *
   * No fixed Lead status, source, industry,
   * or form layout is imposed here.
   */
  async function getFormMetadata(
    res: Response,
    entityType: string,
    picklistKeys: readonly string[] = [],
    options: CustomizationReadOptions = {}
  ): Promise<DynamicFormMetadata> {
    if (
      !Array.isArray(picklistKeys) ||
      picklistKeys.length > 50
    ) {
      throw AppError.badRequest();
    }

    for (const key of picklistKeys) {
      validateKey(key, 80);
    }

    const validated = validateOptions(
      options
    );

    await authorizeRead(
      res,
      entityType,
      validated.includeInactive === true,
      picklistKeys
    );

    const uniqueKeys = [
      ...new Set(picklistKeys),
    ];

    const fields =
      await listCustomFieldDefinitions(
        res,
        entityType,
        dependencies.connection
      );

    const optionGroups = await Promise.all(
      uniqueKeys.map(key =>
        listPicklistOptions(
          res,
          entityType,
          key,
          validated,
          dependencies.connection
        )
      )
    );

    const picklists: Record<
      string,
      readonly PicklistOption[]
    > = Object.create(null) as Record<
      string,
      readonly PicklistOption[]
    >;

    uniqueKeys.forEach((key, index) => {
      picklists[key] = optionGroups[index] ?? [];
    });

    return Object.freeze({
      entityType,
      fields,
      picklists: Object.freeze(picklists),
    });
  }

  return Object.freeze({
    listFields,
    listOptions,
    getFormMetadata,
  });
}
