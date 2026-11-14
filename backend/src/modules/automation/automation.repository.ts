import type {PoolConnection,RowDataPacket,ResultSetHeader} from 'mysql2/promise';
import {AppError} from '../../core/errors/AppError';
import type {TenantContext} from '../../core/tenant/tenantContext';
import {DUE_JOB,ESCALATION_JOB,MAX_ATTEMPTS,identifier,reminderKey,parsePayload,type ReminderPayload} from './automation.types';

export type Db=Pick<PoolConnection,'execute'|'beginTransaction'|'commit'|'rollback'|'release'|'destroy'>;
interface Company extends RowDataPacket {id:string|number|bigint;}
interface Task extends RowDataPacket {id:string|number|bigint;owner_user_id:string|number|bigint;dueAt:string;overdue:number|string;}
interface Manager extends RowDataPacket {recipient:string|number|bigint;}
interface Job extends RowDataPacket {id:string|number|bigint;company_id:string|number|bigint;job_type:string;payload_json:string|ReminderPayload;attempts:number|string;}
interface State extends RowDataPacket {id:string|number|bigint;state:string;attempts:number|string;}
interface TaskState extends RowDataPacket {id:string|number|bigint;owner_user_id:string|number|bigint;dueAt:string;status:string;}
interface VisibleJob extends RowDataPacket {id:string|number|bigint;job_type:string;state:string;attempts:number|string;runAfter:string;}

