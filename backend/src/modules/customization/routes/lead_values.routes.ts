import { Router, type Router as ExpressRouter } from "express";
import { authorize } from "../../../core/permissions/authorize";
import { createLeadValuesController } from "../controllers/lead_values.controller";
import type { LeadValuesServiceDependencies } from "../services/lead_values.service";

/** Mount ONLY inside the verified authenticated CRM tenant boundary. */
export function createLeadValuesRouter(dependencies: LeadValuesServiceDependencies = {}): ExpressRouter {
  const router = Router();
  const controller = createLeadValuesController(dependencies);
  router.get("/leads/:leadId/custom-fields", authorize("leads.read"), controller.list);
  router.put("/leads/:leadId/custom-fields/:fieldKey", authorize("leads.update"), controller.put);
  return router;
}