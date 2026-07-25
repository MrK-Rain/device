/**
 * Database access.
 *
 * Every request runs inside exactly one transaction that first establishes
 * who is acting and what role they hold. Three statements, in this order,
 * and none of them optional:
 *
 *   SET LOCAL ROLE <registry_role>     authorisation, enforced by Postgres
 *   SET LOCAL registry.actor           attribution, enforced by trigger
 *   SET LOCAL registry.actor_role      recorded on every audit row
 *
 * SET LOCAL means they revert when the transaction ends, so a pooled
 * connection cannot leak one caller's identity into the next request. That
 * matters more than it looks: plain SET would persist for the life of the
 * connection and silently misattribute everything that followed.
 */

import pg from "pg";
import { config, ROLES } from "./config.js";

function sslOption(mode) {
  switch (mode) {
    case "disable":
      return false;
    case "require":
      // Encrypts, but does not verify the server. Acceptable only inside a
      // trusted network segment, and never the production default.
      return { rejectUnauthorized: false };
    case "verify-ca":
    case "verify-full":
      return { rejectUnauthorized: true, ca: process.env.PGSSLROOTCERT_PEM };
    default:
      throw new Error(`unsupported PGSSLMODE: ${mode}`);
  }
}

export const pool = new pg.Pool({
  connectionString: config.db.connectionString,
  host: config.db.connectionString ? undefined : config.db.host,
  port: config.db.connectionString ? undefined : config.db.port,
  database: config.db.connectionString ? undefined : config.db.database,
  user: config.db.connectionString ? undefined : config.db.user,
  password: config.db.connectionString ? undefined : config.db.password,
  max: config.db.max,
  idleTimeoutMillis: config.db.idleTimeoutMillis,
  connectionTimeoutMillis: config.db.connectionTimeoutMillis,
  ssl: config.db.connectionString ? undefined : sslOption(config.db.ssl),
  application_name: "device-registry-api",
});

// An idle client erroring is normal during a failover. Crashing the process
// on it would turn a brief replica promotion into an outage.
pool.on("error", (err) => {
  process.emitWarning(`idle pool client error: ${err.message}`);
});

/**
 * Run fn inside a transaction bound to an actor and role.
 *
 * @param {{actor: string, role: keyof typeof ROLES}} identity
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withActor(identity, fn) {
  const dbRole = ROLES[identity.role];
  if (!dbRole) throw new Error(`unknown role: ${identity.role}`);
  if (!identity.actor) throw new Error("withActor requires an actor");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // A runaway query must not hold a transaction open indefinitely and pin
    // a pool slot. Set inside the transaction so it is scoped to it.
    await client.query(`SET LOCAL statement_timeout = ${Number(config.db.statementTimeoutMs)}`);
    await client.query(`SET LOCAL ROLE ${dbRole}`);
    await client.query("SELECT set_config('registry.actor', $1, true)", [identity.actor]);
    await client.query("SELECT set_config('registry.actor_role', $1, true)", [identity.role]);

    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is already unusable; releasing it below discards it.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Read-only probe that deliberately does not assume a role. */
export async function ping() {
  const { rows } = await pool.query("SELECT 1 AS ok");
  return rows[0]?.ok === 1;
}

export async function close() {
  await pool.end();
}
