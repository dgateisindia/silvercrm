import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { AppError } from "../../../core/errors/AppError";
import type { TenantContext } from "../../../core/tenant/tenantContext";

export type Db = Pick<PoolConnection, "execute" | "beginTransaction" | "commit" | "rollback" | "release" | "destroy">;
export function id(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "bigint" && value > 0n && value <= 18446744073709551615n) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n) return value;
  throw new Error("Invalid database identifier");
}
interface LeadRow extends RowDataPacket {id: string | number | bigint; company_id: string | number | bigint; owner_user_id: string | number | bigint; title: string; status: string}
interface MemberRow extends RowDataPacket { team_id: string | number | bigint }
interface UserRow extends RowDataPacket {role: string; status: string}

/** Every endpoint checks live record ownership; never trust the browser's company or role. */
export async function scopedLead(db: Db, tenant: TenantContext, leadId: string, lock = false) {
  const [rows] = await db.execute<LeadRow[]>(
    `SELECT id,company_id,owner_user_id,title,status FROM leads WHERE company_id=? AND id=? LIMIT 1 ${lock ? "FOR UPDATE" : ""}`,
    [tenant.companyId, leadId]);
  const row = rows[0];
  if (!row || id(row.company_id) !== tenant.companyId || id(row.id) !== leadId) throw AppError.notFound();
  const owner = id(row.owner_user_id);
  if (tenant.role === "EMPLOYEE" && owner !== tenant.actorUserId) throw AppError.notFound();
  if (tenant.role === "MANAGER" && owner !== tenant.actorUserId) {
    const [teams] = await db.execute<MemberRow[]>(
      `SELECT tm.team_id FROM team_members tm INNER JOIN teams t
       ON t.company_id=tm.company_id AND t.id=tm.team_id
       WHERE tm.company_id=? AND tm.user_id=? AND tm.left_at IS NULL
       AND tm.joined_at<=UTC_TIMESTAMP(3) AND t.manager_user_id=? AND t.status='active'
       LIMIT 1`, [tenant.companyId, owner, tenant.actorUserId]);
    if (!teams.length) throw AppError.notFound();
  }
  return Object.freeze({id: leadId, ownerUserId: owner, title: row.title, status: row.status});
}
export async function sameManagedTeam(db: Db, tenant: TenantContext, from: string, to: string): Promise<void> {
  if (tenant.role !== "MANAGER") throw AppError.forbidden();
  const needed = [...new Set([from, to].filter(x => x !== tenant.actorUserId))];
  if (needed.length === 0) throw AppError.badRequest();
  const marks = needed.map(() => "?").join(",");
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT t.id AS team_id, COUNT(DISTINCT tm.user_id) AS matched
     FROM teams t JOIN team_members tm ON tm.company_id=t.company_id AND tm.team_id=t.id
     WHERE t.company_id=? AND t.manager_user_id=? AND t.status='active'
       AND tm.user_id IN (${marks}) AND tm.left_at IS NULL
       AND tm.joined_at<=UTC_TIMESTAMP(3) GROUP BY t.id
       HAVING COUNT(DISTINCT tm.user_id) = ? LIMIT 1`,
    [tenant.companyId, tenant.actorUserId, ...needed, needed.length]);
  if (!rows.length) throw AppError.notFound();
}
export async function activeEmployee(db: Db, tenant: TenantContext, target: string): Promise<void> {
  const [rows] = await db.execute<UserRow[]>(
    `SELECT role,status FROM users WHERE company_id=? AND id=? LIMIT 1`, [tenant.companyId,target]);
  if (!rows[0] || rows[0].role !== "employee" || rows[0].status !== "active") throw AppError.forbidden();
}
export async function audit(db: Db, tenant: TenantContext, leadId: string, action: string, details: Record<string, unknown>, requestId: string | null): Promise<void> {
  await db.execute(
    `INSERT INTO audit_logs (company_id,actor_user_id,action,entity_type,entity_id,outcome,request_id,details_json,occurred_at)
     VALUES (?, ?, ?, 'lead', ?, 'success', ?, ?, UTC_TIMESTAMP(3))`,
    [tenant.companyId, tenant.actorUserId, action, leadId, requestId, JSON.stringify(details)]);
}