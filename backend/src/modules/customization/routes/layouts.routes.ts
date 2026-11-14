import { Router, type Router as ExpressRouter } from "express";
import { createLayoutController } from "../controllers/layouts.controller";
import type { LayoutServiceDependencies } from "../services/layouts.service";

/** All role, tenant, personal ownership and write-permission checks are service enforced. */
export function createLayoutRouter(dependencies: LayoutServiceDependencies = {}): ExpressRouter {
  const router = Router();
  const controller = createLayoutController(dependencies);
  router.get("/customization/layouts/pages/:pageKey", controller.getPage);
  router.put("/customization/layouts/pages/:pageKey/company", controller.putCompanyPage);
  router.put("/customization/layouts/pages/:pageKey/me", controller.putPersonalPage);
  router.get("/customization/layouts/dashboards", controller.getDashboards);
  router.post("/customization/layouts/dashboards", controller.postDashboard);
  router.patch("/customization/layouts/dashboards/:layoutId", controller.patchDashboard);
  return router;
}