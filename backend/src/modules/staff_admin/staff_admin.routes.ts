import {Router,type Router as ExpressRouter,type RequestHandler} from 'express';
import {authorize} from '../../core/permissions/authorize';
import {AppError} from '../../core/errors/AppError';
import {createStaffAdminService,type StaffAdminDependencies} from './staff_admin.service';

export function createStaffAdminRouter(deps:StaffAdminDependencies={}):ExpressRouter{
 const router=Router(),service=createStaffAdminService(deps);
 function handle(action:(req:Parameters<RequestHandler>[0],res:Parameters<RequestHandler>[1])=>Promise<unknown>,status=200):RequestHandler{
  return async(req,res,next)=>{try{
   if(req.method!=='GET'&&Object.keys(req.query).length)throw AppError.badRequest();
   const data=await action(req,res);
   res.status(status).json({success:true,data});
  }catch(err){next(err);}};
 }
 // Authorization remains enforced within every service+repository operation, not only by route guards.
 router.get('/admin/staff',authorize('leads.read'),handle((req,res)=>service.staff(res,req.query)));
 router.get('/admin/teams',authorize('leads.read'),handle((req,res)=>service.teams(res,req.query)));
 router.get('/admin/teams/:teamId/members',authorize('leads.read'),handle((req,res)=>service.members(res,req.params.teamId,req.query)));
 router.post('/admin/teams',authorize('leads.read'),handle((req,res)=>service.teamCreate(res,req.body),201));
 router.patch('/admin/teams/:teamId/manager',authorize('leads.read'),handle((req,res)=>service.teamManager(res,req.params.teamId,req.body)));
 router.post('/admin/teams/:teamId/members',authorize('leads.read'),handle((req,res)=>service.memberAdd(res,req.params.teamId,req.body),201));
 router.patch('/admin/teams/:teamId/members/:userId/remove',authorize('leads.read'),handle((req,res)=>service.memberRemove(res,req.params.teamId,req.params.userId)));
 router.patch('/admin/staff/:userId/status',authorize('leads.read'),handle((req,res)=>service.userStatus(res,req.params.userId,req.body)));
 router.post('/admin/invitations/preview',authorize('leads.read'),handle((req,res)=>service.invitationPreview(res,req.body)));
 return router;
}