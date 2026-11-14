import { Router,type Request,type Response,type NextFunction,
  type Router as ExpressRouter } from 'express';
import { authorize } from '../../core/permissions/authorize';
import { createInvitationService,type InvitationDependencies } from './invitation.service';

/** Protected by the shared CRM authentication and Platform access middleware. */
export function createStaffInvitationRouter(deps: InvitationDependencies = {}): ExpressRouter {
  const router = Router();
  const service = createInvitationService(deps);
  async function run(req:Request,res:Response,next:NextFunction,
    operation:()=>Promise<unknown>,status=200):Promise<void>{
    try {const data=await operation();res.setHeader('Cache-Control','no-store');
      res.status(status).json({success:true,data});}
    catch(error){next(error);}
  }
  router.get('/admin/invitations',authorize('leads.read'),
    (req:Request,res:Response,next:NextFunction)=>{void run(req,res,next,()=>service.list(res,req.query));});
  router.post('/admin/invitations/send',authorize('leads.read'),
    (req:Request,res:Response,next:NextFunction)=>{void run(req,res,next,()=>service.send(res,req.body),201);});
  router.post('/admin/invitations/:invitationId/revoke',authorize('leads.read'),
    (req:Request,res:Response,next:NextFunction)=>{void run(req,res,next,()=>service.revoke(res,req.params.invitationId));});
  return router;
}
