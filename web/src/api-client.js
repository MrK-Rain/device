/**
 * HTTP client for the device registry API.
 *
 * The API is resource-oriented and permission-scoped (search, per-device
 * reads/writes, an append-only note log, a manager-only export) — nothing
 * like the flat get/set/delete/list contract storage-adapter.js uses for the
 * local prototype backend. Wrapping it in that KV shape would mean either
 * fetching the whole fleet into memory to fake a "get" (the API deliberately
 * has no such endpoint — see D15/D18) or building a fragile diff-and-sync
 * layer. Talking to it directly, one action at a time, is simpler and closer
 * to what the API actually guarantees.
 *
 * Auth: there is no login flow here yet. Real auth is OIDC against rian's
 * IdP (DEPLOYMENT-READINESS 1.6), which is not configured. Until then this
 * reads a pre-issued bearer token from VITE_API_TOKEN — in AUTH_MODE=dev
 * that's a token registered with `registerDevToken`; in a real deployment
 * it would be a token obtained out of band. Do not build a password form
 * against this — D2 in api/README.md is explicit that rian's IdP is the only
 * source of identity.
 */

const BASE = import.meta.env.VITE_API_BASE;
const TOKEN = import.meta.env.VITE_API_TOKEN;

export class ApiError extends Error {
  constructor(status, code, message, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data ?? null;
  }
}

function qs(params) {
  if (!params) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

async function request(method, path, { query, body, raw } = {}) {
  if (!BASE) throw new Error("VITE_API_BASE is not configured");
  const url = `${BASE.replace(/\/+$/, "")}${path}${qs(query)}`;
  const headers = { accept: "application/json" };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network", "could not reach the API — check VITE_API_BASE and your connection");
  }

  if (raw) {
    if (!res.ok) throw new ApiError(res.status, "error", `request failed (${res.status})`);
    return res.text();
  }

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};

  if (!res.ok) {
    // Two error shapes exist: the generic envelope from errors.js
    // ({ error, message, detail }) and the note advisory outcome, which puts
    // its own code at the top level ({ code, message, findings }).
    throw new ApiError(res.status, json.error ?? json.code ?? "error", json.message ?? `request failed (${res.status})`, json);
  }
  return json;
}

export const metaApi = {
  get: () => request("GET", "/meta"),
};

export const devicesApi = {
  search: ({ q, type, status, limit, offset } = {}) =>
    request("GET", "/devices", { query: { q, type, status, limit, offset } }),
  get: (id) => request("GET", `/devices/${id}`),
  create: (body) => request("POST", "/devices", { body }),
  patch: (id, body) => request("PATCH", `/devices/${id}`, { body }),
  softDelete: (id, reason) => request("DELETE", `/devices/${id}`, { body: { reason } }),
  exportCsv: () => request("GET", "/devices/export", { raw: true }),
};

export const notesApi = {
  list: (deviceId) => request("GET", `/devices/${deviceId}/notes`),
  add: (deviceId, body) => request("POST", `/devices/${deviceId}/notes`, { body }),
  search: ({ q, type, status, limit, offset }) =>
    request("GET", "/notes/search", { query: { q, type, status, limit, offset } }),
};
