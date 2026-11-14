import type {Response} from 'express';
import {getDbPool} from '../../../core/database/pool';
import {getTenantContext} from '../../../core/tenant/tenantContext';
import {AppError} from '../../../core/errors/AppError';
import {allowTaskRead,allowTaskWrite} from '../policies/task.policy';
import {requirePermission} from '../../../core/permissions/policies';
import {taskId,taskListQuery,createTaskBody,patchTaskBody,completeTaskBody} from '../schemas/task.schema';
import {taskView} from '../mappers/task.mapper';
import {type TaskDb,listGeneralTasks,getGeneralTask,assertAssignee,assertLinkedRecords,
 assertTaskActor,insertTask,updateTask,completeTask,auditTask} from '../repositories/task.repository';

export interface TaskServiceDependencies {
 readonly connectionFactory?:()=>Promise<TaskDb>;
 readonly beforeCommit?:()=>Promise<void>|void;
}
export function createTaskService(deps:TaskServiceDependencies={}) {
 const factory=deps.connectionFactory??(()=>getDbPool().getConnection());
 async function transaction<T>(run:(db:TaskDb)=>Promise<T>):Promise<T>{
  const db=await factory();let active=false;let committing=false;let destroy=false;
  try {
   await db.beginTransaction();active=true;
   const result=await run(db);
   await deps.beforeCommit?.();
   committing=true;await db.commit();committing=false;active=false;
   return result;
  }catch(error){
   if(committing)destroy=true;
   else if(active){try{await db.rollback();}catch{destroy=true;}}
   throw error;
  }finally {if(destroy)db.destroy();else db.release();}
 }
 return Object.freeze({
  async list(res:Response,query:Record<string,unknown>){
   const t=getTenantContext(res);allowTaskRead(t);
   const q=taskListQuery(query);
   const db=await factory();
   try{const data=await listGeneralTasks(db,t,q);return {items:data.rows.map(taskView),hasMore:data.hasMore};}
   finally{db.release();}
  },
  async get(res:Response,rawId:unknown){
   const t=getTenantContext(res);allowTaskRead(t);
   const id=taskId(rawId);
   const db=await factory();
   try{return taskView(await getGeneralTask(db,t,id));}
   finally{db.release();}
  },
  async create(res:Response,body:unknown){
   const t=getTenantContext(res);allowTaskWrite(t);
   const data=createTaskBody(body);
   const ownerUserId=data.ownerUserId??t.actorUserId;
   if(data.dealId!==null)requirePermission(t,'deals.read');
   return transaction(async db=>{
    await assertTaskActor(db,t);
    await assertAssignee(db,t,ownerUserId);
    await assertLinkedRecords(db,t,ownerUserId,data.dealId,data.contactId);
    const id=await insertTask(db,t,{...data,ownerUserId});
    await auditTask(db,t,id,'task.created',{ownerUserId,linkedDeal:!!data.dealId,linkedContact:!!data.contactId});
    return taskView(await getGeneralTask(db,t,id));
   });
  },
  async patch(res:Response,rawId:unknown,body:unknown){
   const t=getTenantContext(res);allowTaskWrite(t);
   const id=taskId(rawId);const data=patchTaskBody(body);
   return transaction(async db=>{
    await assertTaskActor(db,t);
    const current=await getGeneralTask(db,t,id,true);
    if(current.status!=='open'||current.revision!==data.expectedRevision)throw AppError.conflict();
    // Check current team ownership again before mutation.
    await assertAssignee(db,t,String(current.owner_user_id));
    await updateTask(db,t,id,{
     title:data.title,description:data.description,
     dueAt:data.dueAt,priority:data.priority,
    });
    await auditTask(db,t,id,'task.updated',{changed:Object.keys(data).filter(k=>k!=='expectedRevision'&&data[k as keyof typeof data]!==undefined)});
    return taskView(await getGeneralTask(db,t,id));
   });
  },
  async complete(res:Response,rawId:unknown,body:unknown){
   const t=getTenantContext(res);allowTaskWrite(t);
   const id=taskId(rawId);const data=completeTaskBody(body);
   return transaction(async db=>{
    await assertTaskActor(db,t);
    const current=await getGeneralTask(db,t,id,true);
    if(current.status!=='open'||current.revision!==data.expectedRevision)throw AppError.conflict();
    await assertAssignee(db,t,String(current.owner_user_id));
    await completeTask(db,t,id);
    await auditTask(db,t,id,'task.completed',{ownerUserId:String(current.owner_user_id)});
    return taskView(await getGeneralTask(db,t,id));
   });
  },
 });
}
