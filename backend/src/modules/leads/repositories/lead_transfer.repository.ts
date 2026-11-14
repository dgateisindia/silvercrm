import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import { AppError } from "../../../core/errors/AppError";
import type { TenantContext } from "../../../core/tenant/tenantContext";
import type { DirectTransferInput } from "../schemas/lead_transfer.schema";

export type DirectTransferConnection = Pick<
  PoolConnection,
  "execute" | "beginTransaction" | "commit" | "rollback" | "release" | "destroy"
>;

interface LeadRow extends RowDataPacket {
  owner_user_id: string | number | bigint;
}

interface UserRow extends RowDataPacket {
  id: string | number | bigint;
  role: string;
  status: string;
}

interface TeamRow extends RowDataPacket {
  id: string | number | bigint;
}

interface MemberRow extends RowDataPacket {
  user_id: string | number | bigint;
}

function id(value: string | number | bigint): string {
  if (typeof value === "bigint" && value > 0n) {
    return String(value);
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
    /^[1-9][0-9]*$/.test(value) &&
    BigInt(value) <= 18446744073709551615n
  ) {
    return value;
  }

  throw new Error("Invalid database identifier");
}

export async function executeDirectTransfer(
  db: DirectTransferConnection,
  tenant: TenantContext,
  leadId: string,
  input: DirectTransferInput,
  requestId: string | null
) {
  // Lock the Lead before inspecting ownership.
  const [leads] = await db.execute<LeadRow[]>(
    `SELECT owner_user_id
     FROM leads
     WHERE company_id = ? AND id = ?
     LIMIT 1 FOR UPDATE`,
    [tenant.companyId, leadId]
  );

  if (!leads[0]) {
    throw AppError.notFound();
  }

  const from = id(leads[0].owner_user_id);

  // Recipient must exist in the verified company.
  const [recipients] = await db.execute<UserRow[]>(
    `SELECT id, role, status
     FROM users
     WHERE company_id = ? AND id = ?
     LIMIT 1 FOR UPDATE`,
    [tenant.companyId, input.toUserId]
  );

  const target = recipients[0];

  if (
    !target ||
    id(target.id) !== input.toUserId ||
    target.status !== "active" ||
    !(
      target.role === "employee" ||
      (
        target.role === "manager" &&
        input.toUserId === tenant.actorUserId
      )
    )
  ) {
    throw AppError.forbidden();
  }

  // Both users must be in the same active managed team.
  // A manager may transfer to or from their own account.
  const [teams] = await db.execute<TeamRow[]>(
    `SELECT id
     FROM teams
     WHERE company_id = ?
       AND manager_user_id = ?
       AND status = 'active'
     ORDER BY id
     LIMIT 101 FOR UPDATE`,
    [tenant.companyId, tenant.actorUserId]
  );

  if (teams.length > 100) {
    throw AppError.forbidden();
  }

  let authorized = false;

  for (const team of teams) {
    const needed = [
      ...new Set(
        [from, input.toUserId].filter(
          user => user !== tenant.actorUserId
        )
      ),
    ];

    if (!needed.length) {
      continue;
    }

    const marks = needed.map(() => "?").join(",");

    const [members] = await db.execute<MemberRow[]>(
      `SELECT user_id
       FROM team_members
       WHERE company_id = ?
         AND team_id = ?
         AND user_id IN (${marks})
         AND left_at IS NULL
         AND joined_at <= UTC_TIMESTAMP(3)
       FOR UPDATE`,
      [tenant.companyId, id(team.id), ...needed]
    );

    const active = new Set(
      members.map(member => id(member.user_id))
    );

    if (needed.every(user => active.has(user))) {
      authorized = true;
      break;
    }
  }

  if (!authorized) {
    throw AppError.notFound();
  }

  // Check stale ownership only after access checks.
  if (from !== input.expectedOwnerUserId) {
    throw AppError.conflict();
  }

  if (from === input.toUserId) {
    throw AppError.badRequest();
  }

  const [created] = await db.execute<ResultSetHeader>(
    `INSERT INTO lead_transfer_requests
     (
       company_id,
       requested_by_id,
       from_user_id,
       to_user_id,
       transfer_type,
       request_mode,
       status,
       reason,
       decided_by_id,
       decided_at
     )
     VALUES (
       ?, ?, ?, ?,
       'permanent',
       'manager_direct',
       'approved',
       ?, ?,
       UTC_TIMESTAMP(3)
     )`,
    [
      tenant.companyId,
      tenant.actorUserId,
      from,
      input.toUserId,
      input.reason,
      tenant.actorUserId,
    ]
  );

  const transferId = id(created.insertId);

  await db.execute(
    `INSERT INTO lead_transfer_request_items
     (company_id, request_id, lead_id, decision)
     VALUES (?, ?, ?, 'approved')`,
    [tenant.companyId, transferId, leadId]
  );

  const [updated] = await db.execute<ResultSetHeader>(
    `UPDATE leads
     SET
       owner_user_id = ?,
       assigned_at = UTC_TIMESTAMP(3),
       updated_at = GREATEST(
         DATE_ADD(updated_at, INTERVAL 1000 MICROSECOND),
         UTC_TIMESTAMP(3)
       )
     WHERE company_id = ?
       AND id = ?
       AND owner_user_id = ?`,
    [
      input.toUserId,
      tenant.companyId,
      leadId,
      from,
    ]
  );

  if (updated.affectedRows !== 1) {
    throw AppError.conflict();
  }

  await db.execute(
    `INSERT INTO assignment_history
     (
       company_id,
       entity_type,
       entity_id,
       from_user_id,
       to_user_id,
       assigned_by_user_id,
       reason,
       happened_at
     )
     VALUES (?, 'lead', ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
    [
      tenant.companyId,
      leadId,
      from,
      input.toUserId,
      tenant.actorUserId,
      input.reason,
    ]
  );

  await db.execute(
    `INSERT INTO audit_logs
     (
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
       'lead.transferred',
       'lead',
       ?,
       'success',
       ?, ?,
       UTC_TIMESTAMP(3)
     )`,
    [
      tenant.companyId,
      tenant.actorUserId,
      leadId,
      requestId,
      JSON.stringify({
        transferRequestId: transferId,
        fromUserId: from,
        toUserId: input.toUserId,
      }),
    ]
  );

  return Object.freeze({
    leadId,
    transferRequestId: transferId,
    fromUserId: from,
    toUserId: input.toUserId,
  });
}