import type {PoolConnection,RowDataPacket,ResultSetHeader} from 'mysql2/promise';
import type {TenantContext} from '../../../core/tenant/tenantContext';
import {AppError} from '../../../core/errors/AppError';
import {taskId} from '../schemas/task.schema';

export type TaskDb=Pick<PoolConnection,
 'execute'|'beginTransaction'|'commit'|'rollback'|'release'|'destroy'>;
export interface TaskRow extends RowDataPacket {
 readonly id:string|number|bigint;
 readonly title:string;
 readonly description:string|null;
 readonly owner_user_id:string|number|bigint;
 readonly deal_id:string|number|bigint|null;
 readonly contact_id:string|number|bigint|null;
 readonly status:string;
 readonly priority:string;
 readonly due_at:Date|string|null;
 readonly completed_at:Date|string|null;
 readonly revision:string;
}
const projection=`t.id,t.title,t.description,t.owner_user_id,t.deal_id,t.contact_id,
 t.status,t.priority,t.due_at,t.completed_at,
 DATE_FORMAT(t.updated_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS revision`;

function scope(t:TenantContext):{sql:string;params:string[]} {
 if(t.role==='OWNER')return {sql:'',params:[]};
 if(t.role==='EMPLOYEE')return {sql:' AND t.owner_user_id=?',params:[t.actorUserId]};
 if(t.role!=='MANAGER')throw AppError.forbidden();
 return {sql:` AND (t.owner_user_id=? OR EXISTS (
 SELECT 1 FROM team_members tm INNER JOIN teams te
 ON te.company_id=tm.company_id AND te.id=tm.team_id
 WHERE tm.company_id=t.company_id AND tm.user_id=t.owner_user_id
 AND tm.left_at IS NULL AND tm.joined_at<=UTC_TIMESTAMP(3)
 AND te.manager_user_id=? AND te.status='active'))`,
 params:[t.actorUserId,t.actorUserId]};
}
export async function listGeneralTasks(db:TaskDb,t:TenantContext,
 q:{limit:number;status:'all'|'open'|'completed'}) {
 const s=scope(t);
 const status=q.status==='all'?'':` AND t.status=?`;
 const args:(string|number|null)[]=[t.companyId,...s.params];
 if(q.status!=='all')args.push(q.status);
 args.push(q.limit+1);
 const [rows]=await db.execute<TaskRow[]>(`SELECT ${projection} FROM tasks t
 WHERE t.company_id=? AND t.lead_id IS NULL ${s.sql} ${status}
 ORDER BY t.id DESC LIMIT ?`,args);
 return {rows:rows.slice(0,q.limit),hasMore:rows.length>q.limit};
}
export async function getGeneralTask(db:TaskDb,t:TenantContext,taskIdValue:string,
 forUpdate=false):Promise<TaskRow> {
 const s=scope(t);
 const [rows]=await db.execute<TaskRow[]>(`SELECT ${projection} FROM tasks t
 WHERE t.company_id=? AND t.id=? AND t.lead_id IS NULL ${s.sql}
 LIMIT 1 ${forUpdate?'FOR UPDATE':''}`,
 [t.companyId,taskIdValue,...s.params]);
 if(!rows[0])throw AppError.notFound();
 return rows[0];
}
export async function assertTaskActor(db:TaskDb,t:TenantContext):Promise<void>{
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT id FROM users
 WHERE company_id=? AND id=? AND role=? AND status='active' LIMIT 1 FOR UPDATE`,
 [t.companyId,t.actorUserId,t.role.toLowerCase()]);
 if(rows.length===0)throw AppError.forbidden();
}
export async function assertAssignee(db:TaskDb,t:TenantContext,ownerId:string):Promise<void>{
 if(t.role==='EMPLOYEE'&&ownerId!==t.actorUserId)throw AppError.notFound();
 if(t.role!=='EMPLOYEE'&&t.role!=='MANAGER')throw AppError.forbidden();
 // Lock user row to serialize with staff deactivation and team reassignment.
 const [users]=await db.execute<RowDataPacket[]>(
 `SELECT id,role,status FROM users WHERE company_id=? AND id=? LIMIT 1 FOR UPDATE`,
 [t.companyId,ownerId]);
 const person=users[0];
 if(!person||person.status!=='active')throw AppError.notFound();
 if(t.role==='EMPLOYEE')return;
 if(ownerId===t.actorUserId)return;
 if(person.role!=='employee')throw AppError.notFound();
 const [team]=await db.execute<RowDataPacket[]>(`SELECT tm.id FROM team_members tm
 INNER JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id
 WHERE tm.company_id=? AND tm.user_id=? AND tm.left_at IS NULL
 AND tm.joined_at<=UTC_TIMESTAMP(3) AND te.status='active'
 AND te.manager_user_id=? LIMIT 1 FOR UPDATE`,
 [t.companyId,ownerId,t.actorUserId]);
 if(team.length===0)throw AppError.notFound();
}
export async function assertLinkedRecords(db:TaskDb,t:TenantContext,ownerId:string,
 dealId:string|null,contactId:string|null):Promise<void> {
 if(dealId!==null){
  const [deals]=await db.execute<RowDataPacket[]>(`SELECT id FROM deals
   WHERE company_id=? AND id=? AND owner_user_id=? LIMIT 1`,
   [t.companyId,dealId,ownerId]);
  if(deals.length===0)throw AppError.notFound();
 }
 if(contactId!==null){
  const [contacts]=await db.execute<RowDataPacket[]>(`SELECT id FROM contacts
   WHERE company_id=? AND id=? AND owner_user_id=? LIMIT 1`,
   [t.companyId,contactId,ownerId]);
  if(contacts.length===0)throw AppError.notFound();
 }
}
export async function insertTask(db:TaskDb,t:TenantContext,x:{
 title:string;description:string|null;ownerUserId:string;dueAt:string|null;
 priority:string;dealId:string|null;contactId:string|null;}):Promise<string>{
 const [result]=await db.execute<ResultSetHeader>(`INSERT INTO tasks
 (company_id,title,description,owner_user_id,deal_id,contact_id,due_at,
 status,priority,completed_at,created_at,updated_at)
 VALUES (?,?,?,?,?,?,?,'open',?,NULL,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
 [t.companyId,x.title,x.description,x.ownerUserId,x.dealId,x.contactId,x.dueAt,x.priority]);
 return taskId(result.insertId);
}
export async function updateTask(db:TaskDb,t:TenantContext,taskIdValue:string,x:{
 title?:string;description?:string|null;dueAt?:string|null;priority?:string;
 }):Promise<void>{
 const edits:string[]=[];const args:(string|number|null)[]=[];
 if(x.title!==undefined){edits.push('title=?');args.push(x.title);}
 if(x.description!==undefined){edits.push('description=?');args.push(x.description);}
 if(x.dueAt!==undefined){edits.push('due_at=?');args.push(x.dueAt);}
 if(x.priority!==undefined){edits.push('priority=?');args.push(x.priority);}
 if(edits.length===0)throw AppError.badRequest();
 edits.push('updated_at=GREATEST(UTC_TIMESTAMP(3),DATE_ADD(updated_at,INTERVAL 1 MICROSECOND))');
 const [result]=await db.execute<ResultSetHeader>(`UPDATE tasks SET ${edits.join(',')}
 WHERE company_id=? AND id=? AND lead_id IS NULL AND status='open'`,
 [...args,t.companyId,taskIdValue]);
 if(result.affectedRows!==1)throw AppError.conflict();
}
export async function completeTask(db:TaskDb,t:TenantContext,taskIdValue:string):Promise<void>{
 const [result]=await db.execute<ResultSetHeader>(`UPDATE tasks
 SET status='completed',completed_at=UTC_TIMESTAMP(3),
 updated_at=GREATEST(UTC_TIMESTAMP(3),DATE_ADD(updated_at,INTERVAL 1 MICROSECOND))
 WHERE company_id=? AND id=? AND lead_id IS NULL AND status='open'`,
 [t.companyId,taskIdValue]);
 if(result.affectedRows!==1)throw AppError.conflict();
}
export async function auditTask(db:TaskDb,t:TenantContext,id:string,
 action:string,details:object):Promise<void>{
 await db.execute(`INSERT INTO audit_logs
 (company_id,actor_user_id,action,entity_type,entity_id,outcome,details_json,occurred_at)
 VALUES (?,?,?,'task',?,'success',?,UTC_TIMESTAMP(3))`,
 [t.companyId,t.actorUserId,action,id,JSON.stringify(details)]);
}
