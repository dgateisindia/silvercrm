import type { RequestHandler } from "express";
import { AppError } from "../../../core/errors/AppError";
import { createLeadValuesService, type LeadValuesServiceDependencies } from "../services/lead_values.service";

/** Thin HTTP adapter: validation and record authorization are always service-enforced. */
export function createLeadValuesController(dependencies: LeadValuesServiceDependencies = {}) {
  const service = createLeadValuesService(dependencies);
  function noQuery(query: Record<string, unknown>) {
    if (Object.keys(query).length !== 0) throw AppError.badRequest();
  }
  const list: RequestHandler = async (req, res, next) => {
    try {
      noQuery(req.query);
      const data = await service.list(res, req.params.leadId);
      res.status(200).json({ success: true, data });
    } catch (error) { next(error); }
  };
  const put: RequestHandler = async (req, res, next) => {
    try {
      noQuery(req.query);
      const data = await service.put(res, req.params.leadId, req.params.fieldKey, req.body);
      res.status(200).json({ success: true, data });
    } catch (error) { next(error); }
  };
  return Object.freeze({ list, put });
}