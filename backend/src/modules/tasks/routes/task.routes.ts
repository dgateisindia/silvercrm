import {Router,type Router as ExpressRouter} from 'express';
import {authorize} from '../../../core/permissions/authorize';
import {createTaskController} from '../controllers/task.controller';
import type {TaskServiceDependencies} from '../services/task.service';

export function createGeneralTaskRouter(deps:TaskServiceDependencies={}):ExpressRouter {
 const router=Router();const c=createTaskController(deps);
 router.get('/operations/tasks',authorize('leads.read'),c.list);
 router.get('/operations/tasks/:taskId',authorize('leads.read'),c.get);
 router.post('/operations/tasks',authorize('leads.update'),c.create);
 router.patch('/operations/tasks/:taskId',authorize('leads.update'),c.patch);
 router.patch('/operations/tasks/:taskId/complete',authorize('leads.update'),c.complete);
 return router;
}
