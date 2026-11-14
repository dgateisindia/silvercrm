import type { Response } from "express";

import {
  getDbPool,
} from "../../../core/database/pool";

import {
  getTenantContext,
} from "../../../core/tenant/tenantContext";

import {
  requirePermission,
} from "../../../core/permissions/policies";

import { AppError } from "../../../core/errors/AppError";

import {
  parseNewCustomField,
  parseRevisedCustomField,
  parseFieldId,
} from "../schemas/customization.write.schema";

import {
  createCustomFieldWriteRepository,
  type FieldWriteConnection,
  type SavedCustomField,
} from "../repositories/customization.write.repository";

export interface CustomFieldWriteDependencies {
  readonly connectionFactory?: () =>
    Promise<FieldWriteConnection>;
}

function requestIdFromResponse(
  res: Response
): string | null {
  const value: unknown = res.locals.requestId;

  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 100
  ) {
    return value;
  }

  return null;
}

async function withTransaction<T>(
  factory: () => Promise<FieldWriteConnection>,
  operation: (
    connection: FieldWriteConnection
  ) => Promise<T>
): Promise<T> {
  const connection = await factory();

  let started = false;
  let commitUncertain = false;
  let destroyConnection = false;

  try {
    await connection.beginTransaction();

    started = true;

    const result = await operation(connection);

    // Once COMMIT begins, a connection failure
    // may leave its outcome uncertain.
    commitUncertain = true;

    await connection.commit();

    commitUncertain = false;
    started = false;

    return result;
  } catch (error) {
    if (commitUncertain) {
      destroyConnection = true;
    } else if (started) {
      try {
        await connection.rollback();
      } catch {
        destroyConnection = true;
      }
    }

    throw error;
  } finally {
    if (destroyConnection) {
      connection.destroy();
    } else {
      connection.release();
    }
  }
}

function translateDuplicate(error: unknown): never {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ER_DUP_ENTRY"
  ) {
    throw AppError.conflict();
  }

  throw error;
}

/**
 * Customer customization management.
 *
 * All changes require customization.fields.manage.
 *
 * The verified company and actor IDs come
 * from server-issued tenant context.
 *
 * The service never trusts client-provided
 * company, role or actor identifiers.
 */
export function createCustomFieldWriteService(
  dependencies: CustomFieldWriteDependencies = {}
) {
  const factory =
    dependencies.connectionFactory ??
    (() => getDbPool().getConnection());

  async function create(
    res: Response,
    input: unknown
  ): Promise<SavedCustomField> {
    const tenant = getTenantContext(res);

    requirePermission(
      tenant,
      "customization.fields.manage"
    );

    const definition =
      parseNewCustomField(input);

    try {
      return await withTransaction(
        factory,
        connection => {
          const repository =
            createCustomFieldWriteRepository(
              connection
            );

          return repository.create(
            tenant,
            definition,
            requestIdFromResponse(res)
          );
        }
      );
    } catch (error) {
      return translateDuplicate(error);
    }
  }

  async function revise(
    res: Response,
    fieldId: unknown,
    input: unknown
  ): Promise<SavedCustomField> {
    const tenant = getTenantContext(res);

    requirePermission(
      tenant,
      "customization.fields.manage"
    );

    const id = parseFieldId(fieldId);

    const revision =
      parseRevisedCustomField(input);

    try {
      return await withTransaction(
        factory,
        connection => {
          const repository =
            createCustomFieldWriteRepository(
              connection
            );

          return repository.revise(
            tenant,
            id,
            revision,
            requestIdFromResponse(res)
          );
        }
      );
    } catch (error) {
      return translateDuplicate(error);
    }
  }

  return Object.freeze({
    create,
    revise,
  });
}