import { Router, type Router as ExpressRouter, type Request, type Response, type NextFunction } from 'express';
import { authorize } from '../../core/permissions/authorize';
import { aiNoQuery } from './ai.conversation.schema';
import { createAiGenerationService, type AiGenerationDependencies } from './ai.generation.service';

export function createAiGenerationRouter(deps: AiGenerationDependencies = {}): ExpressRouter {
  const router = Router();
  const service = createAiGenerationService(deps);
  router.post('/ai/conversations/:conversationId/generate', authorize('leads.update'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        aiNoQuery(req.query);
        const data = await service.generate(res, req.params.conversationId, req.body);
        res.setHeader('Cache-Control', 'no-store');
        res.status(201).json({ success: true, data });
      } catch (error) { next(error); }
    });
  return router;
}
