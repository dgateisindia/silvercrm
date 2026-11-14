import {
  Router,
  type Router as ExpressRouter,
} from "express";

import {
  authorize,
} from "../../../core/permissions/authorize";

import {
  createLeadsController,
  type LeadsControllerDependencies,
} from "../controllers/leads.controller";

/**
 * Create the CRM Leads API router.
 *
 * Must be mounted behind the application's:
 *
 * 1. Verified Platform session middleware
 * 2. Verified CRM tenant identity middleware
 *
 * Each route also independently checks the
 * approved leads.read permission.
 *
 * The controller and service enforce
 * record-level and team-level access.
 */
export function createLeadsRouter(
  dependencies: LeadsControllerDependencies = {}
): ExpressRouter {
  const router = Router();

  const controller =
    createLeadsController(dependencies);

  /**
   * GET /api/v1/crm/leads
   *
   * List authorized leads using cursor
   * pagination and role-specific scope.
   */
  router.get(
    "/leads",
    authorize("leads.read"),
    controller.list
  );

  /**
   * GET /api/v1/crm/leads/:id
   *
   * Read one authorized lead.
   *
   * Missing and inaccessible leads return
   * the same HTTP 404 response.
   */
  router.get(
    "/leads/:id",
    authorize("leads.read"),
    controller.getById
  );

  /**
   * No write endpoints are registered here.
   *
   * Lead creation, editing, assignment,
   * transfer and deletion require separate
   * validated business workflows.
   */
  return router;
}
