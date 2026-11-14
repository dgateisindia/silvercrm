import { Router, type Router as ExpressRouter } from "express";
import { authorize } from "../../../core/permissions/authorize";
import { createSavedViewExecutionController } from "../controllers/saved_views.execute.controller";
import type { SavedViewExecutionDependencies } from "../services/saved_views.execute.service";

/** Protected, read-only: a saved view is never an access-control override. */
export function createSavedViewExecutionRouter(deps: SavedViewExecutionDependencies = {}): ExpressRouter {
  const router = Router();
  const controller = createSavedViewExecutionController(deps);
  router.get("/customization/views/:viewId/leads/results", authorize("leads.read"), controller.leads);
  return router;
}