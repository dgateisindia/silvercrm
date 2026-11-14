import { getTenantContext } from "./core/tenant/tenantContext";
import type { Server } from "node:http";

import { env } from "./config/env";

import {
  createCrmApp,
} from "./app";

import { Router } from "express";

import {
  createLeadsRouter,
} from "./modules/leads/routes/leads.routes";

import {
  createCustomizationRouter,
} from "./modules/customization/routes/customization.routes";

import {
  createCustomFieldWriteRouter,
} from "./modules/customization/routes/customization.write.routes";

import {
  createPicklistWriteRouter,
} from "./modules/customization/routes/picklist.write.routes";

import {
  createLayoutRouter,
} from "./modules/customization/routes/layouts.routes";

import {
  createSavedViewRouter,
} from "./modules/customization/routes/saved_views.routes";

import {
  createSavedViewExecutionRouter,
} from "./modules/customization/routes/saved_views.execute.routes";

import {
  createLeadValuesRouter,
} from "./modules/customization/routes/lead_values.routes";

import {
  createLeadCreationRouter,
} from "./modules/leads/routes/lead_create.routes";

import {
  createLeadEditRouter,
} from "./modules/leads/routes/lead_edit.routes";

import {
  createDirectTransferRouter,
} from "./modules/leads/routes/lead_transfer.routes";

import {
  createLeadWorkflowsRouter,
} from "./modules/leads/routes/lead_workflows.routes";

import {
  createSalesRouter,
} from "./modules/sales/routes/sales.routes";

import {
  createFinanceRouter,
} from "./modules/finance/routes/finance.routes";

import {
  createOperationsRouter,
} from "./modules/operations/routes/operations.routes";

import {
  createClosingRouter,
} from "./modules/closing/routes/closing.routes";

import {
  createCustomerRouter,
} from "./modules/customers/routes/customer.routes";

import {
  createConversionRouter,
} from "./modules/conversion/routes/conversion.routes";

import {
  createAutomationRouter,
} from "./modules/automation/automation.routes";

import {
  createWorkforceRouter,
} from "./modules/workforce/workforce.routes";

import {
  createStaffAdminRouter,
} from "./modules/staff_admin/staff_admin.routes";

import {
  createIntegrationInboxRouter,
} from "./modules/integration_inbox/integration_inbox.routes";

import {
  createLeadBulkImportRouter,
} from "./modules/lead_import/lead_import.routes";

import {
  createBulkImportRouter,
} from "./modules/bulk_import/bulk_import.routes";

import {
  createCrmExportRouter,
} from "./modules/exports/export.routes";

import {
  createPortfolioExportRouter,
} from "./modules/exports/portfolio.routes";

import {
  createGeneralTaskRouter,
} from "./modules/tasks/routes/task.routes";

import {
  createDashboardOverviewRouter,
} from "./modules/dashboard/dashboard.routes";

import {
  createActivityReportRouter,
} from "./modules/reports/report.routes";

import {
  createStaffInvitationRouter,
} from "./modules/invitations/invitation.routes";

import {
  createAiConversationRouter,
} from "./modules/ai/ai.conversation.routes";

import {
  createAiGenerationRouter,
} from "./modules/ai/ai.generation.routes";
import { createPlatformAccessGuard } from "./core/platform/platformAccess.guard";

import {
  createDevSessionStore,
  type DevSessionStore,
} from "./core/auth/devSessionVerifier";

import {
  createDevIdentityStore,
  type DevIdentityStore,
} from "./core/auth/devIdentityResolver";

import type {
  VerifiedCrmIdentity,
} from "./core/tenant/tenantContext";

