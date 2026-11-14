import { Router, type Router as ExpressRouter } from 'express';
import { authorize } from '../../core/permissions/authorize';
import { createExportService, type ExportDependencies } from './export.service';

export function createCrmExportRouter(deps: ExportDependencies = {}): ExpressRouter {
  const router = Router();
  const service = createExportService(deps);
  router.get('/exports/leads', authorize('leads.read'), async (req,res,next) => {
    try {
      const output = await service.leads(res,req.query);
      res.setHeader('Cache-Control','no-store');
      res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('X-CRM-Export-Job-Id',output.jobId);
      res.setHeader('X-CRM-Export-Has-More',String(output.hasMore));
      if(output.format==='CSV') {
        res.setHeader('Content-Type','text/csv; charset=utf-8');
        res.setHeader('Content-Disposition','attachment; filename="crm-leads.csv"');
      } else {
        res.setHeader('Content-Type','application/json; charset=utf-8');
        res.setHeader('Content-Disposition','attachment; filename="crm-leads.json"');
      }
      res.status(200).send(output.bytes);
    } catch(error) {next(error);}
  });
  router.get('/exports/jobs',authorize('leads.read'),async(req,res,next)=>{
    try {const data=await service.history(res,req.query);res.status(200).json({success:true,data});}
    catch(error){next(error);}
  });
  return router;
}