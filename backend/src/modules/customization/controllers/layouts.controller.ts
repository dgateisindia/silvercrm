import type { RequestHandler } from "express";
import { AppError } from "../../../core/errors/AppError";
import { createLayoutService, type LayoutServiceDependencies } from "../services/layouts.service";

function noQuery(url: string) {
  if (new URL(url, "http://localhost").searchParams.size !== 0) throw AppError.badRequest();
}

/** All routes are mounted behind a verified CRM session and tenant boundary. */
export function createLayoutController(dependencies: LayoutServiceDependencies = {}) {
  const service = createLayoutService(dependencies);
  const getPage: RequestHandler = async (req, res, next) => {
    try { noQuery(req.originalUrl); res.status(200).json({ success: true, data: await service.getPage(res, req.params.pageKey) }); }
    catch (error) { next(error); }
  };
  const putCompanyPage: RequestHandler = async (req, res, next) => {
    try { noQuery(req.originalUrl); res.status(200).json({ success: true, data: await service.putCompanyPage(res, req.params.pageKey, req.body) }); }
    catch (error) { next(error); }
  };
  const putPersonalPage: RequestHandler = async (req, res, next) => {
    try { noQuery(req.originalUrl); res.status(200).json({ success: true, data: await service.putPersonalPage(res, req.params.pageKey, req.body) }); }
    catch (error) { next(error); }
  };
  const getDashboards: RequestHandler = async (req, res, next) => {
    try { noQuery(req.originalUrl); res.status(200).json({ success: true, data: await service.getDashboards(res) }); }
    catch (error) { next(error); }
  };
  const postDashboard: RequestHandler = async (req, res, next) => {
    try { noQuery(req.originalUrl); res.status(201).json({ success: true, data: await service.postDashboard(res, req.body) }); }
    catch (error) { next(error); }
  };
  const patchDashboard: RequestHandler = async (req, res, next) => {
    try { noQuery(req.originalUrl); res.status(200).json({ success: true, data: await service.patchDashboard(res, req.params.layoutId, req.body) }); }
    catch (error) { next(error); }
  };
  return Object.freeze({ getPage, putCompanyPage, putPersonalPage, getDashboards, postDashboard, patchDashboard });
}