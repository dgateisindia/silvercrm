import type {Response} from 'express';
import {getDbPool} from '../../core/database/pool';
import {getTenantContext} from '../../core/tenant/tenantContext';
import {requirePermission} from '../../core/permissions/policies';
import {AppError} from '../../core/errors/AppError';
import {id,teamCreate,teamChange,membershipBody,statusBody,invitePreview,listQuery} from './staff_admin.schema';
import {type Db,listStaff,listTeams,listMembers,createTeam,changeManager,addMember,removeMember,changeStatus,previewInvite} from './staff_admin.repository';

export interface StaffAdminDependencies{readonly connectionFactory?:()=>Promise<Db>;readonly beforeWrite?:(event:string)=>Promise<void>|void;}
export function createStaffAdminService(deps:StaffAdminDependencies={}){
 const factory=deps.connectionFactory??(()=>getDbPool().getConnection());
 async function tx<T>(cb:(db:Db)=>Promise<T>):Promise<T>{
  const db=await factory();let started=false,committing=false,destroy=false;
  try{
   await db.beginTransaction();started=true;
   const result=await cb(db);
   committing=true;await db.commit();committing=false;started=false;
   return result;
  }catch(err){
   if(committing)destroy=true;
   else if(started){try{await db.rollback();}catch{destroy=true;}}
   if(err&&typeof err==='object'&&'code' in err&&err.code==='ER_DUP_ENTRY')throw AppError.conflict();
   throw err;
  }finally{if(destroy)db.destroy();else db.release();}
 }
 async function read<T>(cb:(db:Db)=>Promise<T>):Promise<T>{const db=await factory();try{return await cb(db);}finally{db.release();}}
 function tenant(res:Response,write=false){
  const t=getTenantContext(res);
  requirePermission(t,'leads.read');
  if(write&&t.accessMode!=='FULL')throw AppError.forbidden();
  return t;
 }
 return Object.freeze({
  staff:(res:Response,q:Record<string,unknown>)=>{const t=tenant(res);const limit=listQuery(q);return read(db=>listStaff(db,t,limit));},
  teams:(res:Response,q:Record<string,unknown>)=>{const t=tenant(res);const limit=listQuery(q);return read(db=>listTeams(db,t,limit));},
  members:(res:Response,rawTeam:unknown,q:Record<string,unknown>)=>{const t=tenant(res);const teamId=id(rawTeam);const limit=listQuery(q);return read(db=>listMembers(db,t,teamId,limit));},
  teamCreate:(res:Response,body:unknown)=>{const t=tenant(res,true),x=teamCreate(body);return tx(async db=>{const r=await createTeam(db,t,x);await deps.beforeWrite?.('staff.team.create');return r;});},
  teamManager:(res:Response,teamId:unknown,body:unknown)=>{const t=tenant(res,true),key=id(teamId),x=teamChange(body);return tx(async db=>{const r=await changeManager(db,t,key,x);await deps.beforeWrite?.('staff.team.manager');return r;});},
  memberAdd:(res:Response,teamId:unknown,body:unknown)=>{const t=tenant(res,true),key=id(teamId),x=membershipBody(body);return tx(async db=>{const r=await addMember(db,t,key,x.userId);await deps.beforeWrite?.('staff.member.add');return r;});},
  memberRemove:(res:Response,teamId:unknown,userId:unknown)=>{const t=tenant(res,true),teamKey=id(teamId),userKey=id(userId);return tx(async db=>{const r=await removeMember(db,t,teamKey,userKey);await deps.beforeWrite?.('staff.member.remove');return r;});},
  userStatus:(res:Response,userId:unknown,body:unknown)=>{const t=tenant(res,true),key=id(userId),x=statusBody(body);return tx(async db=>{const r=await changeStatus(db,t,key,x);await deps.beforeWrite?.('staff.user.status');return r;});},
  invitationPreview:(res:Response,body:unknown)=>{const t=tenant(res,true),x=invitePreview(body);return read(db=>previewInvite(db,t,x));},
 });
}