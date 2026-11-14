import type {
  RequestHandler,
} from "express";

import {
  createCustomFieldWriteService,
  type CustomFieldWriteDependencies,
} from "../services/customization.write.service";

export interface CustomFieldWriteController {
  readonly create: RequestHandler;
  readonly revise: RequestHandler;
}

/**
 * HTTP adapter for company-defined fields.
 *
 * Authorization and validation are repeated
 * inside the management service.
 *
 * No browser-provided company ID or role
 * is used to authorize database writes.
 */
export function createCustomFieldWriteController(
  dependencies: CustomFieldWriteDependencies = {}
): CustomFieldWriteController {
  const service =
    createCustomFieldWriteService(dependencies);

  const create: RequestHandler = async (
    req,
    res,
    next
  ) => {
    try {
      const result = await service.create(
        res,
        req.body
      );

      res.status(201).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  const revise: RequestHandler = async (
    req,
    res,
    next
  ) => {
    try {
      const result = await service.revise(
        res,
        req.params.fieldId,
        req.body
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  return Object.freeze({
    create,
    revise,
  });
}