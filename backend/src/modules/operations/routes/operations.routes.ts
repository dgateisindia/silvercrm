import {Router,type Router as ExpressRouter,type RequestHandler,type Request,type Response,type NextFunction} from 'express';
import {authorize} from '../../../core/permissions/authorize';
import {AppError} from '../../../core/errors/AppError';
import {createOperationsService,type OperationsDependencies} from '../services/operations.service';
export function createOperationsRouter(deps:OperationsDependencies={}):ExpressRouter{
 const router=Router(),s=createOperationsService(deps);
 function handler(fn:(req:any,res:any)=>Promise<unknown>,status=200):RequestHandler{return async(req,res,next)=>{try{if(Object.keys(req.query).length)throw AppError.badRequest();const data=await fn(req,res);res.status(status).json({success:true,data});}catch(e){next(e);}};}
 const financeRead=authorize('deals.read'),financeWrite=authorize('deals.update');const remindersRead=authorize('leads.read');
 router.post('/finance/invoices/:invoiceId/credits',financeWrite,handler((q,r)=>s.credit(r,q.params.invoiceId,q.body),201));
 router.post('/finance/payments/:paymentId/refund-requests',financeWrite,handler((q,r)=>s.refund(r,q.params.paymentId,q.body),201));
 router.post('/finance/invoices/:invoiceId/due-schedules',financeWrite,handler((q,r)=>s.schedule(r,q.params.invoiceId,q.body),201));
 router.get('/finance/invoices/:invoiceId/due-schedules',financeRead,handler((q,r)=>s.scheduleList(r,q.params.invoiceId)));
 router.post('/operations/targets',financeWrite,handler((q,r)=>s.newTarget(r,q.body),201));
 router.get('/operations/targets',financeRead,handler((_q,r)=>s.targets(r)));
 router.get('/operations/targets/:targetId',financeRead,handler((q,r)=>s.target(r,q.params.targetId)));
 router.post('/operations/targets/:targetId/adjustments',financeWrite,handler((q,r)=>s.adjust(r,q.params.targetId,q.body),201));
 router.get('/operations/reports/finance',financeRead,async(req:Request,res:Response,next:NextFunction)=>{try{if(Object.keys(req.query).some(k=>!['from','to','format'].includes(k)))throw AppError.badRequest();const result=await s.report(res,req.query.from,req.query.to,req.query.format);if(result.format==='csv'){res.status(200).type('text/csv; charset=utf-8').send(result.csv);}else{res.status(200).json({success:true,data:result.data});}}catch(e){next(e);}});
 router.get('/operations/reminders/due',remindersRead,handler((_q,r)=>s.reminders(r)));
 router.get('/operations/notifications',remindersRead,handler((_q,r)=>s.notices(r)));
 router.patch('/operations/notifications/:noticeId/read',remindersRead,handler((q,r)=>s.markRead(r,q.params.noticeId)));
 return router;
}