export function createAllProtectedCrmRoutes(): Router {
    const protectedRoutes = Router();

    protectedRoutes.use(createPlatformAccessGuard());

    // DGATE_STEP12B_VERIFIED_SESSION_BEGIN
    // Mounted inside protectedRoutes after platform/tenant authorization middleware.
    protectedRoutes.get('/session/context', (_req, res) => {
      const identity = getTenantContext(res);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        data: {
          role: identity.role,
          accessMode: identity.accessMode,
          actorUserId: identity.actorUserId,
          companyId: identity.companyId,
        },
      });
    });
    // DGATE_STEP12B_VERIFIED_SESSION_END

    protectedRoutes.use(
      createLeadsRouter()
    );

    protectedRoutes.use(
      createCustomizationRouter()
    );

    protectedRoutes.use(
      createCustomFieldWriteRouter()
    );

    protectedRoutes.use(
      createPicklistWriteRouter()
    );

    protectedRoutes.use(
      createLayoutRouter()
    );

    protectedRoutes.use(
      createSavedViewRouter()
    );

    protectedRoutes.use(
      createSavedViewExecutionRouter()
    );

    protectedRoutes.use(
      createLeadValuesRouter()
    );

    protectedRoutes.use(
      createLeadCreationRouter()
    );

    protectedRoutes.use(
      createLeadEditRouter()
    );

    protectedRoutes.use(
      createDirectTransferRouter()
    );

    protectedRoutes.use(
      createLeadWorkflowsRouter()
    );

    protectedRoutes.use(
      createSalesRouter()
    );

    protectedRoutes.use(
      createFinanceRouter()
    );

    protectedRoutes.use(
      createOperationsRouter()
    );

    protectedRoutes.use(
      createClosingRouter()
    );

    protectedRoutes.use(
      createCustomerRouter()
    );

    protectedRoutes.use(
      createConversionRouter()
    );

    protectedRoutes.use(
      createAutomationRouter()
    );

    protectedRoutes.use(
      createWorkforceRouter()
    );

    protectedRoutes.use(
      createStaffAdminRouter()
    );

    protectedRoutes.use(
      createIntegrationInboxRouter()
    );

    protectedRoutes.use(
      createLeadBulkImportRouter()
    );

    protectedRoutes.use(
      createBulkImportRouter()
    );

    protectedRoutes.use(
      createCrmExportRouter()
    );

    protectedRoutes.use(
      createPortfolioExportRouter()
    );

    protectedRoutes.use(
      createGeneralTaskRouter()
    );

    protectedRoutes.use(
      createDashboardOverviewRouter()
    );

    protectedRoutes.use(
      createActivityReportRouter()
    );

    protectedRoutes.use(
      createStaffInvitationRouter()
    );

    protectedRoutes.use(
      createAiConversationRouter()
    );

    protectedRoutes.use(
      createAiGenerationRouter()
    );

    return protectedRoutes;
}

export interface LocalServerOptions {
  readonly port?: number;
  readonly seedFixtures?: boolean;
}

export interface DevCredential {
  readonly user: string;
  readonly companyId: string;
  readonly role: string;
  readonly token: string;
}

export interface RunningLocalServer {
  readonly server: Server;
  readonly sessionStore: DevSessionStore;
  readonly identityStore: DevIdentityStore;
  readonly credentials: readonly DevCredential[];
}

/**
 * Local-only fixtures.
 *
 * These are simulated test identities.
 * They are not database records.
 *
 * The fixture registry is enabled only
 * when explicitly requested.
 */
const DEV_FIXTURES = [
  {
    user: "dev_owner",
    companyId: "3",
    actorUserId: "3",
    role: "OWNER",
    membershipStatus: "ACTIVE",
    accessMode: "FULL",
  },
  {
    user: "dev_manager",
    companyId: "3",
    actorUserId: "4",
    role: "MANAGER",
    membershipStatus: "ACTIVE",
    accessMode: "FULL",
  },
  {
    user: "dev_employee",
    companyId: "3",
    actorUserId: "5",
    role: "EMPLOYEE",
    membershipStatus: "ACTIVE",
    accessMode: "FULL",
  },
  {
    user: "dev_readonly",
    companyId: "1",
    actorUserId: "4",
    role: "MANAGER",
    membershipStatus: "ACTIVE",
    accessMode: "READ_ONLY",
  },
  {
    user: "dev_denied",
    companyId: "1",
    actorUserId: "5",
    role: "MANAGER",
    membershipStatus: "ACTIVE",
    accessMode: "DENIED",
  },
  {
    user: "dev_inactive",
    companyId: "1",
    actorUserId: "6",
    role: "EMPLOYEE",
    membershipStatus: "INACTIVE",
    accessMode: "FULL",
  },
] as const satisfies readonly (
  VerifiedCrmIdentity & {
    readonly user: string;
  }
)[];

