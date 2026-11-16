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
 r.post("/sales/products",authorize("sales.catalog.manage"),handler((req,res)=>{noQuery(req.query);return service.productCreate(res,req.body);},201));
 r.get("/sales/deals",authorize("deals.read"),handler((req,res)=>service.deals(res,oneLimit(req.query))));
 r.post("/sales/deals",authorize("deals.update"),handler((req,res)=>{noQuery(req.query);return service.dealCreate(res,req.body);},201));
   // STEP13Y4_LINK_ACCOUNT: verified customer account linkage is always explicit.
  r.patch("/sales/deals/:dealId/customer-account",authorize("deals.update"),handler((req,res)=>{noQuery(req.query);return service.dealAccountLink(res,req.params.dealId,req.body);}));
r.get("/sales/deals/:dealId",authorize("deals.read"),handler((req,res)=>{noQuery(req.query);return service.dealGet(res,req.params.dealId);}));
 r.patch("/sales/deals/:dealId/stage",authorize("deals.update"),handler((req,res)=>{noQuery(req.query);return service.stageChange(res,req.params.dealId,req.body);}));
 r.post("/sales/quotations",authorize("deals.update"),handler((req,res)=>{noQuery(req.query);return service.quoteCreate(res,req.body);},201));
 r.get("/sales/quotations",authorize("deals.read"),handler((req,res)=>{if(Object.keys(req.query).some(k=>k!=="limit"&&k!=="before"))throw AppError.badRequest();return service.quoteList(res,req.query.limit,req.query.before);}));
 r.get("/sales/quotations/:quoteId",authorize("deals.read"),handler((req,res)=>{noQuery(req.query);return service.quoteGet(res,req.params.quoteId);}));
 r.get("/sales/insights/pipeline",authorize("deals.read"),handler((req,res)=>{noQuery(req.query);return service.insights(res);}));
 
 function poQuery(q:Record<string,unknown>){if(Object.keys(q).some(k=>k!=='limit'&&k!=='before'))throw AppError.badRequest();return q;}
 r.get('/sales/purchase-orders',authorize('deals.read'),handler((req,res)=>{const q=poQuery(req.query);return service.purchaseOrders(res,q.limit,q.before);}));
 r.get('/sales/purchase-orders/:orderId',authorize('deals.read'),handler((req,res)=>{noQuery(req.query);return service.purchaseOrder(res,req.params.orderId);}));
 r.post('/sales/purchase-orders',authorize('deals.update'),handler((req,res)=>{noQuery(req.query);return service.purchaseOrderCreate(res,req.body);},201));
 return r;
}
