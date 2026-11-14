import { Router,type NextFunction,type Request,type Response,type Router as ExpressRouter } from 'express';
import { authorize } from '../../core/permissions/authorize';
import { createAiConversationService,type AiConversationDependencies } from './ai.conversation.service';
export function createAiConversationRouter(deps:AiConversationDependencies={}):ExpressRouter {
  const router=Router();const service=createAiConversationService(deps);
  function handle(action:(req:Request,res:Response)=>Promise<unknown>|unknown,status=200){
    return async(req:Request,res:Response,next:NextFunction)=>{
      try{const data=await action(req,res);res.setHeader('Cache-Control','no-store');res.status(status).json({success:true,data});}
      catch(error){next(error);}
    };
  }
  router.get('/ai/status',authorize('leads.read'),handle((_req,res)=>service.status(res)));
  router.get('/ai/conversations',authorize('leads.read'),handle((req,res)=>service.list(res,req.query)));
  router.post('/ai/conversations',authorize('leads.update'),handle((req,res)=>service.create(res,req.body,req.query),201));
  router.get('/ai/conversations/:conversationId',authorize('leads.read'),
    handle((req,res)=>service.detail(res,req.params.conversationId,req.query)));
  router.get('/ai/conversations/:conversationId/messages',authorize('leads.read'),
    handle((req,res)=>service.messages(res,req.params.conversationId,req.query)));
  return router;
}
