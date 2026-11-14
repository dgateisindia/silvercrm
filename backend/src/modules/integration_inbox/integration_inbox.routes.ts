import {Router,type Router as ExpressRouter,type RequestHandler} from 'express';
import {authorize} from '../../core/permissions/authorize';
import {AppError} from '../../core/errors/AppError';
import {createIntegrationService,type IntegrationDependencies} from './integration_inbox.service';

export function createIntegrationInboxRouter(deps:IntegrationDependencies={}):ExpressRouter{
 const router=Router();const service=createIntegrationService(deps);
 function handler(fn:(req:Parameters<RequestHandler>[0],res:Parameters<RequestHandler>[1])=>Promise<unknown>,status=200):RequestHandler{
  return async(req,res,next)=>{try{
   if(req.method!=='GET'&&Object.keys(req.query).length)throw AppError.badRequest();
   const data=await fn(req,res);res.status(status).json({success:true,data});
  }catch(error){next(error);}};
 }
 router.get('/integrations/connections',authorize('leads.read'),handler((req,res)=>service.connections(res,req.query)));
 router.post('/integrations/connections',authorize('leads.read'),handler((req,res)=>service.register(res,req.body),201));
 router.get('/integrations/webhook-events',authorize('leads.read'),handler((req,res)=>service.events(res,req.query)));
 router.get('/integrations/inbound-jobs',authorize('leads.read'),handler((req,res)=>service.jobs(res,req.query)));
 // Signed webhook transport is intentionally NOT mounted as a public API here.
 return router;
}