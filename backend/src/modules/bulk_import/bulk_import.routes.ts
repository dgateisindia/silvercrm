import {Router,type Router as ExpressRouter,type RequestHandler} from 'express';
import {authorize} from '../../core/permissions/authorize';
import {AppError} from '../../core/errors/AppError';
import {createBulkImportService,type BulkImportDependencies} from './bulk_import.service';

export function createBulkImportRouter(deps:BulkImportDependencies={}):ExpressRouter{
 const router=Router(),service=createBulkImportService(deps);
 function handle(fn:(req:Parameters<RequestHandler>[0],res:Parameters<RequestHandler>[1])=>Promise<unknown>,http=200):RequestHandler{
  return async(req,res,next)=>{try{if(Object.keys(req.query).length)throw AppError.badRequest();
   const data=await fn(req,res);res.status(http).json({success:true,data});}catch(err){next(err);}};
 }
 router.post('/imports/leads/bulk/preview',authorize('leads.update'),handle((req,res)=>service.preview(res,req.body)));
 router.post('/imports/leads/bulk/queue',authorize('leads.update'),handle((req,res)=>service.queue(res,req.body),202));
 router.get('/imports/leads/bulk/:importId',authorize('leads.read'),handle((req,res)=>service.status(res,req.params.importId)));
 return router;
}