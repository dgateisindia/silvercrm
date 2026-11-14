import { Router, type Router as ExpressRouter } from "express";
import { createSavedViewController } from "../controllers/saved_views.controller";
import type { SavedViewServiceDependencies } from "../services/saved_views.service";

/** Mount exclusively behind verified CRM session and tenant middleware. */
export function createSavedViewRouter(dependencies: SavedViewServiceDependencies = {}): ExpressRouter {
  const router = Router();
  const controller = createSavedViewController(dependencies);
  router.get("/customization/views/:entityType", controller.list);
  router.post("/customization/views", controller.create);
  router.patch("/customization/views/:viewId", controller.revise);
  return router;
}