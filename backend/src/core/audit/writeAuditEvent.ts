import type { PoolConnection } from "mysql2/promise";

/**
 * Only approved operational metadata is stored.
 * Never pass passwords, tokens, email contents,
 * customer notes, or request bodies to this writer.
 */
const ALLOWED_DETAIL_KEYS = [
  "previousOwnerId",
  "newOwnerId",
  "previousStatus",
  "newStatus",
  "approvalRequestId",
  "reasonCode",
  "changedFields",
] as const;

export type AuditDetailKey =
  (typeof ALLOWED_DETAIL_KEYS)[number];

export type AuditDetails = Partial<
  Record<AuditDetailKey, string | number | boolean | null>
>;

export type AuditOutcome =
  | "SUCCESS"
  | "DENIED"
  | "FAILED";

export interface AuditEvent {
  companyId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  outcome: AuditOutcome;
  requestId: string | null;
  details?: AuditDetails | null;
}

const MAX_UNSIGNED_BIGINT =
  18446744073709551615n;

const ALLOWED_KEYS = new Set<string>(
  ALLOWED_DETAIL_KEYS
);

function validateId(
  value: string,
  field: string
): void {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value) ||
    BigInt(value) > MAX_UNSIGNED_BIGINT
  ) {
    throw new Error(`Invalid audit ${field}`);
  }
}

function serializeDetails(
  details: AuditDetails | null | undefined
): string | null {
  if (details == null) {
    return null;
  }

  if (
    typeof details !== "object" ||
    Array.isArray(details) ||
    Object.getPrototypeOf(details) !== Object.prototype
  ) {
    throw new Error("Invalid audit details");
  }

  const entries = Object.entries(details);

  if (entries.length > ALLOWED_DETAIL_KEYS.length) {
    throw new Error("Too many audit detail fields");
  }

  const safe: Record<
    string,
    string | number | boolean | null
  > = {};

  for (const [key, value] of entries) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error("Unapproved audit detail field");
    }

    if (typeof value === "string") {
      if (
        value.length > 120 ||
        /[\u0000-\u001f\u007f]/.test(value)
      ) {
        throw new Error("Invalid audit detail value");
      }
    } else if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) {
        throw new Error("Invalid audit detail number");
      }
    } else if (
      typeof value !== "boolean" &&
      value !== null
    ) {
      throw new Error("Invalid audit detail type");
    }

    safe[key] = value;
  }

  const json = JSON.stringify(safe);

  if (Buffer.byteLength(json, "utf8") > 2048) {
    throw new Error("Audit details exceed size limit");
  }

  return json;
}

const INSERT_AUDIT_SQL = `
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
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))
`;

/**
 * Write a CRM audit record.
 *
 * The caller MUST obtain companyId and actorUserId
 * from verified server-side CRM identity context.
 *
 * The connection MUST belong to the same transaction
 * as the business operation being audited.
 *
 * Do not silently ignore an insertion failure.
 */
export async function writeAuditEvent(
  connection: PoolConnection,
  event: AuditEvent
): Promise<void> {
  validateId(event.companyId, "companyId");

  if (event.actorUserId !== null) {
    validateId(event.actorUserId, "actorUserId");
  }

  if (event.entityId !== null) {
    validateId(event.entityId, "entityId");
  }

  if (
    typeof event.action !== "string" ||
    !/^[a-z][a-z0-9_.-]{0,99}$/.test(event.action)
  ) {
    throw new Error("Invalid audit action");
  }

  if (
    typeof event.entityType !== "string" ||
    !/^[a-z][a-z0-9_]{0,49}$/.test(event.entityType)
  ) {
    throw new Error("Invalid audit entity type");
  }

  if (
    !["SUCCESS", "DENIED", "FAILED"].includes(
      event.outcome
    )
  ) {
    throw new Error("Invalid audit outcome");
  }

  if (
    event.requestId !== null &&
    (
      typeof event.requestId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,100}$/.test(
        event.requestId
      )
    )
  ) {
    throw new Error("Invalid audit requestId");
  }

  const detailsJson = serializeDetails(event.details);

  await connection.execute(INSERT_AUDIT_SQL, [
    event.companyId,
    event.actorUserId,
    event.action,
    event.entityType,
    event.entityId,
    event.outcome,
    event.requestId,
    detailsJson,
  ]);
}
