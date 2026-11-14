import mysql, {
  type Pool,
  type PoolOptions,
} from "mysql2/promise";

import { env } from "../../config/env";

/**
 * Shared CRM operational database pool.
 *
 * This connects only to the CRM operational database.
 * The D-GATE Platform database is managed separately.
 *
 * Repositories must enforce tenant-level isolation.
 */

let activePool: Pool | null = null;

function createConfiguredPool(): Pool {
  const options: PoolOptions = {
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,

    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 50,

    connectTimeout: 10000,

    charset: "utf8mb4",
    timezone: "Z",

    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,

    multipleStatements: false,
    namedPlaceholders: false,

    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  };

  return mysql.createPool(options);
}

/**
 * Return one shared pool instance.
 *
 * No database connection is made until required.
 */
export function getDbPool(): Pool {
  if (activePool === null) {
    activePool = createConfiguredPool();
  }

  return activePool;
}

/**
 * Verify the CRM database is reachable.
 *
 * The acquired connection is always released,
 * including when the ping fails.
 */
export async function verifyDatabaseConnection(): Promise<void> {
  const connection = await getDbPool().getConnection();

  try {
    await connection.ping();
  } finally {
    connection.release();
  }
}

/**
 * Gracefully close the shared database pool.
 *
 * Call this during application shutdown,
 * after stopping new HTTP requests.
 */
export async function closeDbPool(): Promise<void> {
  const pool = activePool;

  if (pool === null) {
    return;
  }

  activePool = null;

  await pool.end();
}
