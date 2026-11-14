import {
  Router,
  type Router as ExpressRouter,
} from "express";

import {
  createCustomizationController,
} from "../controllers/customization.controller";

import type {
  CustomizationServiceDependencies,
} from "../services/customization.service";

/**
 * Company-specific CRM customization API.
 *
 * All routes must be mounted behind:
 *
 * - Verified session authentication
 * - Verified CRM tenant identity
 *
 * Feature-level authorization is enforced
 * by the customization service.
 *
 * No fixed forms or status choices are
 * defined inside this router.
 */
export function createCustomizationRouter(
  dependencies: CustomizationServiceDependencies = {}
): ExpressRouter {
  const router = Router();

  const controller =
    createCustomizationController(
      dependencies
    );

  /**
   * Dynamic form metadata.
   *
   * Example:
   * GET /customization/leads/form
   *
   * Optional:
   * ?picklists=status,source_key
   *
   * Customer choices come from MariaDB.
   */
  router.get(
    "/customization/:entityType/form",
    controller.getFormMetadata
  );

  /**
   * Customer-defined fields.
   *
   * GET /customization/:entityType/fields
   */
  router.get(
    "/customization/:entityType/fields",
    controller.listFields
  );

  /**
   * Customer-defined picklist options.
   *
   * GET /customization/:entityType/options/:fieldKey
   *
   * includeInactive=true requires
   * settings-management permission.
   */
  router.get(
    "/customization/:entityType/options/:fieldKey",
    controller.listOptions
  );

  /**
   * No configuration writes are exposed yet.
   *
   * Creating or modifying fields, choices
   * and layouts requires separate authorized,
   * versioned and audited workflows.
   */
  return router;
}