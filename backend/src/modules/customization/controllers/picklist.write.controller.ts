import type { RequestHandler } from "express";
import { createPicklistWriteService, type PicklistWriteDependencies } from "../services/picklist.write.service";

/** HTTP adapter; authorization, validation, and SQL are owned by lower layers. */
export function createPicklistWriteController(dependencies: PicklistWriteDependencies = {}) {
  const service = createPicklistWriteService(dependencies);
  const create: RequestHandler = async (req, res, next) => {
    try {
      const result = await service.create(res, req.body);
      res.status(201).json({ success: true, data: result });
    } catch (error) { next(error); }
  };
  const revise: RequestHandler = async (req, res, next) => {
    try {
      const result = await service.revise(res, req.params.optionId, req.body);
      res.status(200).json({ success: true, data: result });
    } catch (error) { next(error); }
  };
  return Object.freeze({ create, revise });
}