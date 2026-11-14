import type { Server } from 'node:http';
import { env } from './config/env';
import { createCrmApp } from './app';
import { createAllProtectedCrmRoutes } from './server';
import { createProductionClerkBoundary } from './core/auth/clerkProductionBoundary';

/**
 * Separate production entrypoint; local development server is not affected.
 * Missing live Clerk credentials or stale Platform entitlements always deny.
 * Nothing starts or contacts the provider merely by importing this module.
 */
export function createProductionCrmApplication() {
  if (env.NODE_ENV !== 'production' || env.AUTH_MODE !== 'platform') {
    throw new Error('CRM_PRODUCTION_PLATFORM_MODE_REQUIRED');
  }
  const trustedAuthBoundary = createProductionClerkBoundary();
  return createCrmApp({
    authMode: 'clerk',
    trustedAuthBoundary,
    protectedRoutes: createAllProtectedCrmRoutes(),
  });
}

export async function startProductionCrmServer(): Promise<Server> {
  const app = createProductionCrmApplication();
  return await new Promise<Server>((resolve, reject) => {
    const server = app.listen(env.PORT, env.HOST);
    server.once('error', reject);
    server.once('listening', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startProductionCrmServer()
    .then(() => console.log('CRM production server listening'))
    .catch(() => {
      console.error('CRM production startup refused: verify Clerk and Platform configuration');
      process.exitCode = 1;
    });
}