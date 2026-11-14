import type { PoolConnection } from "mysql2/promise";

import { getDbPool } from "./pool";
import { logger } from "../../config/logger";

/**
 * Execute CRM database operations inside one transaction.
 *
 * All queries in the callback must use the provided
 * connection to participate in the same transaction.
 *
 * Success:
 * BEGIN -> WORK -> COMMIT -> RELEASE
 *
 * Failure:
 * BEGIN -> WORK -> ROLLBACK -> RELEASE
 *
 * If transaction state becomes uncertain, destroy
 * the connection instead of returning it to the pool.
 */
export async function withTransaction<T>(
  operation: (connection: PoolConnection) => Promise<T>
): Promise<T> {
  const connection = await getDbPool().getConnection();

  let transactionStarted = false;
  let commitAttempted = false;
  let safeToRelease = true;

  try {
    await connection.beginTransaction();

    transactionStarted = true;

    const result = await operation(connection);

    commitAttempted = true;
    await connection.commit();

    return result;
  } catch (error) {
    if (commitAttempted) {
      // COMMIT may have succeeded before the connection failed.
      // Never return a connection with an uncertain outcome.
      safeToRelease = false;

      try {
        connection.destroy();
      } catch {
        logger.error(
          "database.connection_destroy_failed",
          {
            module: "database",
            errorCode: "TX_DESTROY_FAILED",
          }
        );
      }

      logger.error(
        "database.transaction_commit_outcome_unknown",
        {
          module: "database",
          errorCode: "TX_COMMIT_UNKNOWN",
        }
      );
    } else if (transactionStarted) {
      try {
        await connection.rollback();
      } catch {
        // A connection with uncertain transaction state
        // must never be reused.
        safeToRelease = false;

        try {
          connection.destroy();
        } catch {
          logger.error(
            "database.connection_destroy_failed",
            {
              module: "database",
              errorCode: "TX_DESTROY_FAILED",
            }
          );
        }

        logger.error(
          "database.transaction_rollback_failed",
          {
            module: "database",
            errorCode: "TX_ROLLBACK_FAILED",
          }
        );
      }
    } else {
      // BEGIN may have reached the server before failing.
      // Do not return this connection to the pool.
      safeToRelease = false;

      try {
        connection.destroy();
      } catch {
        logger.error(
          "database.connection_destroy_failed",
          {
            module: "database",
            errorCode: "TX_DESTROY_FAILED",
          }
        );
      }
    }

    // Preserve the original operation or commit error.
    throw error;
  } finally {
    if (safeToRelease) {
      connection.release();
    }
  }
}