export async function companies(db:Db):Promise<string[]>{
 const [rows]=await db.execute<Company[]>(`SELECT id FROM companies WHERE status='active' ORDER BY id LIMIT 10000`);
 return rows.map(x=>identifier(x.id));
}
async function insertJob(db:Db,companyId:string,payload:ReminderPayload):Promise<number>{
 const kind=payload.kind==='due'?DUE_JOB:ESCALATION_JOB;
 const [row]=await db.execute<ResultSetHeader>(`INSERT INTO crm_background_jobs(company_id,job_type,idempotency_key,payload_json,state,attempts,run_after)
 VALUES(?,?,?,?, 'pending',0,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE id=id`,
 [companyId,kind,reminderKey(companyId,payload),JSON.stringify(payload)]);
 return row.affectedRows===1?1:0;
}
export async function scanCompany(db:Db,companyId:string):Promise<{queued:number;examined:number}>{
 // Serialize tenant scans. No company data is altered by the lock.
 const [companies]=await db.execute<Company[]>(`SELECT id FROM companies WHERE id=? AND status='active' LIMIT 1 FOR UPDATE`,[companyId]);
 if(!companies.length)return {queued:0,examined:0};
 let queued=0,examined=0,cursor='0';
 for(let page=0;page<50;page++){
  const [tasks]=await db.execute<Task[]>(`SELECT t.id,t.owner_user_id,DATE_FORMAT(t.due_at,'%Y-%m-%dT%H:%i:%s.%f') AS dueAt,
    (t.due_at<=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 24 HOUR)) AS overdue
    FROM tasks t INNER JOIN users u ON u.company_id=t.company_id AND u.id=t.owner_user_id
    WHERE t.company_id=? AND t.id>? AND t.status='open' AND t.due_at<=UTC_TIMESTAMP(3) AND u.status='active'
    ORDER BY t.id LIMIT 100`,[companyId,cursor]);
  if(!tasks.length)break;
  for(const t of tasks){
   cursor=identifier(t.id);examined++;
   const owner=identifier(t.owner_user_id),dueAt=t.dueAt;
   queued+=await insertJob(db,companyId,{taskId:cursor,recipientUserId:owner,dueAt,kind:'due'});
   if(Number(t.overdue)===1){
    const [managers]=await db.execute<Manager[]>(`SELECT DISTINCT te.manager_user_id AS recipient
      FROM team_members tm
      INNER JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id
      INNER JOIN users mgr ON mgr.company_id=te.company_id AND mgr.id=te.manager_user_id
      WHERE tm.company_id=? AND tm.user_id=? AND tm.left_at IS NULL AND tm.joined_at<=UTC_TIMESTAMP(3)
       AND te.status='active' AND mgr.status='active' AND mgr.role='manager' ORDER BY recipient LIMIT 30`,[companyId,owner]);
    for(const m of managers){
     const recipient=identifier(m.recipient);
     if(recipient!==owner)queued+=await insertJob(db,companyId,{taskId:cursor,recipientUserId:recipient,dueAt,kind:'escalation'});
    }
   }
  }
  if(tasks.length<100)break;
 }
 return {queued,examined};
}
export async function nextJob(db:Db):Promise<Job|null>{
 const [rows]=await db.execute<Job[]>(`SELECT id,company_id,job_type,payload_json,attempts
   FROM crm_background_jobs WHERE state='pending' AND attempts<? AND run_after<=UTC_TIMESTAMP(3)
   AND job_type IN (?,?) ORDER BY run_after,id LIMIT 1 FOR UPDATE`,[MAX_ATTEMPTS,DUE_JOB,ESCALATION_JOB]);
 return rows[0]??null;
}
export async function deliver(db:Db,job:Job,beforeDelivery?:(payload:ReminderPayload)=>Promise<void>|void):Promise<'delivered'|'skipped'>{
 const companyId=identifier(job.company_id),jobId=identifier(job.id);
 let payload:ReminderPayload;
 try{payload=parsePayload(job.payload_json);}catch{
  await db.execute(`UPDATE crm_background_jobs SET state='failed',attempts=? WHERE company_id=? AND id=?`,[MAX_ATTEMPTS,companyId,jobId]);
  return 'skipped';
 }
 const expectedType=payload.kind==='due'?DUE_JOB:ESCALATION_JOB;
 if(job.job_type!==expectedType){
  await db.execute(`UPDATE crm_background_jobs SET state='failed',attempts=? WHERE company_id=? AND id=?`,[MAX_ATTEMPTS,companyId,jobId]);
  return 'skipped';
 }
 const [tasks]=await db.execute<TaskState[]>(`SELECT t.id,t.status,t.owner_user_id,
   DATE_FORMAT(t.due_at,'%Y-%m-%dT%H:%i:%s.%f') AS dueAt
   FROM tasks t INNER JOIN users r ON r.company_id=t.company_id AND r.id=? AND r.status='active'
   WHERE t.company_id=? AND t.id=? AND t.status='open' AND t.due_at<=UTC_TIMESTAMP(3) LIMIT 1 FOR UPDATE`,
  [payload.recipientUserId,companyId,payload.taskId]);
 const task=tasks[0];
 let eligible=Boolean(task&&task.dueAt===payload.dueAt);
 if(eligible&&payload.kind==='due')eligible=identifier(task!.owner_user_id)===payload.recipientUserId;
 if(eligible&&payload.kind==='escalation'){
  const [scope]=await db.execute<RowDataPacket[]>(`SELECT tm.user_id FROM team_members tm
    INNER JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id AND te.status='active'
    INNER JOIN users mgr ON mgr.company_id=te.company_id AND mgr.id=te.manager_user_id AND mgr.status='active' AND mgr.role='manager'
    WHERE tm.company_id=? AND tm.user_id=? AND tm.left_at IS NULL AND tm.joined_at<=UTC_TIMESTAMP(3)
     AND te.manager_user_id=? AND ?<=DATE_FORMAT(DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 24 HOUR),'%Y-%m-%dT%H:%i:%s.%f') LIMIT 1`,
    [companyId,identifier(task!.owner_user_id),payload.recipientUserId,payload.dueAt]);
  eligible=scope.length>0;
 }
 if(!eligible){
  await db.execute(`UPDATE crm_background_jobs SET state='skipped',attempts=attempts+1 WHERE company_id=? AND id=?`,[companyId,jobId]);
  return 'skipped';
 }
 if(beforeDelivery)await beforeDelivery(payload);
 const isEscalation=payload.kind==='escalation';
 const [n]=await db.execute<ResultSetHeader>(`INSERT INTO notifications(company_id,recipient_user_id,notification_type,title,body)
   VALUES(?,?,?,?,?)`,[companyId,payload.recipientUserId,isEscalation?'followup.escalation':'followup.due',
    isEscalation?'Overdue team follow-up':'Follow-up due',
    isEscalation?`A team follow-up task #${payload.taskId} is overdue.`:`Follow-up task #${payload.taskId} is due.`]);
 const notificationId=identifier(n.insertId);
 await db.execute(`INSERT INTO crm_notification_deliveries(company_id,notification_id,channel,provider_ref,status,attempted_at)
   VALUES(?,?,'in_app',NULL,'delivered',UTC_TIMESTAMP(3))`,[companyId,notificationId]);
 await db.execute(`INSERT INTO audit_logs(company_id,actor_user_id,action,entity_type,entity_id,outcome,request_id,details_json,occurred_at)
   VALUES(? ,NULL,?,'task',?,'success',NULL,?,UTC_TIMESTAMP(3))`,
  [companyId,isEscalation?'automation.followup_escalated':'automation.followup_reminded',payload.taskId,
   JSON.stringify({jobId,notificationId,recipientUserId:payload.recipientUserId,channel:'in_app'})]);
 await db.execute(`UPDATE crm_background_jobs SET state='completed',attempts=attempts+1 WHERE company_id=? AND id=?`,[companyId,jobId]);
 return 'delivered';
}
export async function markFailure(db:Db,jobId:string,companyId:string):Promise<'retry'|'failed'|'ignored'>{
 const [rows]=await db.execute<State[]>(`SELECT id,state,attempts FROM crm_background_jobs WHERE company_id=? AND id=? LIMIT 1 FOR UPDATE`,[companyId,jobId]);
 const item=rows[0];if(!item||item.state!=='pending')return 'ignored';
 const attempts=Number(item.attempts)+1;
 if(attempts>=MAX_ATTEMPTS){
  await db.execute(`UPDATE crm_background_jobs SET state='failed',attempts=? WHERE company_id=? AND id=?`,[attempts,companyId,jobId]);
  return 'failed';
 }
 const delay=Math.min(3600,30*Math.pow(2,attempts-1));
 await db.execute(`UPDATE crm_background_jobs SET attempts=?,run_after=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? SECOND)
    WHERE company_id=? AND id=?`,[attempts,delay,companyId,jobId]);
 return 'retry';
}
export async function listJobs(db:Db,t:TenantContext,limit:number){
 const [rows]=await db.execute<VisibleJob[]>(`SELECT j.id,j.job_type,j.state,j.attempts,
  DATE_FORMAT(j.run_after,'%Y-%m-%dT%H:%i:%s.%f') AS runAfter
  FROM crm_background_jobs j
  WHERE j.company_id=? AND j.job_type IN (?,?)
    AND (
      ?='OWNER'
      OR JSON_UNQUOTE(JSON_EXTRACT(j.payload_json,'$.recipientUserId'))=?
      OR (
        ?='MANAGER' AND EXISTS (
          SELECT 1 FROM team_members tm INNER JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id
          WHERE tm.company_id=j.company_id AND tm.user_id=JSON_UNQUOTE(JSON_EXTRACT(j.payload_json,'$.recipientUserId'))
           AND tm.left_at IS NULL AND tm.joined_at<=UTC_TIMESTAMP(3)
           AND te.status='active' AND te.manager_user_id=?
        )
      )
    ) ORDER BY j.id DESC LIMIT ?`,
   [t.companyId,DUE_JOB,ESCALATION_JOB,t.role,t.actorUserId,t.role,t.actorUserId,limit]);
 return {items:rows.map(x=>({id:identifier(x.id),type:x.job_type,state:x.state,attempts:Number(x.attempts),runAfter:x.runAfter})),limit};
}