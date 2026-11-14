import type {Request,Response,NextFunction} from 'express';
import {noQuery} from '../schemas/task.schema';
import {createTaskService,type TaskServiceDependencies} from '../services/task.service';

export function createTaskController(deps:TaskServiceDependencies={}) {
 const service=createTaskService(deps);
 function wrap(fn:(req:Request,res:Response)=>Promise<unknown>,status=200){
  return async(req:Request,res:Response,next:NextFunction)=>{
   try{const data=await fn(req,res);res.setHeader('Cache-Control','no-store');res.status(status).json({success:true,data});}
   catch(error){next(error);}
  };
 }
 return Object.freeze({
  list:wrap((req,res)=>service.list(res,req.query)),
  get:wrap((req,res)=>{noQuery(req.query);return service.get(res,req.params.taskId);}),
  create:wrap((req,res)=>{noQuery(req.query);return service.create(res,req.body);},201),
  patch:wrap((req,res)=>{noQuery(req.query);return service.patch(res,req.params.taskId,req.body);}),
  complete:wrap((req,res)=>{noQuery(req.query);return service.complete(res,req.params.taskId,req.body);}),
 });
}
