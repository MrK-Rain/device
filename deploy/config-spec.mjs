/**
 * The whole API configuration surface in one place: every env var
 * api/src/config.js reads, whether it's required, what it defaults to when
 * it isn't, and — for the ones that ship with a placeholder value — what
 * that placeholder is, so preflight.mjs can tell "unset" apart from
 * "still the placeholder nobody replaced".
 *
 * This is the single source of truth. api/src/config.js is not generated
 * from it (it predates this file and has its own defaults inline), but the
 * two must be kept in sync by hand — a mismatch here would make preflight
 * either too strict or too permissive about what config.js actually needs.
 */

// The four directory group names AUTH_ROLE_MAP ships with. Real values only
// rain can supply (DEPLOYMENT-READINESS.md 1.6) — these exist so preflight
// can tell whether they were ever replaced.
export const REQUIRED_GROUPS = {
  manager: "device-registry-managers",
  warehouse: "device-registry-warehouse",
  technician: "device-registry-technicians",
  readonly: "device-registry-readonly",
};

const DEFAULT_ROLE_MAP = {
  [REQUIRED_GROUPS.manager]: "manager",
  [REQUIRED_GROUPS.warehouse]: "warehouse",
  [REQUIRED_GROUPS.technician]: "technician",
  [REQUIRED_GROUPS.readonly]: "readonly",
};

export const SPEC = [
  { name: "NODE_ENV", default: "development" },
  { name: "AUTH_MODE", default: "oidc" },
  { name: "PORT", default: "8080" },
  { name: "HOST", default: "0.0.0.0" },

  // ── Database (1.2, 1.4: no cluster exists yet, secret delivery undecided) ─
  {
    name: "DATABASE_URL",
    required: true,
    note: "1.2/1.4 (rain + eng) — the real cluster and how its credential reaches this process",
  },
  { name: "PGHOST", default: "localhost" },
  { name: "PGPORT", default: "5432" },
  { name: "PGDATABASE", default: "registry" },
  { name: "PGUSER", default: "registry_app" },
  {
    name: "PGPASSWORD",
    required: true,
    placeholder: "changeme",
    note: "1.4 (rain + eng) — prefer IAM/certificate auth over a password",
  },
  { name: "PG_POOL_MAX", default: "10" },
  { name: "PG_IDLE_TIMEOUT_MS", default: "30000" },
  { name: "PG_CONNECT_TIMEOUT_MS", default: "5000" },
  { name: "PG_STATEMENT_TIMEOUT_MS", default: "15000" },
  {
    name: "PGSSLMODE",
    default: "verify-full",
    note: "1.5 — must stay verify-full; 'require' encrypts but authenticates nothing",
  },

  // ── Auth (1.6: rain's IdP configuration) ───────────────────────────────
  {
    name: "OIDC_JWKS_URI",
    required: true,
    requiredWhen: (env) => (env.AUTH_MODE || "oidc") !== "dev",
    placeholder: "https://REPLACE-ME.example/.well-known/jwks.json",
    note: "1.6 (rain) — from rain's IdP",
  },
  {
    name: "OIDC_ISSUER",
    required: true,
    requiredWhen: (env) => (env.AUTH_MODE || "oidc") !== "dev",
    placeholder: "https://REPLACE-ME.example/issuer",
    note: "1.6 (rain)",
  },
  {
    name: "OIDC_AUDIENCE",
    required: true,
    requiredWhen: (env) => (env.AUTH_MODE || "oidc") !== "dev",
    placeholder: "REPLACE-ME-audience",
    note: "1.6 (rain)",
  },
  { name: "OIDC_GROUPS_CLAIM", default: "groups" },
  { name: "OIDC_SUBJECT_CLAIM", default: "preferred_username" },
  { name: "OIDC_CLOCK_TOLERANCE_SEC", default: "30" },
  {
    name: "AUTH_ROLE_MAP",
    default: JSON.stringify(DEFAULT_ROLE_MAP),
    note: "1.6 (rain) — the 4 directory group names inside must be real, checked individually below",
  },

  // ── Rate limiting / proxy trust ─────────────────────────────────────────
  { name: "RATE_LIMIT_MAX", default: "300" },
  { name: "RATE_LIMIT_WINDOW_MS", default: "60000" },
  { name: "TRUST_PROXY", default: "false" },
];
