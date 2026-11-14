export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  requestId?: string;
  companyId?: string;
  actorId?: string;
  module?: string;
  action?: string;
  errorCode?: string;
  httpMethod?: string;
  route?: string;
  statusCode?: number;
  durationMs?: number;
}

const levels: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let activeLevel: LogLevel = "info";

const stringFields = [
  "requestId",
  "companyId",
  "actorId",
  "module",
  "action",
  "errorCode",
  "httpMethod",
  "route",
] as const;

const numberFields = [
  "statusCode",
  "durationMs",
] as const;

function safeContext(
  context: LogContext
): Record<string, string | number> {
  const result: Record<string, string | number> = {};

  for (const key of stringFields) {
    const value = context[key];

    if (typeof value === "string") {
      result[key] = value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .slice(0, 120);
    }
  }

  for (const key of numberFields) {
    const value = context[key];

    if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = value;
    }
  }

  return result;
}

function safeEvent(event: string): string {
  if (/^[a-z][a-z0-9_.-]{0,79}$/.test(event)) {
    return event;
  }

  return "invalid_log_event";
}

export function setLogLevel(level: LogLevel): void {
  if (!(level in levels)) {
    throw new Error("Invalid log level");
  }

  activeLevel = level;
}

function writeLog(
  level: LogLevel,
  event: string,
  context: LogContext = {}
): void {
  if (levels[level] < levels[activeLevel]) {
    return;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event: safeEvent(event),
    ...safeContext(context),
  };

  const output = JSON.stringify(entry);

  switch (level) {
    case "error":
      console.error(output);
      break;

    case "warn":
      console.warn(output);
      break;

    default:
      console.log(output);
  }
}

export const logger = {
  debug: (event: string, context?: LogContext): void =>
    writeLog("debug", event, context),

  info: (event: string, context?: LogContext): void =>
    writeLog("info", event, context),

  warn: (event: string, context?: LogContext): void =>
    writeLog("warn", event, context),

  error: (event: string, context?: LogContext): void =>
    writeLog("error", event, context),
};
