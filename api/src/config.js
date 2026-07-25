/**
 * Configuration. Read once, validated once, fails fast.
 *
 * Everything comes from the environment. Nothing is read from a file in the
 * repository, and there are no defaults for anything security-relevant —
 * a missing secret must stop the process, not silently pick something.
 */

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return v.trim();
}

function optional(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function intOpt(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer`);
  return n;
}

const nodeEnv = optional("NODE_ENV", "development");
const isProd = nodeEnv === "production";
const authMode = optional("AUTH_MODE", "oidc");

if (!["oidc", "dev"].includes(authMode)) {
  throw new Error(`AUTH_MODE must be 'oidc' or 'dev', got '${authMode}'`);
}

// The single most dangerous misconfiguration available here: shipping the
// static-token dev authenticator to production. Refuse to start.
if (authMode === "dev" && isProd) {
  throw new Error(
    "AUTH_MODE=dev cannot be used with NODE_ENV=production. " +
      "Dev auth accepts static tokens and performs no signature verification."
  );
}

export const config = {
  nodeEnv,
  isProd,
  port: intOpt("PORT", 8080),
  host: optional("HOST", "0.0.0.0"),

  db: {
    // Standard libpq variables, same as the migration runner, so there is one
    // way to point at a database rather than two.
    connectionString: process.env.DATABASE_URL || undefined,
    host: optional("PGHOST", "localhost"),
    port: intOpt("PGPORT", 5432),
    database: optional("PGDATABASE", "registry"),
    user: optional("PGUSER", "registry_app"),
    password: process.env.PGPASSWORD,
    max: intOpt("PG_POOL_MAX", 10),
    idleTimeoutMillis: intOpt("PG_IDLE_TIMEOUT_MS", 30_000),
    connectionTimeoutMillis: intOpt("PG_CONNECT_TIMEOUT_MS", 5_000),
    statementTimeoutMs: intOpt("PG_STATEMENT_TIMEOUT_MS", 15_000),
    // verify-full is the only setting that actually authenticates the server.
    // 'require' encrypts but will happily talk to an impostor.
    ssl: optional("PGSSLMODE", isProd ? "verify-full" : "disable"),
  },

  auth: {
    mode: authMode,
    // OIDC: discovered from the IdP. No default — it is deployment specific
    // and guessing it would be worse than failing.
    jwksUri: authMode === "oidc" ? required("OIDC_JWKS_URI") : null,
    issuer: authMode === "oidc" ? required("OIDC_ISSUER") : null,
    audience: authMode === "oidc" ? required("OIDC_AUDIENCE") : null,
    // Which claim carries group membership, and how groups map to roles.
    groupsClaim: optional("OIDC_GROUPS_CLAIM", "groups"),
    subjectClaim: optional("OIDC_SUBJECT_CLAIM", "preferred_username"),
    roleMap: JSON.parse(
      optional(
        "AUTH_ROLE_MAP",
        // Placeholder group names. Replace with rain's actual directory
        // groups; nothing here should be assumed to match anything real.
        JSON.stringify({
          "device-registry-managers": "manager",
          "device-registry-warehouse": "warehouse",
          "device-registry-technicians": "technician",
          "device-registry-readonly": "readonly",
        })
      )
    ),
    clockToleranceSec: intOpt("OIDC_CLOCK_TOLERANCE_SEC", 30),
  },

  rateLimit: {
    max: intOpt("RATE_LIMIT_MAX", 300),
    windowMs: intOpt("RATE_LIMIT_WINDOW_MS", 60_000),
  },

  // Trust proxy headers only when actually behind a known proxy, otherwise a
  // client can spoof X-Forwarded-For and poison both rate limiting and the
  // source_ip recorded in the audit log.
  trustProxy: optional("TRUST_PROXY", "false") === "true",
};

export const ROLES = Object.freeze({
  technician: "registry_technician",
  warehouse: "registry_warehouse",
  manager: "registry_manager",
  readonly: "registry_readonly",
});

// Capability checks live here so the API can return a clean 403 with a
// reason. Postgres enforces the same thing independently — this is for the
// error message, not for the security.
export const CAN = Object.freeze({
  registerDevice: ["warehouse", "manager"],
  editIdentifiers: ["warehouse", "manager"],
  changeStatus: ["technician", "warehouse", "manager"],
  addNote: ["technician", "warehouse", "manager"],
  softDelete: ["manager"],
  export: ["manager"],
  readAudit: ["manager"],
});
