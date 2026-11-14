import { Router, type Router as ExpressRouter } from "express";
import { authorize } from "../../../core/permissions/authorize";
import { createPicklistWriteController } from "../controllers/picklist.write.controller";
import type { PicklistWriteDependencies } from "../services/picklist.write.service";

/** Mount only inside authenticated, verified CRM tenant routes. */
export function createPicklistWriteRouter(dependencies: PicklistWriteDependencies = {}): ExpressRouter {
  const router = Router();
  const controller = createPicklistWriteController(dependencies);
  router.post("/customization/options", authorize("customization.leads.picklists.manage"), controller.create);
  router.patch("/customization/options/:optionId", authorize("customization.leads.picklists.manage"), controller.revise);
  return router;
}