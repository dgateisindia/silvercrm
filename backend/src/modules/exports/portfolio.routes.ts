import {Router,type Router as ExpressRouter} from 'express';
import {authorize} from '../../core/permissions/authorize';
import {createPortfolioExportService,type PortfolioExportDeps} from './portfolio.service';
import type {PortfolioEntity} from './portfolio.repository';

export function createPortfolioExportRouter(deps:PortfolioExportDeps={}):ExpressRouter {
  const router=Router();
  const service=createPortfolioExportService(deps);
  router.get('/exports/portfolio/jobs',authorize('leads.read'),async(req,res,next)=>{
    try {res.setHeader('Cache-Control','no-store');res.status(200).json({
      success:true,data:await service.history(res,req.query),
    });}catch(error){next(error);}
  });
  const entries:[PortfolioEntity,'leads.read'|'deals.read'][]=[
    ['accounts','leads.read'],['contacts','leads.read'],['deals','deals.read'],
  ];
  for(const [entity,permission] of entries) {
    router.get(`/exports/portfolio/${entity}`,authorize(permission),async(req,res,next)=>{
      try {
        const output=await service.download(res,entity,req.query);
        res.setHeader('Cache-Control','no-store');
        res.setHeader('X-Content-Type-Options','nosniff');
        res.setHeader('X-CRM-Export-Job-Id',output.jobId);
        res.setHeader('X-CRM-Export-Has-More',String(output.hasMore));
        if(output.format==='CSV'){
          res.setHeader('Content-Type','text/csv; charset=utf-8');
          res.setHeader('Content-Disposition',`attachment; filename="crm-${entity}.csv"`);
        } else {
          res.setHeader('Content-Type','application/json; charset=utf-8');
          res.setHeader('Content-Disposition',`attachment; filename="crm-${entity}.json"`);
        }
        res.status(200).send(output.bytes);
      }catch(error){next(error);}
    });
  }
  return router;
}