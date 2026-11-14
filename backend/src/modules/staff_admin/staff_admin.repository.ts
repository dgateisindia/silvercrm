import type {PoolConnection,RowDataPacket,ResultSetHeader} from 'mysql2/promise';
import type {TenantContext} from '../../core/tenant/tenantContext';
import {AppError} from '../../core/errors/AppError';
import {id} from './staff_admin.schema';

export type Db=Pick<PoolConnection,'execute'|'beginTransaction'|'commit'|'rollback'|'release'|'destroy'>;
interface User extends RowDataPacket {id:string|number|bigint;company_id:string|number|bigint;role:string;status:string;platform_user_id:string;revision:string;}
interface Team extends RowDataPacket {id:string|number|bigint;manager_user_id:string|number|bigint|null;status:string;}
interface Member extends RowDataPacket {id:string|number|bigint;team_id:string|number|bigint;user_id:string|number|bigint;}

async function user(db:Db,t:TenantContext,userId:string,lock=false):Promise<User>{
 const [rows]=await db.execute<User[]>(`SELECT id,company_id,role,status,platform_user_id,
  DATE_FORMAT(updated_at,'%Y-%m-%dT%H:%i:%s.%f') AS revision
  FROM users WHERE company_id=? AND id=? LIMIT 1 ${lock?'FOR UPDATE':''}`,[t.companyId,userId]);
 if(!rows[0])throw AppError.notFound();return rows[0];
}
async function assertActor(db:Db,t:TenantContext):Promise<User>{
 const actor=await user(db,t,t.actorUserId);
 if(actor.status!=='active'||actor.role!==t.role.toLowerCase())throw AppError.forbidden();
 return actor;
}
async function team(db:Db,t:TenantContext,teamId:string,lock=false):Promise<Team>{
 const [rows]=await db.execute<Team[]>(`SELECT id,manager_user_id,status FROM teams
  WHERE company_id=? AND id=? LIMIT 1 ${lock?'FOR UPDATE':''}`,[t.companyId,teamId]);
 if(!rows[0])throw AppError.notFound();return rows[0];
}
async function canAdminTeam(db:Db,t:TenantContext,teamId:string):Promise<Team>{
 const record=await team(db,t,teamId);
 if(t.role==='OWNER'||(t.role==='MANAGER'&&record.manager_user_id!==null&&id(record.manager_user_id)===t.actorUserId))return record;
 throw AppError.notFound();
}
async function canAdminEmployee(db:Db,t:TenantContext,target:string):Promise<void>{
 if(t.role==='OWNER')return;
 if(t.role!=='MANAGER')throw AppError.forbidden();
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT tm.id FROM team_members tm
 INNER JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id
 WHERE tm.company_id=? AND tm.user_id=? AND tm.left_at IS NULL
 AND tm.joined_at<=UTC_TIMESTAMP(3) AND te.status='active' AND te.manager_user_id=? LIMIT 1`,[t.companyId,target,t.actorUserId]);
 if(!rows.length)throw AppError.notFound();
}
async function audit(db:Db,t:TenantContext,action:string,entityType:string,entityId:string,details:object){
 await db.execute(`INSERT INTO audit_logs(company_id,actor_user_id,action,entity_type,entity_id,outcome,request_id,details_json,occurred_at)
 VALUES(?,?,?, ?,?,'success',NULL,?,UTC_TIMESTAMP(3))`,[t.companyId,t.actorUserId,action,entityType,entityId,JSON.stringify(details)]);
}

export async function listStaff(db:Db,t:TenantContext,limit:number){
 await assertActor(db,t);
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT u.id,u.full_name AS fullName,u.email,u.role,u.status,
 DATE_FORMAT(u.updated_at,'%Y-%m-%dT%H:%i:%s.%f') AS revision
 FROM users u WHERE u.company_id=? AND (
   ?='OWNER' OR u.id=? OR (?='MANAGER' AND u.role='employee' AND EXISTS(
     SELECT 1 FROM team_members tm INNER JOIN teams te
       ON te.company_id=tm.company_id AND te.id=tm.team_id
     WHERE tm.company_id=u.company_id AND tm.user_id=u.id AND tm.left_at IS NULL
      AND tm.joined_at<=UTC_TIMESTAMP(3) AND te.status='active' AND te.manager_user_id=?
   ))) ORDER BY u.id DESC LIMIT ?`,[t.companyId,t.role,t.actorUserId,t.role,t.actorUserId,limit]);
 return {items:rows.map(r=>({...r,id:id(r.id)}))};
}
export async function listTeams(db:Db,t:TenantContext,limit:number){
 await assertActor(db,t);
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT te.id,te.name,te.status,te.manager_user_id AS managerUserId
 FROM teams te WHERE te.company_id=? AND (
  ?='OWNER' OR (?='MANAGER' AND te.manager_user_id=?) OR
  (?='EMPLOYEE' AND EXISTS(SELECT 1 FROM team_members tm WHERE tm.company_id=te.company_id
    AND tm.team_id=te.id AND tm.user_id=? AND tm.left_at IS NULL
    AND tm.joined_at<=UTC_TIMESTAMP(3))))
 ORDER BY te.id DESC LIMIT ?`,[t.companyId,t.role,t.role,t.actorUserId,t.role,t.actorUserId,limit]);
 return {items:rows.map(r=>({...r,id:id(r.id),managerUserId:r.managerUserId===null?null:id(r.managerUserId)}))};
}
export async function listMembers(db:Db,t:TenantContext,teamId:string,limit:number){
 await assertActor(db,t);
 await canAdminTeam(db,t,teamId);
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT u.id,u.full_name AS fullName,u.role,u.status,
 DATE_FORMAT(u.updated_at,'%Y-%m-%dT%H:%i:%s.%f') AS revision
 FROM team_members tm INNER JOIN users u ON u.company_id=tm.company_id AND u.id=tm.user_id
 WHERE tm.company_id=? AND tm.team_id=? AND tm.left_at IS NULL AND tm.joined_at<=UTC_TIMESTAMP(3)
 ORDER BY tm.id DESC LIMIT ?`,[t.companyId,teamId,limit]);
 return {items:rows.map(r=>({...r,id:id(r.id)}))};
}
export async function createTeam(db:Db,t:TenantContext,x:{name:string;managerUserId:string}){
 await assertActor(db,t);
 if(t.role!=='OWNER')throw AppError.forbidden();
 const leader=await user(db,t,x.managerUserId,true);
 if(leader.role!=='manager'||leader.status!=='active')throw AppError.badRequest();
 const [r]=await db.execute<ResultSetHeader>(`INSERT INTO teams(company_id,name,manager_user_id,status)
 VALUES(?,?,?,'active')`,[t.companyId,x.name,x.managerUserId]);
 const teamId=id(r.insertId);
 await audit(db,t,'staff.team_created','team',teamId,{managerUserId:x.managerUserId});
 return {teamId,name:x.name,managerUserId:x.managerUserId,status:'active'};
}
export async function changeManager(db:Db,t:TenantContext,teamId:string,x:{managerUserId:string}){
 await assertActor(db,t);
 if(t.role!=='OWNER')throw AppError.forbidden();
 const next=await user(db,t,x.managerUserId,true);
 if(next.role!=='manager'||next.status!=='active')throw AppError.badRequest();
 const current=await team(db,t,teamId,true);
 if(current.status!=='active')throw AppError.conflict();
 if(current.manager_user_id!==null&&id(current.manager_user_id)===x.managerUserId)throw AppError.conflict();
 const before=current.manager_user_id===null?null:id(current.manager_user_id);
 await db.execute(`UPDATE teams SET manager_user_id=? WHERE company_id=? AND id=?`,[x.managerUserId,t.companyId,teamId]);
 await audit(db,t,'staff.team_manager_changed','team',teamId,{previousManagerId:before,managerUserId:x.managerUserId});
 return {teamId,managerUserId:x.managerUserId};
}
export async function addMember(db:Db,t:TenantContext,teamId:string,userId:string){
 await assertActor(db,t);
 if(t.role==='EMPLOYEE')throw AppError.forbidden();
 const target=await user(db,t,userId,true); // lock target first: serializes across different teams
 if(target.role!=='employee'||target.status!=='active')throw AppError.badRequest();
 const selected=await canAdminTeam(db,t,teamId);
 if(selected.status!=='active')throw AppError.conflict();
 const [occupied]=await db.execute<Member[]>(`SELECT id,team_id,user_id FROM team_members
 WHERE company_id=? AND user_id=? AND left_at IS NULL AND joined_at<=UTC_TIMESTAMP(3)
 LIMIT 1 FOR UPDATE`,[t.companyId,userId]);
 if(occupied.length)throw AppError.conflict();
 const [r]=await db.execute<ResultSetHeader>(`INSERT INTO team_members(company_id,team_id,user_id,joined_at)
 VALUES(?,?,?,UTC_TIMESTAMP(3))`,[t.companyId,teamId,userId]);
 const membershipId=id(r.insertId);
 await audit(db,t,'staff.team_member_added','team',teamId,{userId,membershipId});
 return {teamId,userId,membershipId,status:'active'};
}
export async function removeMember(db:Db,t:TenantContext,teamId:string,userId:string){
 await assertActor(db,t);
 if(t.role==='EMPLOYEE')throw AppError.forbidden();
 const target=await user(db,t,userId,true);
 if(target.role!=='employee')throw AppError.badRequest();
 await canAdminTeam(db,t,teamId);
 const [members]=await db.execute<Member[]>(`SELECT id,team_id,user_id FROM team_members
 WHERE company_id=? AND team_id=? AND user_id=? AND left_at IS NULL LIMIT 1 FOR UPDATE`,[t.companyId,teamId,userId]);
 if(!members[0])throw AppError.notFound();
 await ensureUnassigned(db,t,userId);
 await db.execute(`UPDATE team_members SET left_at=UTC_TIMESTAMP(3)
 WHERE company_id=? AND id=? AND left_at IS NULL`,[t.companyId,id(members[0].id)]);
 await audit(db,t,'staff.team_member_removed','team',teamId,{userId});
 return {teamId,userId,status:'removed'};
}
async function ensureUnassigned(db:Db,t:TenantContext,userId:string){
 const [leads]=await db.execute<RowDataPacket[]>(`SELECT id FROM leads WHERE company_id=? AND owner_user_id=? LIMIT 1 FOR UPDATE`,[t.companyId,userId]);
 if(leads.length)throw AppError.conflict();
 const [tasks]=await db.execute<RowDataPacket[]>(`SELECT id FROM tasks WHERE company_id=? AND owner_user_id=? AND status NOT IN ('completed','canceled') LIMIT 1 FOR UPDATE`,[t.companyId,userId]);
 if(tasks.length)throw AppError.conflict();
}
export async function changeStatus(db:Db,t:TenantContext,userId:string,x:{status:'active'|'inactive';expectedRevision:string}){
 await assertActor(db,t);
 if(t.role==='EMPLOYEE'||t.actorUserId===userId)throw AppError.forbidden();
 const target=await user(db,t,userId,true);
 if(target.role==='owner')throw AppError.forbidden();
 if(target.role==='manager'&&t.role!=='OWNER')throw AppError.forbidden();
 if(target.role==='employee')await canAdminEmployee(db,t,userId);
 if(target.status==='pending'||target.status==='suspended'||!target.platform_user_id)throw AppError.conflict();
 if(target.revision!==x.expectedRevision||target.status===x.status)throw AppError.conflict();
 if(x.status==='inactive'){
  if(target.role==='employee')await ensureUnassigned(db,t,userId);
  else{
   const [teams]=await db.execute<RowDataPacket[]>(`SELECT id FROM teams WHERE company_id=? AND manager_user_id=? AND status='active' LIMIT 1 FOR UPDATE`,[t.companyId,userId]);
   if(teams.length)throw AppError.conflict();
  }
 }
 await db.execute(`UPDATE users SET status=?,updated_at=GREATEST(DATE_ADD(updated_at,INTERVAL 1000 MICROSECOND),UTC_TIMESTAMP(3))
 WHERE company_id=? AND id=?`,[x.status,t.companyId,userId]);
 await audit(db,t,'staff.user_status_changed','user',userId,{oldStatus:target.status,newStatus:x.status});
 return {userId,status:x.status};
}
export async function previewInvite(db:Db,t:TenantContext,x:{fullName:string;email:string;role:'manager'|'employee';teamId:string|null}){
 await assertActor(db,t);
 if(t.role==='EMPLOYEE')throw AppError.forbidden();
 if(x.role==='manager'&&t.role!=='OWNER')throw AppError.forbidden();
 if(x.teamId){
  if(x.role!=='employee')throw AppError.badRequest();
  const selected=await canAdminTeam(db,t,x.teamId);
  if(selected.status!=='active')throw AppError.conflict();
 }
 if(t.role==='MANAGER'&&!x.teamId)throw AppError.badRequest();
 const [existing]=await db.execute<RowDataPacket[]>(`SELECT id FROM users
 WHERE company_id=? AND LOWER(email)=? LIMIT 1`,[t.companyId,x.email]);
 if(existing.length)throw AppError.conflict();
 // Preview only: never reserve an identity, generate an invite token, or claim external mail was sent.
 return {fullName:x.fullName,email:x.email,role:x.role,teamId:x.teamId,
         status:'preview_only',platformActionRequired:'CREATE_CLERK_INVITATION_AND_VERIFY_MEMBERSHIP',invitationSent:false};
}