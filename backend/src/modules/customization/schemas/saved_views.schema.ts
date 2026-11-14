import { AppError } from "../../../core/errors/AppError";
import { layoutJson } from "./layouts.schema";

export type SavedViewScope = "personal" | "company";

export interface NewSavedView {
  readonly entityType: string;
  readonly name: string;
  readonly scope: SavedViewScope;
  readonly configJson: string;
}

export interface RevisedSavedView {
  readonly name: string;
  readonly scope: SavedViewScope;
  readonly configJson: string;
  readonly expectedName: string;
  readonly expectedScope: SavedViewScope;
  readonly expectedConfigJson: string;
}

function objectOf(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw AppError.badRequest();
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) {
    throw AppError.badRequest();
  }
  return record;
}

export function parseSavedViewEntity(value: unknown): string {
  if (typeof value !== "string" || value.length > 50 || !/^[a-z][a-z0-9_]*$/.test(value)) {
    throw AppError.badRequest();
  }
  return value;
}

export function parseSavedViewId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value) ||
      BigInt(value) > 18446744073709551615n) {
    throw AppError.badRequest();
  }
  return value;
}

function name(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 120) {
    throw AppError.badRequest();
  }
  return value.trim();
}

function scope(value: unknown): SavedViewScope {
  if (value !== "personal" && value !== "company") throw AppError.badRequest();
  return value;
}

/** Entire column, filter and sorting configuration is inert, customer-defined JSON. */
export function parseNewSavedView(value: unknown): NewSavedView {
  const data = objectOf(value, ["entityType", "name", "scope", "config"]);
  return Object.freeze({
    entityType: parseSavedViewEntity(data.entityType),
    name: name(data.name),
    scope: scope(data.scope),
    configJson: layoutJson(data.config),
  });
}

/** An expected-state comparison is required because saved_views has no version_no column. */
export function parseRevisedSavedView(value: unknown): RevisedSavedView {
  const data = objectOf(value, ["name", "scope", "config", "expectedName", "expectedScope", "expectedConfig"]);
  return Object.freeze({
    name: name(data.name),
    scope: scope(data.scope),
    configJson: layoutJson(data.config),
    expectedName: name(data.expectedName),
    expectedScope: scope(data.expectedScope),
    expectedConfigJson: layoutJson(data.expectedConfig),
  });
}