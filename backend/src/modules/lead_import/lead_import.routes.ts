import {Router,type Router as ExpressRouter,type RequestHandler} from 'express';
import {authorize} from '../../core/permissions/authorize';
import {AppError} from '../../core/errors/AppError';
import {createLeadImportService,type LeadImportDependencies} from './lead_import.service';
export function createLeadBulkImportRouter(deps:LeadImportDependencies={}):ExpressRouter{
 const router=Router(),service=createLeadImportService(deps);
 function handle(fn:(req:Parameters<RequestHandler>[0],res:Parameters<RequestHandler>[1])=>Promise<unknown>,status=200):RequestHandler{
  return async(req,res,next)=>{try{if(Object.keys(req.query).length)throw AppError.badRequest();const data=await fn(req,res);res.status(status).json({success:true,data});}catch(error){next(error);}};
 }
 router.post('/imports/leads/preview',authorize('leads.update'),handle((req,res)=>service.preview(res,req.body)));
 router.post('/imports/leads/commit',authorize('leads.update'),handle((req,res)=>service.commit(res,req.body),201));
 router.get('/imports/leads/:importId',authorize('leads.read'),handle((req,res)=>service.status(res,req.params.importId)));
 return router;
}