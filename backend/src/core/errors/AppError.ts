const ERROR_DEFINITIONS = {
  BAD_REQUEST: {
    statusCode: 400,
    message: "Invalid request",
  },
  UNAUTHENTICATED: {
    statusCode: 401,
    message: "Authentication required",
  },
  FORBIDDEN: {
    statusCode: 403,
    message: "Access denied",
  },
  NOT_FOUND: {
    statusCode: 404,
    message: "Resource not found",
  },
  CONFLICT: {
    statusCode: 409,
    message: "Resource conflict",
  },
  VALIDATION_ERROR: {
    statusCode: 422,
    message: "Validation failed",
  },
  RATE_LIMITED: {
    statusCode: 429,
    message: "Too many requests",
  },
  INTERNAL_ERROR: {
    statusCode: 500,
    message: "Internal server error",
  },
  SERVICE_UNAVAILABLE: {
    statusCode: 503,
    message: "Service temporarily unavailable",
  },
} as const;

export type ApiErrorCode = keyof typeof ERROR_DEFINITIONS;

export type HttpErrorStatus =
  (typeof ERROR_DEFINITIONS)[ApiErrorCode]["statusCode"];

export interface PublicErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

export class AppError extends Error {
  public readonly code: ApiErrorCode;

  public readonly statusCode: HttpErrorStatus;

  public readonly isOperational = true;

  constructor(
    code: ApiErrorCode,
    message?: string
  ) {
    const definition = ERROR_DEFINITIONS[code];

    // Internal server errors must never expose caller-provided details.
    const publicMessage =
      definition.statusCode >= 500
        ? definition.message
        : message?.trim() || definition.message;

    super(publicMessage);

    this.name = "AppError";
    this.code = code;
    this.statusCode = definition.statusCode;

    Object.setPrototypeOf(this, new.target.prototype);

    Error.captureStackTrace?.(this, AppError);
  }

  public toJSON(): PublicErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
      },
    };
  }

  public static badRequest(message?: string): AppError {
    return new AppError("BAD_REQUEST", message);
  }

  public static unauthenticated(message?: string): AppError {
    return new AppError("UNAUTHENTICATED", message);
  }

  public static forbidden(message?: string): AppError {
    return new AppError("FORBIDDEN", message);
  }

  public static notFound(message?: string): AppError {
    return new AppError("NOT_FOUND", message);
  }

  public static conflict(message?: string): AppError {
    return new AppError("CONFLICT", message);
  }

  public static validation(message?: string): AppError {
    return new AppError("VALIDATION_ERROR", message);
  }

  public static rateLimited(message?: string): AppError {
    return new AppError("RATE_LIMITED", message);
  }

  public static internal(): AppError {
    return new AppError("INTERNAL_ERROR");
  }

  public static serviceUnavailable(): AppError {
    return new AppError("SERVICE_UNAVAILABLE");
  }
}
