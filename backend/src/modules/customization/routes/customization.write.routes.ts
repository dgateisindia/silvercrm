import {
  Router,
  type Router as ExpressRouter,
} from "express";

import {
  authorize,
} from "../../../core/permissions/authorize";

import {
  createCustomFieldWriteController,
} from "../controllers/customization.write.controller";

import type {
  CustomFieldWriteDependencies,
} from "../services/customization.write.service";

/**
 * Customer-configurable field management.
 *
 * Must be mounted inside the verified
 * CRM authentication and tenant boundary.
 *
 * Permission is checked in both the
 * route and the underlying service.
 */
export function createCustomFieldWriteRouter(
  dependencies: CustomFieldWriteDependencies = {}
): ExpressRouter {
  const router = Router();

  const controller =
    createCustomFieldWriteController(
      dependencies
    );

  router.post(
    "/customization/fields",
    authorize("customization.fields.manage"),
    controller.create
  );

  router.patch(
    "/customization/fields/:fieldId",
    authorize("customization.fields.manage"),
    controller.revise
  );

  return router;
}