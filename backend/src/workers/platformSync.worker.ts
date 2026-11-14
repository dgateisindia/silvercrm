import { setTimeout as sleep } from 'node:timers/promises';
import { createProductionPlatformReconciler } from '../core/platform/platformReconciler';

/**
 * Independent worker only. NEVER imported by the CRM HTTP server.
 * Opt-in requires production/platform mode AND an explicit enable flag.
 * --once: one reconciliation; --watch: sequential periodic reconciliation.
 */
export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (process.env.NODE_ENV !== 'production' || process.env.AUTH_MODE !== 'platform' ||
      process.env.CRM_PLATFORM_SYNC_WORKER_ENABLED !== 'true') {
    throw new Error('PLATFORM_SYNC_WORKER_DISABLED');
  }
  if (args.length !== 1 || !['--once', '--watch'].includes(args[0] ?? '')) {
    throw new Error('PLATFORM_SYNC_WORKER_ARGUMENT_REQUIRED');
  }
  const seconds = Number(process.env.CRM_PLATFORM_SYNC_INTERVAL_SECONDS ?? '120');
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 3600) {
    throw new Error('PLATFORM_SYNC_INTERVAL_INVALID');
  }
  const worker = createProductionPlatformReconciler();
  do {
    const result = await worker.runOnce();
    console.log(JSON.stringify({
      event: 'platform.sync.completed',
      scanned: result.scanned,
      applied: result.applied,
      heartbeats: result.heartbeats,
      stale: result.stale,
      membershipsSuspended: result.membershipsSuspended,
      failed: result.failed,
      hasMore: result.hasMore,
    }));
    if (result.failed > 0 || result.hasMore) process.exitCode = 1;
    if (args[0] === '--once') return;
    await sleep(seconds * 1000);
  } while (args[0] === '--watch');
}

if (require.main === module) {
  main().catch(() => {
    // Do not print upstream exception messages or provider response details.
    console.error('CRM platform sync worker unavailable: check configuration and trusted Platform contract');
    process.exitCode = 1;
  });
}