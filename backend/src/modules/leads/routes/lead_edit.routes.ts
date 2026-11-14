import {
  Router,
  type Router as ExpressRouter,
  type RequestHandler,
} from "express";

import {
  authorize,
} from "../../../core/permissions/authorize";

import { AppError } from "../../../core/errors/AppError";

import {
  createLeadEditService,
  type LeadEditDependencies,
} from "../services/lead_edit.service";

export function createLeadEditRouter(
  deps: LeadEditDependencies = {}
): ExpressRouter {
  const router = Router();

  const service = createLeadEditService(deps);

  const get: RequestHandler = async (
    req,
    res,
    next
  ) => {
    try {
      if (Object.keys(req.query).length) {
        throw AppError.badRequest();
      }

      res.status(200).json({
        success: true,
        data: await service.get(
          res,
          req.params.leadId
        ),
      });
    } catch (error) {
      next(error);
    }
  };

  const patch: RequestHandler = async (
    req,
    res,
    next
  ) => {
    try {
      if (Object.keys(req.query).length) {
        throw AppError.badRequest();
      }

      res.status(200).json({
        success: true,
        data: await service.edit(
          res,
          req.params.leadId,
          req.body
        ),
      });
    } catch (error) {
      next(error);
    }
  };

  router.get(
    "/leads/:leadId/edit-state",
    authorize("leads.read"),
    get
  );

  router.patch(
    "/leads/:leadId",
    authorize("leads.update"),
    patch
  );

  return router;
}