import {Router,type Router as ExpressRouter,type RequestHandler} from 'express';
import {authorize} from '../../core/permissions/authorize';
import {AppError} from '../../core/errors/AppError';
import {createAutomationService,type AutomationDependencies} from './automation.service';

export function createAutomationRouter(deps:AutomationDependencies={}):ExpressRouter{
 const router=Router();
 const service=createAutomationService(deps);
 const handler:RequestHandler=async(req,res,next)=>{
  try{
   if(Object.keys(req.query).some(key=>key!=='limit'))throw AppError.badRequest();
   const data=await service.jobs(res,req.query.limit);
   res.status(200).json({success:true,data});
  }catch(error){next(error);}
 };
 router.get('/operations/automation/jobs',authorize('leads.read'),handler);
 return router;
}