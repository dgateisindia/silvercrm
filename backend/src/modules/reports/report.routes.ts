import {Router,type Request,type Response,type NextFunction,type Router as ExpressRouter} from 'express';
import {authorize} from '../../core/permissions/authorize';
import {createActivityReportService,type ActivityReportDependencies} from './report.service';

export function createActivityReportRouter(deps:ActivityReportDependencies={}):ExpressRouter{
 const router=Router();const service=createActivityReportService(deps);
 router.get('/reports/sales-activity',authorize('deals.read'),async(req:Request,res:Response,next:NextFunction)=>{
  try {const data=await service.daily(res,req.query);res.setHeader('Cache-Control','no-store');res.status(200).json({success:true,data});}
  catch(e){next(e);}
 });
 return router;
}
