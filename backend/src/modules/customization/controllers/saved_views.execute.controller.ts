import type { RequestHandler } from "express";
import { parseViewQuery } from "../schemas/saved_views.execute.schema";
import { createSavedViewExecutionService, type SavedViewExecutionDependencies } from "../services/saved_views.execute.service";

/** Safe result adapter: query params are validated, tenant identity comes from auth middleware. */
export function createSavedViewExecutionController(deps: SavedViewExecutionDependencies = {}) {
  const service = createSavedViewExecutionService(deps);
  const leads: RequestHandler = async (req, res, next) => {
    try {
      const options = parseViewQuery(req.originalUrl);
      const results = await service.executeLeads(res, req.params.viewId, options);
      res.status(200).json({ success: true, data: results });
    } catch (error) { next(error); }
  };
  return Object.freeze({ leads });
}