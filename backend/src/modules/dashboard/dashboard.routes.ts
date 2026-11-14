import {Router,type Request,type Response,type NextFunction,type Router as ExpressRouter} from 'express';
import {authorize} from '../../core/permissions/authorize';
import {createDashboardService,type InsightDependencies} from './dashboard.service';

export function createDashboardOverviewRouter(deps:InsightDependencies={}):ExpressRouter{
 const router=Router();const service=createDashboardService(deps);
 router.get('/dashboard/overview',authorize('dashboard.read'),async(req:Request,res:Response,next:NextFunction)=>{
  try {const data=await service.overview(res,req.query);res.setHeader('Cache-Control','no-store');res.status(200).json({success:true,data});}
  catch(e){next(e);}
 });
 return router;
}
