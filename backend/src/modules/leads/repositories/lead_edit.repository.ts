import type {
  PoolConnection,
  RowDataPacket,
  ResultSetHeader,
} from "mysql2/promise";

import { AppError } from "../../../core/errors/AppError";

import type {
  TenantContext,
} from "../../../core/tenant/tenantContext";

import type {
  LeadCore,
  LeadEditInput,
} from "../schemas/lead_edit.schema";

export type LeadEditConnection = Pick<
  PoolConnection,
  | "execute"
  | "beginTransaction"
  | "commit"
  | "rollback"
  | "release"
  | "destroy"
>;

interface LeadRow extends RowDataPacket {
  id: string | number | bigint;
  company_id: string | number | bigint;
  owner_user_id: string | number | bigint;
  title: string;
  status: string;
  priority: string;
  source_key: string | null;
  description: string | null;
  revision: string;
}

interface TeamRow extends RowDataPacket {
  id: string | number | bigint;
}

interface ChoiceRow extends RowDataPacket {
  option_key: string;
}

interface RevisionRow extends RowDataPacket {
  revision: string;
}

function id(value: string | number | bigint): string {
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

  throw new Error("Invalid database identifier");
}

async function scope(
  db: LeadEditConnection,
  tenant: TenantContext,
  owner: string
): Promise<void> {
  if (
    tenant.role === "OWNER" ||
    owner === tenant.actorUserId
  ) {
    return;
  }

  if (tenant.role !== "MANAGER") {
    throw AppError.notFound();
  }

  const [teams] = await db.execute<TeamRow[]>(
    `
      SELECT tm.id

      FROM team_members tm

      INNER JOIN teams t
        ON t.company_id = tm.company_id
        AND t.id = tm.team_id

      WHERE tm.company_id = ?
        AND tm.user_id = ?
        AND tm.left_at IS NULL
        AND tm.joined_at <= UTC_TIMESTAMP(3)
        AND t.status = 'active'
        AND t.manager_user_id = ?

      LIMIT 1
      FOR UPDATE
    `,
    [
      tenant.companyId,
      owner,
      tenant.actorUserId,
    ]
  );

  if (teams.length !== 1) {
    throw AppError.notFound();
  }
}

export async function lockedLead(
  db: LeadEditConnection,
  tenant: TenantContext,
  leadId: string
) {
  const [rows] = await db.execute<LeadRow[]>(
    `
      SELECT
        id,
        company_id,
        owner_user_id,
        title,
        status,
        priority,
        source_key,
        description,
        DATE_FORMAT(
          updated_at,
          '%Y-%m-%dT%H:%i:%s.%f'
        ) AS revision

      FROM leads

      WHERE company_id = ?
        AND id = ?

      LIMIT 1
      FOR UPDATE
    `,
    [
      tenant.companyId,
      leadId,
    ]
  );

  const lead = rows[0];

  if (
    !lead ||
    id(lead.company_id) !== tenant.companyId ||
    id(lead.id) !== leadId
  ) {
    throw AppError.notFound();
  }

  await scope(
    db,
    tenant,
    id(lead.owner_user_id)
  );

  if (typeof lead.revision !== "string") {
    throw new Error("Invalid Lead revision");
  }

  return Object.freeze({
    id: leadId,
    ownerUserId: id(lead.owner_user_id),
    title: lead.title,
    status: lead.status,
    priority: lead.priority,
    sourceKey: lead.source_key,
    description: lead.description,
    revision: lead.revision,
  });
}

async function choice(
  db: LeadEditConnection,
  tenant: TenantContext,
  field: string,
  value: string
): Promise<void> {
  const [rows] = await db.execute<ChoiceRow[]>(
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
      value,
    ]
  );

  if (rows[0]?.option_key !== value) {
    throw AppError.badRequest();
  }
}

export async function reviseLead(
  db: LeadEditConnection,
  tenant: TenantContext,
  leadId: string,
  input: LeadEditInput,
  requestId: string | null
) {
  const previous = await lockedLead(
    db,
    tenant,
    leadId
  );

  if (previous.revision !== input.expectedRevision) {
    throw AppError.conflict();
  }

  const next: LeadCore = {
    title:
      input.changes.title ?? previous.title,

    status:
      input.changes.status ?? previous.status,

    priority:
      input.changes.priority ?? previous.priority,

    sourceKey:
      Object.hasOwn(input.changes, "sourceKey")
        ? input.changes.sourceKey!
        : previous.sourceKey,

    description:
      Object.hasOwn(input.changes, "description")
        ? input.changes.description!
        : previous.description,
  };

  const changed = (
    Object.keys(input.changes) as Array<keyof LeadCore>
  ).filter(
    key => previous[key] !== next[key]
  );

  if (!changed.length) {
    return previous;
  }

  if (next.status !== previous.status) {
    await choice(
      db,
      tenant,
      "status",
      next.status
    );
  }

  if (next.priority !== previous.priority) {
    await choice(
      db,
      tenant,
      "priority",
      next.priority
    );
  }

  if (
    next.sourceKey !== previous.sourceKey &&
    next.sourceKey !== null
  ) {
    await choice(
      db,
      tenant,
      "source_key",
      next.sourceKey
    );
  }

  const [updated] =
    await db.execute<ResultSetHeader>(
      `
        UPDATE leads

        SET
          title = ?,
          status = ?,
          priority = ?,
          source_key = ?,
          description = ?,
          updated_at = GREATEST(
            DATE_ADD(
              updated_at,
              INTERVAL 1000 MICROSECOND
            ),
            UTC_TIMESTAMP(3)
          )

        WHERE company_id = ?
          AND id = ?
      `,
      [
        next.title,
        next.status,
        next.priority,
        next.sourceKey,
        next.description,
        tenant.companyId,
        leadId,
      ]
    );

  if (updated.affectedRows !== 1) {
    throw AppError.conflict();
  }

  if (next.status !== previous.status) {
    await db.execute(
      `
        INSERT INTO crm_lead_status_history (
          company_id,
          lead_id,
          old_status,
          new_status,
          changed_by_id,
          changed_at
        )
        VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))
      `,
      [
        tenant.companyId,
        leadId,
        previous.status,
        next.status,
        tenant.actorUserId,
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
        'lead.updated',
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
        fields: changed.sort(),
      }),
    ]
  );

  const [revisionRows] =
    await db.execute<RevisionRow[]>(
      `
        SELECT DATE_FORMAT(
          updated_at,
          '%Y-%m-%dT%H:%i:%s.%f'
        ) AS revision

        FROM leads

        WHERE company_id = ?
          AND id = ?
      `,
      [
        tenant.companyId,
        leadId,
      ]
    );

  const revision = revisionRows[0]?.revision;

  if (
    typeof revision !== "string" ||
    revision === previous.revision
  ) {
    throw new Error(
      "Lead revision did not advance"
    );
  }

  return Object.freeze({
    ...previous,
    ...next,
    revision,
  });
}