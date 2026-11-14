import {Router,type Router as ExpressRouter,type RequestHandler} from 'express';
import {authorize} from '../../../core/permissions/authorize';
import {AppError} from '../../../core/errors/AppError';
import {createCustomerService,type CustomerDependencies} from '../services/customer.service';

export function createCustomerRouter(deps:CustomerDependencies={}):ExpressRouter{
 const router=Router();const service=createCustomerService(deps);
 function handle(call:(req:any,res:any)=>Promise<unknown>,status=200):RequestHandler{
  return async(req,res,next)=>{try{const data=await call(req,res);res.status(status).json({success:true,data});}catch(e){next(e);}};
 }
 function noQuery(q:Record<string,unknown>){if(Object.keys(q).length)throw AppError.badRequest();}
 function getLimit(q:Record<string,unknown>){if(Object.keys(q).some(k=>k!=='limit'))throw AppError.badRequest();return q.limit;}
 router.get('/customers/accounts',authorize('leads.read'),handle((req,res)=>service.accounts(res,getLimit(req.query))));
 router.post('/customers/accounts',authorize('leads.update'),handle((req,res)=>{noQuery(req.query);return service.accountCreate(res,req.body);},201));
 router.get('/customers/accounts/:accountId',authorize('leads.read'),handle((req,res)=>{noQuery(req.query);return service.account(res,req.params.accountId);}));
 router.patch('/customers/accounts/:accountId',authorize('leads.update'),handle((req,res)=>{noQuery(req.query);return service.accountUpdate(res,req.params.accountId,req.body);}));
 router.get('/customers/accounts/:accountId/contacts',authorize('leads.read'),handle((req,res)=>service.fromAccount(res,req.params.accountId,getLimit(req.query))));
 router.get('/customers/contacts',authorize('leads.read'),handle((req,res)=>service.contacts(res,getLimit(req.query))));
 router.post('/customers/contacts',authorize('leads.update'),handle((req,res)=>{noQuery(req.query);return service.contactCreate(res,req.body);},201));
 router.get('/customers/contacts/possible-duplicates',authorize('leads.read'),handle((req,res)=>service.duplicatePreview(res,req.query)));
 router.get('/customers/contacts/:contactId',authorize('leads.read'),handle((req,res)=>{noQuery(req.query);return service.contact(res,req.params.contactId);}));
 router.patch('/customers/contacts/:contactId',authorize('leads.update'),handle((req,res)=>{noQuery(req.query);return service.contactUpdate(res,req.params.contactId,req.body);}));
 router.get('/customers/contacts/:contactId/timeline',authorize('leads.read'),handle((req,res)=>service.history(res,req.params.contactId,getLimit(req.query))));
 router.post('/customers/contacts/:contactId/activities',authorize('leads.update'),handle((req,res)=>{noQuery(req.query);return service.activityCreate(res,req.params.contactId,req.body);},201));
 router.post('/customers/imports/contacts/preview',authorize('leads.update'),handle((req,res)=>{noQuery(req.query);return service.importPreview(res,req.body);}));
 router.post('/customers/imports/contacts/commit',authorize('leads.update'),handle((req,res)=>{noQuery(req.query);return service.importCommit(res,req.body);},201));
 router.get('/customers/imports/:importId',authorize('leads.read'),handle((req,res)=>{noQuery(req.query);return service.importGet(res,req.params.importId);}));
 return router;
}