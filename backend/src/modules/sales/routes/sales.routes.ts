import {Router,type Router as ExpressRouter,type RequestHandler} from "express";
import {authorize} from "../../../core/permissions/authorize";
import {AppError} from "../../../core/errors/AppError";
import {createSalesService,type SalesDependencies} from "../services/sales.service";
export function createSalesRouter(deps:SalesDependencies={}):ExpressRouter{
 const r=Router();const service=createSalesService(deps);
 function handler(fn:(req:any,res:any)=>Promise<unknown>,status=200):RequestHandler {
  return async(req,res,next)=>{try{const data=await fn(req,res);res.status(status).json({success:true,data});}catch(e){next(e);}};
 }
 function noQuery(q:any){if(Object.keys(q).length)throw AppError.badRequest();}
 function oneLimit(q:any){if(Object.keys(q).some(k=>k!=="limit"))throw AppError.badRequest();return q.limit;}
 r.get("/sales/pipelines",authorize("deals.read"),handler((req,res)=>{noQuery(req.query);return service.pipelines(res);}));
 r.post("/sales/pipelines",authorize("settings.manage"),handler((req,res)=>{noQuery(req.query);return service.pipelineCreate(res,req.body);},201));
 r.get("/sales/products",authorize("deals.read"),handler((req,res)=>service.products(res,oneLimit(req.query))));
 r.post("/sales/products",authorize("settings.manage"),handler((req,res)=>{noQuery(req.query);return service.productCreate(res,req.body);},201));
 r.get("/sales/deals",authorize("deals.read"),handler((req,res)=>service.deals(res,oneLimit(req.query))));
 r.post("/sales/deals",authorize("deals.update"),handler((req,res)=>{noQuery(req.query);return service.dealCreate(res,req.body);},201));
 r.get("/sales/deals/:dealId",authorize("deals.read"),handler((req,res)=>{noQuery(req.query);return service.dealGet(res,req.params.dealId);}));
 r.patch("/sales/deals/:dealId/stage",authorize("deals.update"),handler((req,res)=>{noQuery(req.query);return service.stageChange(res,req.params.dealId,req.body);}));
 r.post("/sales/quotations",authorize("deals.update"),handler((req,res)=>{noQuery(req.query);return service.quoteCreate(res,req.body);},201));
 r.get("/sales/quotations/:quoteId",authorize("deals.read"),handler((req,res)=>{noQuery(req.query);return service.quoteGet(res,req.params.quoteId);}));
 r.get("/sales/insights/pipeline",authorize("deals.read"),handler((req,res)=>{noQuery(req.query);return service.insights(res);}));
 return r;
}
