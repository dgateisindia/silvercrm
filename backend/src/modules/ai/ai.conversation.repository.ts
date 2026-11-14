import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { TenantContext } from '../../core/tenant/tenantContext';
import { AppError } from '../../core/errors/AppError';
import { encryptAiMessage, decryptAiMessage } from './ai.conversation.crypto';

export type AiConversationDb = Pick<PoolConnection, 'execute'|'release'|'beginTransaction'|'commit'|'rollback'>;
interface ConversationRow extends RowDataPacket {
  id: string | number; assistant_id: string | number; title: string | null;
  status: string; created_at: string | Date; updated_at: string | Date;
}
interface MessageRow extends RowDataPacket {
  id: string | number; sender: 'user'|'assistant'|'tool'; content_ciphertext: Buffer | null;
  redacted_at: Date | string | null; created_at: Date | string;
}
interface AssistantRow extends RowDataPacket { id: string | number; model_key: string; }
export interface AiConversationView {
  readonly id: string; readonly assistantId: string; readonly title: string | null;
  readonly status: string; readonly createdAt: string; readonly updatedAt: string;
}
function date(value: string | Date): string {return value instanceof Date ? value.toISOString() : String(value);}
function view(row: ConversationRow): AiConversationView {
  return {id:String(row.id),assistantId:String(row.assistant_id),title:row.title,
    status:row.status,createdAt:date(row.created_at),updatedAt:date(row.updated_at)};
}
export async function listAiConversations(db: AiConversationDb, t: TenantContext, limit: number) {
  const [rows] = await db.execute<ConversationRow[]>(`SELECT id,assistant_id,title,status,created_at,updated_at
    FROM crm_ai_conversations WHERE company_id=? AND user_id=?
    ORDER BY id DESC LIMIT ?`,[t.companyId,t.actorUserId,limit]);
  return rows.map(view);
}
export async function getAiConversation(db: AiConversationDb, t: TenantContext, id: string): Promise<AiConversationView> {
  const [rows] = await db.execute<ConversationRow[]>(`SELECT id,assistant_id,title,status,created_at,updated_at
    FROM crm_ai_conversations WHERE company_id=? AND user_id=? AND id=? LIMIT 1`,
    [t.companyId,t.actorUserId,id]);
  const item=rows[0];
  if(!item)throw AppError.notFound();
  return view(item);
}
export async function createAiConversation(db: AiConversationDb,t: TenantContext, assistantId: string,title: string|null, expectedModel: string) {
  const [assistant] = await db.execute<AssistantRow[]>(`SELECT id,model_key FROM crm_ai_assistants
    WHERE company_id=? AND id=? AND enabled=1 LIMIT 1`,[t.companyId,assistantId]);
  if(!assistant[0] || assistant[0].model_key !== expectedModel)throw AppError.forbidden();
  const [result]=await db.execute<ResultSetHeader>(`INSERT INTO crm_ai_conversations
    (company_id,assistant_id,user_id,title,status,created_at,updated_at)
    VALUES (?,?,?,?,'active',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
    [t.companyId,assistantId,t.actorUserId,title]);
  const conversationId=String(result.insertId);
  await db.execute(`INSERT INTO audit_logs
    (company_id,actor_user_id,action,entity_type,entity_id,outcome,details_json,occurred_at)
    VALUES (?,?,'ai_conversation_created','ai_conversation',?,'success',?,UTC_TIMESTAMP(3))`,
    [t.companyId,t.actorUserId,conversationId,JSON.stringify({assistantId})]);
  return conversationId;
}
export async function listAiMessages(db: AiConversationDb,t: TenantContext,conversationId:string,key:Buffer,limit:number) {
  await getAiConversation(db,t,conversationId);
  const [rows]=await db.execute<MessageRow[]>(`SELECT id,sender,content_ciphertext,redacted_at,created_at
    FROM (SELECT id,sender,content_ciphertext,redacted_at,created_at
      FROM crm_ai_messages WHERE company_id=? AND conversation_id=?
      ORDER BY id DESC LIMIT ?) selected ORDER BY id ASC`,[t.companyId,conversationId,limit]);
  return rows.map(r=>({id:String(r.id),sender:r.sender,
    text:r.redacted_at !== null || r.content_ciphertext === null ? null :
      decryptAiMessage(r.content_ciphertext,key,t.companyId,conversationId),
    redacted:r.redacted_at !== null,createdAt:date(r.created_at)}));
}
/** Internal-only primitive; never expose a browser-controlled write-message endpoint. */
export async function appendAiMessage(db:AiConversationDb,t:TenantContext,conversationId:string,
    sender:'user'|'assistant',text:string,key:Buffer):Promise<string> {
  await getAiConversation(db,t,conversationId);
  const encrypted=encryptAiMessage(text,key,t.companyId,conversationId);
  const [result]=await db.execute<ResultSetHeader>(`INSERT INTO crm_ai_messages
    (company_id,conversation_id,sender,content_ciphertext,content_preview,created_by_id,created_at,updated_at)
    VALUES (?,?,?,?,NULL,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
    [t.companyId,conversationId,sender,encrypted,t.actorUserId]);
  await db.execute(`UPDATE crm_ai_conversations SET last_message_at=UTC_TIMESTAMP(3),
    updated_at=UTC_TIMESTAMP(3) WHERE company_id=? AND id=? AND user_id=?`,
    [t.companyId,conversationId,t.actorUserId]);
  return String(result.insertId);
}