/**
 * Until the approved Platform adapters are
 * implemented, only local/test mode can start.
 *
 * Production and Platform modes fail closed.
 */
function assertBootstrapMode(): void {
  if (
    env.NODE_ENV === "production" ||
    env.AUTH_MODE !== "local"
  ) {
    throw new Error(
      "CRM Platform authentication is not connected. " +
      "Refusing to start without verified production adapters."
    );
  }
}

/**
 * Start a local CRM server.
 *
 * Authentication remains mandatory.
 * No sessions are automatically created
 * unless seedFixtures is explicitly enabled.
 */
export async function startLocalCrmServer(
  options: LocalServerOptions = {}
): Promise<RunningLocalServer> {
  assertBootstrapMode();

  const port = options.port ?? env.PORT;

  if (
    !Number.isSafeInteger(port) ||
    port < 0 ||
    port > 65535
  ) {
    throw new Error("Invalid CRM server port");
  }

  const sessionStore = createDevSessionStore();
  const identityStore = createDevIdentityStore();

  const credentials: DevCredential[] = [];

  try {
    if (options.seedFixtures === true) {
      for (const fixture of DEV_FIXTURES) {
        identityStore.registerIdentity(
          fixture.user,
          {
            companyId: fixture.companyId,
            actorUserId: fixture.actorUserId,
            role: fixture.role,
            membershipStatus:
              fixture.membershipStatus,
            accessMode: fixture.accessMode,
          }
        );

        const token = sessionStore.issueSession(
          fixture.user
        );

        credentials.push(
          Object.freeze({
            user: fixture.user,
            companyId: fixture.companyId,
            role: fixture.role,
            token,
          })
        );
      }
    }

    const protectedRoutes = createAllProtectedCrmRoutes();

    const app = createCrmApp({
      sessionVerifier: sessionStore.verifier,
      identityResolver: identityStore.resolver,
      protectedRoutes,
    });

    const server = await new Promise<Server>(
      (resolve, reject) => {
        const instance = app.listen(
          port,
          env.HOST
        );

        instance.once("error", reject);

        instance.once("listening", () => {
          instance.removeListener(
            "error",
            reject
          );

          resolve(instance);
        });
      }
    );

    return {
      server,
      sessionStore,
      identityStore,
      credentials: Object.freeze(credentials),
    };
  } catch (error) {
    sessionStore.clearSessions();
    identityStore.clearIdentities();

    throw error;
  }
}

/**
 * Stop accepting requests and invalidate
 * all development sessions and identities.
 */
export async function stopLocalCrmServer(
  runtime: RunningLocalServer
): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      runtime.server.close(error => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });

      // Drop keep-alive connections.
      runtime.server.closeIdleConnections();
    });
  } finally {
    runtime.sessionStore.clearSessions();
    runtime.identityStore.clearIdentities();
  }
}

/**
 * Direct CLI startup.
 *
 * CRM_DEV_SEED=1 explicitly enables
 * disposable local authentication fixtures.
 *
 * Never enable or display test tokens
 * outside local development.
 */
if (require.main === module) {
  const seedFixtures =
    process.env.CRM_DEV_SEED === "1";

  startLocalCrmServer({
    seedFixtures,
  }).then(runtime => {
    const address = runtime.server.address();

    const port =
      typeof address === "object" &&
      address !== null
        ? address.port
        : env.PORT;

    console.log(
      `CRM local server listening on ${env.HOST}:${port}`
    );

    if (seedFixtures) {
      console.log(
        "LOCAL DEVELOPMENT TEST CREDENTIALS"
      );

      for (const credential of runtime.credentials) {
        console.log(
          `${credential.user} (${credential.role}): ` +
          credential.token
        );
      }

      console.log(
        "These tokens are local test credentials only. " +
        "Do not share or commit them."
      );
    }

    let shuttingDown = false;

    async function shutdown(): Promise<void> {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;

      try {
        await stopLocalCrmServer(runtime);
      } catch {
        process.exitCode = 1;
      }
    }

    process.once("SIGINT", () => {
      void shutdown();
    });

    process.once("SIGTERM", () => {
      void shutdown();
    });
  }).catch(error => {
    console.error(
      "CRM server startup failed:",
      error instanceof Error
        ? error.message
        : "Unknown startup error"
    );

    process.exitCode = 1;
  });
}
