import {Router,type Router as ExpressRouter,type RequestHandler} from 'express';
import {authorize} from '../../core/permissions/authorize';
import {AppError} from '../../core/errors/AppError';
import {createWorkforceService,type WorkforceDependencies} from './workforce.service';

export function createWorkforceRouter(deps:WorkforceDependencies={}):ExpressRouter{
 const router=Router(),service=createWorkforceService(deps);
 function handle(action:(req:Parameters<RequestHandler>[0],res:Parameters<RequestHandler>[1])=>Promise<unknown>,status=200):RequestHandler{
  return async(req,res,next)=>{try{
   if(Object.keys(req.query).length&&req.method!=='GET')throw AppError.badRequest();
   const result=await action(req,res);
   res.status(status).json({success:true,data:result});
  }catch(err){next(err);}};
 }
 router.get('/operations/calendar',authorize('leads.read'),handle((req,res)=>service.events(res,req.query)));
 router.post('/operations/calendar',authorize('leads.update'),handle((req,res)=>service.eventCreate(res,req.body),201));
 router.patch('/operations/calendar/:eventId/cancel',authorize('leads.update'),handle((req,res)=>service.eventCancel(res,req.params.eventId)));
 router.get('/operations/absences',authorize('leads.read'),handle((req,res)=>service.absences(res,req.query)));
 router.post('/operations/absences',authorize('leads.update'),handle((req,res)=>service.absenceCreate(res,req.body),201));
 router.patch('/operations/absences/:absenceId/cancel',authorize('leads.update'),handle((req,res)=>service.absenceCancel(res,req.params.absenceId)));
 router.get('/operations/coverage',authorize('leads.read'),handle((req,res)=>service.coverages(res,req.query)));
 router.post('/operations/coverage',authorize('leads.update'),handle((req,res)=>service.coverageCreate(res,req.body),201));
 return router;
}