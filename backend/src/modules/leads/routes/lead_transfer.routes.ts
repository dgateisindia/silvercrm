import {
  Router,
  type Router as ExpressRouter,
  type RequestHandler,
} from "express";

import { authorize } from "../../../core/permissions/authorize";
import { AppError } from "../../../core/errors/AppError";

import {
  createDirectTransferService,
  type DirectTransferDependencies,
} from "../services/lead_transfer.service";

export function createDirectTransferRouter(
  deps: DirectTransferDependencies = {}
): ExpressRouter {
  const router = Router();

  const service = createDirectTransferService(deps);

  const handler: RequestHandler = async (req, res, next) => {
    try {
      if (Object.keys(req.query).length) {
        throw AppError.badRequest();
      }

      const data = await service.transfer(
        res,
        req.params.leadId,
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
    "/leads/:leadId/transfer-direct",
    authorize("leads.update"),
    handler
  );

  return router;
}