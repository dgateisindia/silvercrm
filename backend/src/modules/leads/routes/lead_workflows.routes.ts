import {Router,type Router as ExpressRouter,type RequestHandler} from "express";
import {authorize} from "../../../core/permissions/authorize";
import {AppError} from "../../../core/errors/AppError";
import {boundedLimit} from "../schemas/lead_workflows.schema";
import {createLeadWorkflowsService,type WorkflowDependencies} from "../services/lead_workflows.service";

/** Mounted only inside verified CRM tenant routes. */
export function createLeadWorkflowsRouter(deps:WorkflowDependencies={}):ExpressRouter {
 const router=Router(),service=createLeadWorkflowsService(deps);
 const wrap=(handler:(req:Parameters<RequestHandler>[0],res:Parameters<RequestHandler>[1])=>Promise<unknown>,code=200):RequestHandler=>(req,res,next)=>{
   if(Object.keys(req.query).some(k=>k!=="limit")) {next(AppError.badRequest());return;}
   Promise.resolve().then(()=>handler(req,res)).then(data=>res.status(code).json({success:true,data})).catch(next);
 };
 // Literal routes before parameter routes. Query inputs are strictly allowlisted.
 router.get("/leads/insights/status-counts",authorize("leads.read"),wrap((req,res)=>{
  if(Object.keys(req.query).length) throw AppError.badRequest();
  return service.status(res);
 }));
 router.get("/leads/transfer-requests/pending",authorize("leads.read"),wrap((req,res)=>service.pending(res,boundedLimit(req.query.limit,100))));
 router.post("/leads/:leadId/transfer-requests",authorize("leads.update"),wrap((req,res)=>{
  if(Object.keys(req.query).length) throw AppError.badRequest();
  return service.request(res,req.params.leadId,req.body);
 },201));
 router.patch("/leads/transfer-requests/:requestId/decision",authorize("leads.update"),wrap((req,res)=>{
  if(Object.keys(req.query).length) throw AppError.badRequest();
  return service.decision(res,req.params.requestId,req.body);
 }));
 router.get("/leads/:leadId/followups",authorize("leads.read"),wrap((req,res)=>service.followups(res,req.params.leadId,boundedLimit(req.query.limit,100))));
 router.post("/leads/:leadId/followups",authorize("leads.update"),wrap((req,res)=>{
  if(Object.keys(req.query).length) throw AppError.badRequest();
  return service.createFollowup(res,req.params.leadId,req.body);
 },201));
 router.patch("/leads/:leadId/followups/:taskId/complete",authorize("leads.update"),wrap((req,res)=>{
  if(Object.keys(req.query).length|| (req.body!==undefined&&req.body!==null&&Object.keys(req.body).length)) throw AppError.badRequest();
  return service.finishFollowup(res,req.params.leadId,req.params.taskId);
 }));
 router.get("/leads/:leadId/timeline",authorize("leads.read"),wrap((req,res)=>service.timeline(res,req.params.leadId,boundedLimit(req.query.limit,100))));
 router.get("/leads/:leadId/possible-duplicates",authorize("leads.read"),wrap((req,res)=>service.duplicates(res,req.params.leadId,boundedLimit(req.query.limit,50))));
 return router;
}