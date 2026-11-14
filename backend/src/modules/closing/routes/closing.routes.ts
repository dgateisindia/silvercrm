import { Router, type Router as ExpressRouter, type RequestHandler, type Request, type Response, type NextFunction } from 'express';
import { authorize } from '../../../core/permissions/authorize';
import { AppError } from '../../../core/errors/AppError';
import { createClosingService, type ClosingDependencies } from '../services/closing.service';

export function createClosingRouter(deps:ClosingDependencies={}):ExpressRouter {
  const router=Router(), service=createClosingService(deps);
  function handler(fn:(req:Request,res:Response)=>Promise<unknown>,status=200):RequestHandler {
    return async(req,res,next)=>{
      try{
        if(Object.keys(req.query).length) throw AppError.badRequest();
        const data=await fn(req,res);
        res.status(status).json({success:true,data});
      }catch(error){next(error);}
    };
  }
  const formatHandler=(fn:(req:Request,res:Response)=>Promise<{format:'json';data:unknown}|{format:'csv';csv:string}>,allowed:string[]):RequestHandler=>{
    return async(req,res,next)=>{
      try{
        if(Object.keys(req.query).some(key=>!allowed.includes(key))) throw AppError.badRequest();
        const output=await fn(req,res);
        if(output.format==='csv') res.status(200).type('text/csv; charset=utf-8').send(output.csv);
        else res.status(200).json({success:true,data:output.data});
      }catch(error){next(error);}
    };
  };
  router.post('/operations/targets/:targetId/carry-forward',authorize('deals.update'),
    handler((req,res)=>service.carry(res,req.params.targetId,req.body),201));
  router.patch('/finance/refund-requests/:refundId/review',authorize('deals.update'),
    handler((req,res)=>service.refund(res,req.params.refundId,req.body)));
  router.get('/operations/reports/target-performance',authorize('deals.read'),
    formatHandler((req,res)=>service.performance(res,req.query.from,req.query.to,req.query.format),['from','to','format']));
  router.get('/operations/reports/invoice-aging',authorize('deals.read'),
    formatHandler((req,res)=>service.aging(res,req.query.format),['format']));
  return router;
}