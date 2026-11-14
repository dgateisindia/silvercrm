import {Router,type Router as ExpressRouter,type RequestHandler} from 'express';
import {authorize} from '../../../core/permissions/authorize';
import {AppError} from '../../../core/errors/AppError';
import {createConversionService,type ConversionDependencies} from '../services/conversion.service';
export function createConversionRouter(deps:ConversionDependencies={}):ExpressRouter{
 const router=Router();const service=createConversionService(deps);
 function handler(call:(req:any,res:any)=>Promise<unknown>,status=200):RequestHandler{
  return async(req,res,next)=>{try{const data=await call(req,res);res.status(status).json({success:true,data});}catch(e){next(e);}};
 }
 function noQuery(q:Record<string,unknown>){if(Object.keys(q).length)throw AppError.badRequest();}
 function limit(q:Record<string,unknown>){if(Object.keys(q).some(k=>k!=='limit'))throw AppError.badRequest();return q.limit;}
 router.get('/leads/:leadId/conversion-state',authorize('leads.read'),handler((req,res)=>{noQuery(req.query);return service.state(res,req.params.leadId);}));
 router.post('/leads/:leadId/convert',authorize('leads.update'),handler((req,res)=>{noQuery(req.query);return service.convert(res,req.params.leadId,req.body);},201));
 router.get('/sales/deals/:dealId/negotiations',authorize('deals.read'),handler((req,res)=>service.negotiationList(res,req.params.dealId,limit(req.query))));
 router.post('/sales/deals/:dealId/negotiations',authorize('deals.update'),handler((req,res)=>{noQuery(req.query);return service.negotiationCreate(res,req.params.dealId,req.body);},201));
 return router;
}