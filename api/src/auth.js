/**
 * Authentication and role resolution.
 *
 * Two modes.
 *
 *   oidc  Verifies an RS256/ES256 bearer token against the IdP's JWKS,
 *         checking signature, issuer, audience and expiry. Roles come from a
 *         group claim mapped through configuration. This is the only mode
 *         permitted in production.
 *
 *   dev   Accepts static tokens from a local table. No cryptography. Exists
 *         so the suite can exercise every role without standing up an IdP,
 *         and config.js refuses to start in this mode under NODE_ENV=production.
 *
 * Deliberately not implemented: any notion of a local user store, password
 * handling, or session issuance. rian has an identity provider; a second
 * source of truth for who works there would be a liability, not a feature.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config.js";
import { unauthorized, forbidden } from "./errors.js";

const ROLE_NAMES = ["technician", "warehouse", "manager", "readonly"];

// Highest privilege wins when a person is in several groups. Ordered most to
// least, so membership of both technicians and managers resolves to manager.
const ROLE_PRECEDENCE = ["manager", "warehouse", "technician", "readonly"];

let jwks = null;
function keySet() {
  if (!jwks) {
    // Caches keys and re-fetches on unknown kid, so a routine IdP key
    // rotation does not require a restart.
    jwks = createRemoteJWKSet(new URL(config.auth.jwksUri), {
      cacheMaxAge: 10 * 60 * 1000,
      cooldownDuration: 30 * 1000,
    });
  }
  return jwks;
}

function bearer(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length ? token : null;
}

function rolesFromGroups(groups) {
  const list = Array.isArray(groups) ? groups : typeof groups === "string" ? [groups] : [];
  const mapped = new Set();
  for (const g of list) {
    const role = config.auth.roleMap[g];
    if (role && ROLE_NAMES.includes(role)) mapped.add(role);
  }
  return ROLE_PRECEDENCE.find((r) => mapped.has(r)) ?? null;
}

async function verifyOidc(token) {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keySet(), {
      issuer: config.auth.issuer,
      audience: config.auth.audience,
      clockTolerance: config.auth.clockToleranceSec,
      // Do not accept a token that tells us it needs no signature.
      algorithms: ["RS256", "RS384", "RS512", "ES256", "ES384"],
    }));
  } catch (err) {
    // The reason is logged, not returned: distinguishing "expired" from
    // "bad signature" for an unauthenticated caller is free reconnaissance.
    throw unauthorized(`token rejected (${err.code ?? "verification_failed"})`);
  }

  const actor = payload[config.auth.subjectClaim] ?? payload.sub;
  if (!actor) throw unauthorized("token carries no usable subject claim");

  const role = rolesFromGroups(payload[config.auth.groupsClaim]);
  if (!role) {
    throw forbidden(
      "your account is not a member of any group mapped to a registry role"
    );
  }
  return { actor: String(actor), role };
}

// ── dev mode ───────────────────────────────────────────────────────────────
const devTokens = new Map();

export function registerDevToken(token, actor, role) {
  if (config.auth.mode !== "dev") {
    throw new Error("dev tokens can only be registered in AUTH_MODE=dev");
  }
  if (!ROLE_NAMES.includes(role)) throw new Error(`unknown role: ${role}`);
  devTokens.set(token, { actor, role });
}

function verifyDev(token) {
  const found = devTokens.get(token);
  if (!found) throw unauthorized("unknown dev token");
  return found;
}

/**
 * Fastify preHandler. Attaches req.identity or throws.
 */
export async function authenticate(req) {
  const token = bearer(req);
  if (!token) throw unauthorized("a bearer token is required");

  const identity =
    config.auth.mode === "dev" ? verifyDev(token) : await verifyOidc(token);

  req.identity = identity;
  return identity;
}

/**
 * Guard for a named capability. Postgres enforces the same boundary through
 * its grants; this exists so the caller gets a 403 with a reason instead of a
 * generic database permission error.
 */
export function require_(capability, allowed) {
  return async function guard(req) {
    if (!allowed.includes(req.identity.role)) {
      req.permissionDenied = capability;
      throw forbidden(`${capability} requires one of: ${allowed.join(", ")}`);
    }
  };
}
