import type { RequestHandler } from "express";
import { AppError } from "../../../core/errors/AppError";
import { createSavedViewService, type SavedViewServiceDependencies } from "../services/saved_views.service";

function noQuery(originalUrl: string): void {
  if (new URL(originalUrl, "http://localhost").searchParams.size !== 0) throw AppError.badRequest();
}

/** Thin HTTP handlers: tenant isolation and permissions remain enforced by the service. */
export function createSavedViewController(dependencies: SavedViewServiceDependencies = {}) {
  const service = createSavedViewService(dependencies);
  const list: RequestHandler = async (req, res, next) => {
    try {
      noQuery(req.originalUrl);
      res.status(200).json({ success: true, data: await service.list(res, req.params.entityType) });
    } catch (error) { next(error); }
  };
  const create: RequestHandler = async (req, res, next) => {
    try {
      noQuery(req.originalUrl);
      res.status(201).json({ success: true, data: await service.create(res, req.body) });
    } catch (error) { next(error); }
  };
  const revise: RequestHandler = async (req, res, next) => {
    try {
      noQuery(req.originalUrl);
      res.status(200).json({ success: true, data: await service.revise(res, req.params.viewId, req.body) });
    } catch (error) { next(error); }
  };
  return Object.freeze({ list, create, revise });
}