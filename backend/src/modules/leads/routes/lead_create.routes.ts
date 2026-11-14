import {
  Router,
  type Router as ExpressRouter,
  type RequestHandler,
} from "express";

import {
  authorize,
} from "../../../core/permissions/authorize";

import {
  AppError,
} from "../../../core/errors/AppError";

import {
  createLeadCreationService,
  type LeadCreateDependencies,
} from "../services/lead_create.service";

/**
 * Mount within authenticated CRM tenant routes.
 *
 * Lead and custom values are saved atomically.
 */
export function createLeadCreationRouter(
  deps: LeadCreateDependencies = {}
): ExpressRouter {
  const router = Router();

  const service =
    createLeadCreationService(deps);

  const create: RequestHandler = async (
    req,
    res,
    next
  ) => {
    try {
      if (Object.keys(req.query).length) {
        throw AppError.badRequest();
      }

      const data = await service.create(
        res,
        req.body
      );

      res.status(201).json({
        success: true,
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  router.post(
    "/leads",
    authorize("leads.update"),
    create
  );

  return router;
}
