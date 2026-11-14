import type {PoolConnection,RowDataPacket,ResultSetHeader} from 'mysql2/promise';
import type {TenantContext} from '../../core/tenant/tenantContext';
import {AppError} from '../../core/errors/AppError';
import {id} from './workforce.schema';

export type Db=Pick<PoolConnection,'execute'|'beginTransaction'|'commit'|'rollback'|'release'|'destroy'>;
interface User extends RowDataPacket {id:string|number|bigint;role:string;status:string;}
interface Lead extends RowDataPacket {id:string|number|bigint;owner_user_id:string|number|bigint;}
interface Absence extends RowDataPacket {id:string|number|bigint;user_id:string|number|bigint;start_at:string;end_at:string;status:string;}
interface Coverage extends RowDataPacket {id:string|number|bigint;lead_id:string|number|bigint;request_id:string|number|bigint|null;original_owner_id:string|number|bigint;cover_user_id:string|number|bigint;status:string;starts_at:string;ends_at:string;}
interface Event extends RowDataPacket {id:string|number|bigint;organizer_user_id:string|number|bigint;status:string;}

export async function actorCanManage(db:Db,t:TenantContext,userId:string):Promise<boolean>{
 if(t.role==='OWNER')return true;
 if(userId===t.actorUserId)return true;
 if(t.role!=='MANAGER')return false;
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT tm.user_id FROM team_members tm
  INNER JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id
  WHERE tm.company_id=? AND tm.user_id=? AND tm.left_at IS NULL
   AND tm.joined_at<=UTC_TIMESTAMP(3) AND te.status='active' AND te.manager_user_id=? LIMIT 1`,[t.companyId,userId,t.actorUserId]);
 return rows.length>0;
}
async function validUser(db:Db,t:TenantContext,userId:string):Promise<User>{
 const [rows]=await db.execute<User[]>(`SELECT id,role,status FROM users WHERE company_id=? AND id=? LIMIT 1 FOR UPDATE`,[t.companyId,userId]);
 if(!rows[0]||rows[0].status!=='active')throw AppError.notFound();
 return rows[0];
}
async function readLead(db:Db,t:TenantContext,leadId:string):Promise<Lead>{
 const [rows]=await db.execute<Lead[]>(`SELECT id,owner_user_id FROM leads WHERE company_id=? AND id=? LIMIT 1 FOR UPDATE`,[t.companyId,leadId]);
 if(!rows[0]||!(await actorCanManage(db,t,id(rows[0].owner_user_id))))throw AppError.notFound();
 return rows[0];
}
async function audit(db:Db,t:TenantContext,action:string,entityType:string,entityId:string,details:object){
 await db.execute(`INSERT INTO audit_logs(company_id,actor_user_id,action,entity_type,entity_id,outcome,request_id,details_json,occurred_at)
 VALUES(?,?,?, ?,?,'success',NULL,?,UTC_TIMESTAMP(3))`,[t.companyId,t.actorUserId,action,entityType,entityId,JSON.stringify(details)]);
}
async function systemAudit(db:Db,companyId:string,action:string,entityId:string,details:object){
 await db.execute(`INSERT INTO audit_logs(company_id,actor_user_id,action,entity_type,entity_id,outcome,request_id,details_json,occurred_at)
 VALUES(?,NULL,?,'lead',?,'success',NULL,?,UTC_TIMESTAMP(3))`,[companyId,action,entityId,JSON.stringify(details)]);
}
export async function createEvent(db:Db,t:TenantContext,x:{title:string;organizerUserId:string|null;leadId:string|null;contactId:string|null;start:string;end:string}){
 const organizer=x.organizerUserId??t.actorUserId;
 if(!(await actorCanManage(db,t,organizer)))throw AppError.notFound();
 await validUser(db,t,organizer);
 if(x.leadId)await readLead(db,t,x.leadId);
 if(x.contactId){
  const [contacts]=await db.execute<RowDataPacket[]>(`SELECT owner_user_id FROM contacts WHERE company_id=? AND id=? LIMIT 1`,[t.companyId,x.contactId]);
  if(!contacts[0]||contacts[0].owner_user_id===null||!(await actorCanManage(db,t,id(contacts[0].owner_user_id))))throw AppError.notFound();
 }
 const [clash]=await db.execute<RowDataPacket[]>(`SELECT id FROM calendar_events WHERE company_id=? AND organizer_user_id=?
 AND status='scheduled' AND starts_at<? AND ends_at>? LIMIT 1 FOR UPDATE`,[t.companyId,organizer,x.end,x.start]);
 if(clash.length)throw AppError.conflict();
 const [r]=await db.execute<ResultSetHeader>(`INSERT INTO calendar_events(company_id,title,organizer_user_id,lead_id,contact_id,starts_at,ends_at,status)
 VALUES(?,?,?,?,?,?,?,'scheduled')`,[t.companyId,x.title,organizer,x.leadId,x.contactId,x.start,x.end]);
 const eventId=id(r.insertId);
 await audit(db,t,'calendar.event_created','calendar_event',eventId,{organizerUserId:organizer,leadId:x.leadId,contactId:x.contactId});
 return {eventId,organizerUserId:organizer,status:'scheduled'};
}
export async function cancelEvent(db:Db,t:TenantContext,eventId:string){
 const [rows]=await db.execute<Event[]>(`SELECT id,organizer_user_id,status FROM calendar_events WHERE company_id=? AND id=? LIMIT 1 FOR UPDATE`,[t.companyId,eventId]);
 const event=rows[0];
 if(!event||!(await actorCanManage(db,t,id(event.organizer_user_id))))throw AppError.notFound();
 if(event.status!=='scheduled')throw AppError.conflict();
 await db.execute(`UPDATE calendar_events SET status='canceled' WHERE company_id=? AND id=?`,[t.companyId,eventId]);
 await audit(db,t,'calendar.event_canceled','calendar_event',eventId,{});
 return {eventId,status:'canceled'};
}
export async function listEvents(db:Db,t:TenantContext,q:{from:string|null;to:string|null;limit:number}){
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT e.id,e.title,e.organizer_user_id AS organizerUserId,e.status,
 DATE_FORMAT(e.starts_at,'%Y-%m-%dT%H:%i:%s.%f') AS startsAt,
 DATE_FORMAT(e.ends_at,'%Y-%m-%dT%H:%i:%s.%f') AS endsAt,e.lead_id AS leadId,e.contact_id AS contactId
 FROM calendar_events e WHERE e.company_id=?
 AND (? IS NULL OR e.starts_at>=?) AND (? IS NULL OR e.starts_at<?)
 AND (?='OWNER' OR e.organizer_user_id=? OR (?='MANAGER' AND EXISTS(
 SELECT 1 FROM team_members tm INNER JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id
 WHERE tm.company_id=e.company_id AND tm.user_id=e.organizer_user_id AND tm.left_at IS NULL
 AND tm.joined_at<=UTC_TIMESTAMP(3) AND te.status='active' AND te.manager_user_id=?)))
 ORDER BY e.starts_at DESC,e.id DESC LIMIT ?`,[t.companyId,q.from,q.from,q.to,q.to,t.role,t.actorUserId,t.role,t.actorUserId,q.limit]);
 return {items:rows.map(x=>({...x,id:id(x.id),organizerUserId:id(x.organizerUserId),leadId:x.leadId===null?null:id(x.leadId),contactId:x.contactId===null?null:id(x.contactId)}))};
}
export async function createAbsence(db:Db,t:TenantContext,x:{userId:string|null;reason:string|null;start:string;end:string}){
 const user=x.userId??t.actorUserId;
 if(!(await actorCanManage(db,t,user)))throw AppError.notFound();
 const profile=await validUser(db,t,user);
 if(profile.role!=='employee')throw AppError.badRequest();
 const [conflicts]=await db.execute<RowDataPacket[]>(`SELECT id FROM employee_absences WHERE company_id=? AND user_id=?
 AND status IN ('planned','approved','active') AND start_at<? AND end_at>? LIMIT 1 FOR UPDATE`,[t.companyId,user,x.end,x.start]);
 if(conflicts.length)throw AppError.conflict();
 const [r]=await db.execute<ResultSetHeader>(`INSERT INTO employee_absences(company_id,user_id,start_at,end_at,reason,status)
 VALUES(?,?,?,?,?,'planned')`,[t.companyId,user,x.start,x.end,x.reason]);
 const absenceId=id(r.insertId);
 await audit(db,t,'absence.created','employee_absence',absenceId,{userId:user});
 return {absenceId,userId:user,status:'planned'};
}
export async function cancelAbsence(db:Db,t:TenantContext,absenceId:string){
 const [rows]=await db.execute<Absence[]>(`SELECT id,user_id,status FROM employee_absences WHERE company_id=? AND id=? LIMIT 1 FOR UPDATE`,[t.companyId,absenceId]);
 const abs=rows[0];
 if(!abs||!(await actorCanManage(db,t,id(abs.user_id))))throw AppError.notFound();
 if(!['planned','approved'].includes(abs.status))throw AppError.conflict();
 const [assigned]=await db.execute<RowDataPacket[]>(`SELECT id FROM lead_coverage_assignments WHERE company_id=? AND original_owner_id=?
 AND status IN ('scheduled','active') AND starts_at<(SELECT end_at FROM employee_absences WHERE company_id=? AND id=?)
 AND ends_at>(SELECT start_at FROM employee_absences WHERE company_id=? AND id=?) LIMIT 1 FOR UPDATE`,
 [t.companyId,abs.user_id,t.companyId,absenceId,t.companyId,absenceId]);
 if(assigned.length)throw AppError.conflict();
 await db.execute(`UPDATE employee_absences SET status='canceled' WHERE company_id=? AND id=?`,[t.companyId,absenceId]);
 await audit(db,t,'absence.canceled','employee_absence',absenceId,{});
 return {absenceId,status:'canceled'};
}
export async function listAbsences(db:Db,t:TenantContext,q:{from:string|null;to:string|null;limit:number}){
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT a.id,a.user_id AS userId,a.status,a.reason,
 DATE_FORMAT(a.start_at,'%Y-%m-%dT%H:%i:%s.%f') AS startsAt,
 DATE_FORMAT(a.end_at,'%Y-%m-%dT%H:%i:%s.%f') AS endsAt
 FROM employee_absences a WHERE a.company_id=? AND (? IS NULL OR a.end_at>?) AND (? IS NULL OR a.start_at<?)
 AND (?='OWNER' OR a.user_id=? OR (?='MANAGER' AND EXISTS(
 SELECT 1 FROM team_members tm INNER JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id
 WHERE tm.company_id=a.company_id AND tm.user_id=a.user_id AND tm.left_at IS NULL
 AND tm.joined_at<=UTC_TIMESTAMP(3) AND te.status='active' AND te.manager_user_id=?)))
 ORDER BY a.start_at DESC,a.id DESC LIMIT ?`,[t.companyId,q.from,q.from,q.to,q.to,t.role,t.actorUserId,t.role,t.actorUserId,q.limit]);
 return {items:rows.map(x=>({...x,id:id(x.id),userId:id(x.userId)}))};
}
export async function scheduleCoverage(db:Db,t:TenantContext,x:{leadId:string;absenceId:string;coverUserId:string;start:string;end:string}){
 const lead=await readLead(db,t,x.leadId),owner=id(lead.owner_user_id);
 if(owner===x.coverUserId)throw AppError.badRequest();
 const [absences]=await db.execute<Absence[]>(`SELECT id,user_id,status FROM employee_absences
 WHERE company_id=? AND id=? AND start_at<=? AND end_at>=? LIMIT 1 FOR UPDATE`,[t.companyId,x.absenceId,x.start,x.end]);
 const abs=absences[0];
 if(!abs||id(abs.user_id)!==owner||!['planned','approved','active'].includes(abs.status))throw AppError.notFound();
 const original=await validUser(db,t,owner),cover=await validUser(db,t,x.coverUserId);
 if(original.role!=='employee'||cover.role!=='employee')throw AppError.badRequest();
 const [team]=await db.execute<RowDataPacket[]>(`SELECT a.user_id FROM teams te
 JOIN team_members a ON a.company_id=te.company_id AND a.team_id=te.id
 JOIN team_members b ON b.company_id=te.company_id AND b.team_id=te.id
 WHERE te.company_id=? AND te.manager_user_id=? AND te.status='active'
 AND a.user_id=? AND b.user_id=? AND a.left_at IS NULL AND b.left_at IS NULL
 AND a.joined_at<=UTC_TIMESTAMP(3) AND b.joined_at<=UTC_TIMESTAMP(3) LIMIT 1`,[t.companyId,t.actorUserId,owner,x.coverUserId]);
 if(!team.length)throw AppError.notFound();
 const [coverAbsences]=await db.execute<RowDataPacket[]>(`SELECT id FROM employee_absences WHERE company_id=? AND user_id=?
 AND status IN ('planned','approved','active') AND start_at<? AND end_at>? LIMIT 1`,[t.companyId,x.coverUserId,x.end,x.start]);
 if(coverAbsences.length)throw AppError.conflict();
 const [existing]=await db.execute<RowDataPacket[]>(`SELECT id FROM lead_coverage_assignments WHERE company_id=? AND lead_id=?
 AND status IN ('scheduled','active') AND starts_at<? AND ends_at>? LIMIT 1 FOR UPDATE`,[t.companyId,x.leadId,x.end,x.start]);
 if(existing.length)throw AppError.conflict();
 const [tr]=await db.execute<ResultSetHeader>(`INSERT INTO lead_transfer_requests(company_id,requested_by_id,from_user_id,to_user_id,
 transfer_type,request_mode,status,reason,decided_by_id,decided_at)
 VALUES(?,?,?,?,'temporary','manager_direct','approved','Employee leave coverage',?,UTC_TIMESTAMP(3))`,
 [t.companyId,t.actorUserId,owner,x.coverUserId,t.actorUserId]);
 const transferId=id(tr.insertId);
 await db.execute(`INSERT INTO lead_transfer_request_items(company_id,request_id,lead_id,decision) VALUES(?,?,?,'approved')`,
 [t.companyId,transferId,x.leadId]);
 const [r]=await db.execute<ResultSetHeader>(`INSERT INTO lead_coverage_assignments(company_id,lead_id,request_id,original_owner_id,cover_user_id,starts_at,ends_at,status)
 VALUES(?,?,?,?,?,?,?,'scheduled')`,[t.companyId,x.leadId,transferId,owner,x.coverUserId,x.start,x.end]);
 const coverageId=id(r.insertId);
 await audit(db,t,'coverage.scheduled','lead',x.leadId,{coverageId,transferId,absenceId:x.absenceId,originalOwnerId:owner,coverUserId:x.coverUserId});
 return {coverageId,transferId,leadId:x.leadId,originalOwnerId:owner,coverUserId:x.coverUserId,status:'scheduled'};
}
export async function listCoverage(db:Db,t:TenantContext,limit:number){
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT c.id,c.lead_id AS leadId,c.original_owner_id AS originalOwnerId,c.cover_user_id AS coverUserId,c.status,
 DATE_FORMAT(c.starts_at,'%Y-%m-%dT%H:%i:%s.%f') AS startsAt,
 DATE_FORMAT(c.ends_at,'%Y-%m-%dT%H:%i:%s.%f') AS endsAt
 FROM lead_coverage_assignments c WHERE c.company_id=? AND
 (?='OWNER' OR c.original_owner_id=? OR c.cover_user_id=? OR (?='MANAGER' AND EXISTS(
 SELECT 1 FROM team_members tm INNER JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id
 WHERE tm.company_id=c.company_id AND tm.user_id=c.original_owner_id AND tm.left_at IS NULL
 AND tm.joined_at<=UTC_TIMESTAMP(3) AND te.status='active' AND te.manager_user_id=?)))
 ORDER BY c.id DESC LIMIT ?`,[t.companyId,t.role,t.actorUserId,t.actorUserId,t.role,t.actorUserId,limit]);
 return {items:rows.map(x=>({...x,id:id(x.id),leadId:id(x.leadId),originalOwnerId:id(x.originalOwnerId),coverUserId:id(x.coverUserId)}))};
}
export async function nextDueCoverage(db:Db):Promise<{companyId:string;coverageId:string}|null>{
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT c.id,c.company_id FROM lead_coverage_assignments c
 INNER JOIN companies co ON co.id=c.company_id AND co.status='active'
 WHERE (c.status='scheduled' AND c.starts_at<=UTC_TIMESTAMP(3))
    OR (c.status='active' AND c.ends_at<=UTC_TIMESTAMP(3))
 ORDER BY c.id LIMIT 1`,[]);
 return rows[0]?{companyId:id(rows[0].company_id),coverageId:id(rows[0].id)}:null;
}
export async function processCoverage(db:Db,companyId:string,coverageId:string):Promise<'activated'|'restored'|'skipped'|'superseded'|'none'>{
 const [rows]=await db.execute<Coverage[]>(`SELECT id,lead_id,request_id,original_owner_id,cover_user_id,status,
 DATE_FORMAT(starts_at,'%Y-%m-%d %H:%i:%s.%f') AS starts_at,
 DATE_FORMAT(ends_at,'%Y-%m-%d %H:%i:%s.%f') AS ends_at
 FROM lead_coverage_assignments WHERE company_id=? AND id=? LIMIT 1 FOR UPDATE`,[companyId,coverageId]);
 const cov=rows[0];if(!cov||!['scheduled','active'].includes(cov.status))return 'none';
 const leadId=id(cov.lead_id),owner=id(cov.original_owner_id),cover=id(cov.cover_user_id);
 const [requests]=await db.execute<RowDataPacket[]>(`SELECT requested_by_id FROM lead_transfer_requests
 WHERE company_id=? AND id=? AND transfer_type='temporary' AND request_mode='manager_direct'
 AND status='approved' LIMIT 1`,[companyId,cov.request_id]);
 const assignedBy=requests[0]?id(requests[0].requested_by_id):null;
 if(!assignedBy)throw Error('INVALID_COVERAGE_REQUEST_LINK');
 const [leads]=await db.execute<Lead[]>(`SELECT id,owner_user_id FROM leads WHERE company_id=? AND id=? LIMIT 1 FOR UPDATE`,[companyId,leadId]);
 const current=leads[0]?id(leads[0].owner_user_id):null;
 if(cov.status==='scheduled'){
  const [due]=await db.execute<RowDataPacket[]>(`SELECT (starts_at<=UTC_TIMESTAMP(3)) AS started,
   (ends_at<=UTC_TIMESTAMP(3)) AS expired FROM lead_coverage_assignments WHERE company_id=? AND id=? LIMIT 1`,[companyId,coverageId]);
  const startState=due[0]; if(!startState)throw Error('COVERAGE_STATE_MISSING'); if(!Number(startState.started))return 'none';
  let valid=current===owner&&!Number(startState.expired);
  if(valid){
   const [abs]=await db.execute<RowDataPacket[]>(`SELECT id FROM employee_absences WHERE company_id=? AND user_id=? AND status IN ('planned','approved','active')
   AND start_at<=? AND end_at>=? LIMIT 1`,[companyId,owner,cov.starts_at,cov.ends_at]);
   const [eligible]=await db.execute<RowDataPacket[]>(`SELECT te.id FROM teams te JOIN team_members a ON a.company_id=te.company_id AND a.team_id=te.id
    JOIN team_members b ON b.company_id=te.company_id AND b.team_id=te.id
    JOIN users ua ON ua.company_id=te.company_id AND ua.id=a.user_id AND ua.status='active'
    JOIN users ub ON ub.company_id=te.company_id AND ub.id=b.user_id AND ub.status='active'
    JOIN users mgr ON mgr.company_id=te.company_id AND mgr.id=te.manager_user_id AND mgr.status='active' AND mgr.role='manager'
    WHERE te.company_id=? AND te.status='active' AND te.manager_user_id=? AND a.user_id=? AND b.user_id=?
     AND a.left_at IS NULL AND b.left_at IS NULL AND a.joined_at<=UTC_TIMESTAMP(3) AND b.joined_at<=UTC_TIMESTAMP(3)
     LIMIT 1`,[companyId,assignedBy,owner,cover]);
   const [busy]=await db.execute<RowDataPacket[]>(`SELECT id FROM employee_absences WHERE company_id=? AND user_id=? AND status IN ('planned','approved','active')
    AND start_at<? AND end_at>? LIMIT 1`,[companyId,cover,cov.ends_at,cov.starts_at]);
   valid=abs.length>0&&eligible.length>0&&!busy.length;
  }
  if(!valid){
   await db.execute(`UPDATE lead_coverage_assignments SET status='skipped' WHERE company_id=? AND id=?`,[companyId,coverageId]);
   await systemAudit(db,companyId,'coverage.skipped',leadId,{coverageId});
   return 'skipped';
  }
  await db.execute(`UPDATE leads SET owner_user_id=?,assigned_at=UTC_TIMESTAMP(3),updated_at=GREATEST(DATE_ADD(updated_at,INTERVAL 1000 MICROSECOND),UTC_TIMESTAMP(3))
   WHERE company_id=? AND id=?`,[cover,companyId,leadId]);
  await db.execute(`UPDATE lead_coverage_assignments SET status='active' WHERE company_id=? AND id=?`,[companyId,coverageId]);
  await db.execute(`INSERT INTO assignment_history(company_id,entity_type,entity_id,from_user_id,to_user_id,assigned_by_user_id,reason,happened_at)
   VALUES(?,'lead',?,?,?,?,'Temporary leave coverage activated',UTC_TIMESTAMP(3))`,[companyId,leadId,owner,cover,assignedBy]);
  await systemAudit(db,companyId,'coverage.activated',leadId,{coverageId,originalOwnerId:owner,coverUserId:cover});
  return 'activated';
 }
 const [ended]=await db.execute<RowDataPacket[]>(`SELECT (ends_at<=UTC_TIMESTAMP(3)) AS finished FROM lead_coverage_assignments WHERE company_id=? AND id=?`,[companyId,coverageId]);
 const endState=ended[0]; if(!endState)throw Error('COVERAGE_STATE_MISSING'); if(!Number(endState.finished))return 'none';
 if(current===cover){
  const [original]=await db.execute<RowDataPacket[]>(`SELECT u.id FROM users u
    JOIN team_members tm ON tm.company_id=u.company_id AND tm.user_id=u.id AND tm.left_at IS NULL AND tm.joined_at<=UTC_TIMESTAMP(3)
    JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id AND te.status='active' AND te.manager_user_id=?
    WHERE u.company_id=? AND u.id=? AND u.status='active' LIMIT 1`,[assignedBy,companyId,owner]);
  if(!original.length){
   await db.execute(`UPDATE lead_coverage_assignments SET status='superseded' WHERE company_id=? AND id=?`,[companyId,coverageId]);
   await systemAudit(db,companyId,'coverage.manual_review',leadId,{coverageId,reason:'original_owner_inactive'});
   return 'superseded';
  }
  await db.execute(`UPDATE leads SET owner_user_id=?,assigned_at=UTC_TIMESTAMP(3),updated_at=GREATEST(DATE_ADD(updated_at,INTERVAL 1000 MICROSECOND),UTC_TIMESTAMP(3)) WHERE company_id=? AND id=?`,[owner,companyId,leadId]);
  await db.execute(`UPDATE lead_coverage_assignments SET status='restored',restored_at=UTC_TIMESTAMP(3) WHERE company_id=? AND id=?`,[companyId,coverageId]);
  await db.execute(`INSERT INTO assignment_history(company_id,entity_type,entity_id,from_user_id,to_user_id,assigned_by_user_id,reason,happened_at)
   VALUES(?,'lead',?,?,?,?,'Temporary leave coverage ended',UTC_TIMESTAMP(3))`,[companyId,leadId,cover,owner,assignedBy]);
  await systemAudit(db,companyId,'coverage.restored',leadId,{coverageId,originalOwnerId:owner});
  return 'restored';
 }
 await db.execute(`UPDATE lead_coverage_assignments SET status='superseded' WHERE company_id=? AND id=?`,[companyId,coverageId]);
 await systemAudit(db,companyId,'coverage.superseded',leadId,{coverageId});
 return 'superseded';
}