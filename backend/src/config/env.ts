import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";

// The same relative path works from src/config and dist/config.
dotenv.config({
  path: path.resolve(__dirname, "../../.env"),
  quiet: true,
});

const portSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535);

const httpUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      const url = new URL(value);

      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    },
    { message: "Must be a valid HTTP or HTTPS URL without credentials" }
  );

const optionalHttpUrlSchema = z
  .union([z.literal(""), httpUrlSchema])
  .default("");

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    PORT: portSchema.default(4001),

    HOST: z.string().trim().min(1).default("127.0.0.1"),

    CORS_ORIGIN: httpUrlSchema.default("http://localhost:5173"),

    DB_HOST: z.string().trim().min(1),

    DB_PORT: portSchema.default(3306),

    DB_USER: z.string().trim().min(1),

    DB_PASSWORD: z.string().default(""),

    DB_NAME: z.string().trim().min(1),

    AUTH_MODE: z.enum(["local", "platform"]).default("local"),

    PLATFORM_API_BASE_URL: optionalHttpUrlSchema,

    PLATFORM_SESSION_VERIFY_URL: optionalHttpUrlSchema,

    PLATFORM_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(30000)
      .default(5000),

    LOG_LEVEL: z
      .enum(["error", "warn", "info", "debug"])
      .default("info"),
  })
  .superRefine((config, context) => {
    // Local authentication must never be enabled in production.
    if (
      config.NODE_ENV === "production" &&
      config.AUTH_MODE === "local"
    ) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_MODE"],
        message: "Local authentication is forbidden in production",
      });
    }

    // Production database connections require a password.
    if (
      config.NODE_ENV === "production" &&
      !config.DB_PASSWORD
    ) {
      context.addIssue({
        code: "custom",
        path: ["DB_PASSWORD"],
        message: "Database password is required in production",
      });
    }

    // Platform mode requires both integration endpoints.
    if (config.AUTH_MODE === "platform") {
      if (!config.PLATFORM_API_BASE_URL) {
        context.addIssue({
          code: "custom",
          path: ["PLATFORM_API_BASE_URL"],
          message: "Platform API URL is required",
        });
      }

      if (!config.PLATFORM_SESSION_VERIFY_URL) {
        context.addIssue({
          code: "custom",
          path: ["PLATFORM_SESSION_VERIFY_URL"],
          message: "Platform verification URL is required",
        });
      }

      // Production integrations must use encrypted transport.
      if (config.NODE_ENV === "production") {
        for (const key of [
          "PLATFORM_API_BASE_URL",
          "PLATFORM_SESSION_VERIFY_URL",
        ] as const) {
          const url = config[key];

          if (url && !url.startsWith("https://")) {
            context.addIssue({
              code: "custom",
              path: [key],
              message: "HTTPS is required in production",
            });
          }
        }
      }
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

const result = environmentSchema.safeParse(process.env);

if (!result.success) {
  const details = result.error.issues
    .map((issue) => {
      const field = issue.path.join(".") || "environment";
      return `${field}: ${issue.message}`;
    })
    .join("; ");

  // Do not include actual environment values or secrets.
  throw new Error(`Invalid CRM environment: ${details}`);
}

export const env: Environment = result.data;
