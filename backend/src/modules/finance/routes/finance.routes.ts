import { Router, type Router as ExpressRouter, type RequestHandler } from "express";
import { authorize } from "../../../core/permissions/authorize";
import { AppError } from "../../../core/errors/AppError";
import { createFinanceService, type FinanceDependencies } from "../services/finance.service";
export function createFinanceRouter(deps:FinanceDependencies={}):ExpressRouter {
 const router=Router();const service=createFinanceService(deps);
 function handler(fn:(req:any,res:any)=>Promise<unknown>,status=200):RequestHandler {
  return async(req,res,next)=>{try{if(Object.keys(req.query).length)throw AppError.badRequest();const data=await fn(req,res);res.status(status).json({success:true,data});}catch(e){next(e);}};
 }
 router.get("/sales/quotations/:quoteId/revisions",authorize("deals.read"),handler((req,res)=>service.history(res,req.params.quoteId)));
 router.post("/sales/quotations/:quoteId/revisions",authorize("deals.update"),handler((req,res)=>service.revision(res,req.params.quoteId,req.body),201));
 router.post("/sales/quotations/:quoteId/approve",authorize("deals.update"),handler((req,res)=>service.approval(res,req.params.quoteId,req.body)));
 router.post("/finance/invoices/from-quotation/:quoteId",authorize("deals.update"),handler((req,res)=>service.invoiceDraft(res,req.params.quoteId),201));
 router.get("/finance/invoices/:invoiceId/balance",authorize("deals.read"),handler((req,res)=>service.balance(res,req.params.invoiceId)));
 router.post("/finance/invoices/:invoiceId/issue",authorize("deals.update"),handler((req,res)=>service.issue(res,req.params.invoiceId,req.body)));
 router.post("/finance/invoices/:invoiceId/manual-payments",authorize("deals.update"),handler((req,res)=>service.payment(res,req.params.invoiceId,req.body),201));
 return router;
}
