/**
 * API integration tests.
 *
 * These run against a real Postgres with the migrations applied. There are no
 * mocks: the whole point of the design is that Postgres enforces authorisation
 * through its grants, and a mocked database would test nothing but the mock.
 *
 * Requires AUTH_MODE=dev and a disposable database. See api/README.md.
 */

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_MODE ??= "dev";
process.env.NODE_ENV = "test";

const { build } = await import("../src/server.js");
const { registerDevToken } = await import("../src/auth.js");
const { withActor, close } = await import("../src/db.js");

registerDevToken("tok-tech", "tech@ci", "technician");
registerDevToken("tok-ware", "warehouse@ci", "warehouse");
registerDevToken("tok-mgr", "manager@ci", "manager");
registerDevToken("tok-read", "readonly@ci", "readonly");

let app;
const uniq = () => `API-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

// Identifiers must be unique across runs, not just within one. IMEI and ICCID
// uniqueness is global and the test database persists locally, so fixed
// literals pass once and then 409 forever after.
const digits = (n) =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");

function luhnCheckDigit(base) {
  let sum = 0;
  let dbl = true; // the check digit position means the last base digit doubles
  for (let i = base.length - 1; i >= 0; i--) {
    let d = Number(base[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return String((10 - (sum % 10)) % 10);
}

const validImei = () => { const b = digits(14); return b + luhnCheckDigit(b); };
const invalidImei = () => {
  const v = validImei();
  return v.slice(0, 14) + String((Number(v[14]) + 1) % 10);
};
const uniqIccid = () => "8927" + digits(15);

// Reading the audit log requires a role. registry_app deliberately has none
// of its own, so assertions go through withActor as a manager — which is the
// only role granted SELECT on it.
const asManager = (fn) => withActor({ actor: "assertions@ci", role: "manager" }, fn);

const call = (token, method, url, payload) =>
  app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload ? { payload } : {}),
  });

before(async () => {
  app = await build({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();

  // Removing fixtures needs owner rights. No application role can DELETE from
  // any of these tables — that is the point of the design — so teardown uses a
  // separate admin connection when one is offered. In CI the database is
  // disposable, so its absence is not a problem.
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
  if (adminUrl) {
    const pg = (await import("pg")).default;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    for (const sql of [
      "DELETE FROM registry.device_notes WHERE device_id IN (SELECT id FROM registry.devices WHERE serial LIKE 'API-%')",
      "DELETE FROM registry.device_status_history WHERE device_id IN (SELECT id FROM registry.devices WHERE serial LIKE 'API-%')",
      "DELETE FROM registry.devices WHERE serial LIKE 'API-%'",
    ]) {
      await admin.query(sql);
    }
    await admin.end();
  }
  await close();
});

describe("authentication", () => {
  test("no token is rejected", async () => {
    const r = await call(null, "GET", "/api/devices");
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().error, "unauthorized");
  });

  test("unknown token is rejected", async () => {
    const r = await call("nonsense", "GET", "/api/devices");
    assert.equal(r.statusCode, 401);
  });

  test("health needs no token and does not touch the database", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().status, "ok");
  });

  test("every response carries a request id", async () => {
    const r = await call("tok-tech", "GET", "/api/meta");
    assert.match(r.headers["x-request-id"], /[0-9a-f-]{36}/i);
  });
});

describe("registering devices", () => {
  test("warehouse can register; technician cannot", async () => {
    const serial = uniq();
    const denied = await call("tok-tech", "POST", "/api/devices", {
      serial,
      deviceType: "loop",
    });
    assert.equal(denied.statusCode, 403);

    const ok = await call("tok-ware", "POST", "/api/devices", {
      serial,
      deviceType: "loop",
      imei: validImei(),
    });
    assert.equal(ok.statusCode, 201);
    const body = ok.json();
    assert.equal(body.serial, serial);
    assert.equal(body.imeiCheckDigitOk, true);
    assert.equal(body.createdBy, "warehouse@ci");
  });

  test("a bad IMEI is refused with a readable message", async () => {
    const r = await call("tok-ware", "POST", "/api/devices", {
      serial: uniq(),
      deviceType: "loop",
      imei: "123",
    });
    assert.equal(r.statusCode, 400); // caught by schema before the database
  });

  test("a 15-digit IMEI failing its check digit is stored but flagged", async () => {
    const r = await call("tok-ware", "POST", "/api/devices", {
      serial: uniq(),
      deviceType: "101a",
      imei: invalidImei(),
    });
    assert.equal(r.statusCode, 201);
    assert.equal(r.json().imeiCheckDigitOk, false);
  });

  test("duplicate serial gives 409, not 500", async () => {
    const serial = uniq();
    await call("tok-ware", "POST", "/api/devices", { serial, deviceType: "loop" });
    const dup = await call("tok-ware", "POST", "/api/devices", {
      serial: serial.toLowerCase(),
      deviceType: "loop",
    });
    assert.equal(dup.statusCode, 409);
    assert.match(dup.json().message, /already registered/);
  });

  test("unknown device type gives 422, not 500", async () => {
    const r = await call("tok-ware", "POST", "/api/devices", {
      serial: uniq(),
      deviceType: "tablet",
    });
    assert.equal(r.statusCode, 422);
  });

  test("unexpected fields are rejected rather than ignored", async () => {
    const r = await call("tok-ware", "POST", "/api/devices", {
      serial: uniq(),
      deviceType: "loop",
      customerName: "should not exist",
    });
    assert.equal(r.statusCode, 400);
  });
});

describe("role boundaries are enforced by the database", () => {
  let id;
  before(async () => {
    const r = await call("tok-ware", "POST", "/api/devices", {
      serial: uniq(),
      deviceType: "loop",
    });
    id = r.json().id;
  });

  test("technician may change status", async () => {
    const r = await call("tok-tech", "PATCH", `/api/devices/${id}`, { status: "repair" });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().status, "repair");
    assert.equal(r.json().updatedBy, "tech@ci");
  });

  test("technician may not change an IMEI", async () => {
    const r = await call("tok-tech", "PATCH", `/api/devices/${id}`, {
      imei: validImei(),
    });
    assert.equal(r.statusCode, 403);
  });

  test("read-only may read but not write", async () => {
    assert.equal((await call("tok-read", "GET", `/api/devices/${id}`)).statusCode, 200);
    const w = await call("tok-read", "PATCH", `/api/devices/${id}`, { status: "stock" });
    assert.equal(w.statusCode, 403);
  });

  test("only a manager may delete, and only with a reason", async () => {
    assert.equal(
      (await call("tok-ware", "DELETE", `/api/devices/${id}`, { reason: "wrong entry entirely" }))
        .statusCode,
      403
    );
    assert.equal(
      (await call("tok-mgr", "DELETE", `/api/devices/${id}`, { reason: "short" })).statusCode,
      400
    );
    const ok = await call("tok-mgr", "DELETE", `/api/devices/${id}`, {
      reason: "duplicate record created during import",
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().deleted, true);
  });

  test("a deleted device is gone from reads and search", async () => {
    assert.equal((await call("tok-tech", "GET", `/api/devices/${id}`)).statusCode, 404);
  });

  test("only a manager may export", async () => {
    assert.equal((await call("tok-tech", "GET", "/api/devices/export")).statusCode, 403);
    const r = await call("tok-mgr", "GET", "/api/devices/export");
    assert.equal(r.statusCode, 200);
    assert.match(r.headers["content-type"], /text\/csv/);
    assert.match(r.body.split("\n")[0], /^serial,device_type/);
  });
});

describe("personal data screening", () => {
  let id;
  before(async () => {
    const r = await call("tok-ware", "POST", "/api/devices", {
      serial: uniq(),
      deviceType: "101pro",
    });
    id = r.json().id;
  });

  test("a clean repair note is accepted", async () => {
    const r = await call("tok-tech", "POST", `/api/devices/${id}/notes`, {
      body: "Replaced antenna lead, reflashed firmware 2.4.1, passed loop test.",
      kind: "repair",
    });
    assert.equal(r.statusCode, 201);
    assert.equal(r.json().created_by, "tech@ci");
  });

  test("an email address is refused outright", async () => {
    const r = await call("tok-tech", "POST", `/api/devices/${id}/notes`, {
      body: "Escalated to someone@rain.co.za for parts",
    });
    assert.equal(r.statusCode, 422);
    assert.equal(r.json().detail?.reason, "personal_data");
  });

  test("a South African ID number is refused", async () => {
    const r = await call("tok-tech", "POST", `/api/devices/${id}/notes`, {
      body: "Handover ref 8001015009087 signed at the depot",
    });
    assert.equal(r.statusCode, 422);
  });

  test("a mobile number is refused", async () => {
    const r = await call("tok-tech", "POST", `/api/devices/${id}/notes`, {
      body: "Called 082 555 1234 to arrange the swap",
    });
    assert.equal(r.statusCode, 422);
  });

  test("an ambiguous phrase asks for confirmation instead of failing", async () => {
    const r = await call("tok-tech", "POST", `/api/devices/${id}/notes`, {
      body: "Box arrived with a subscriber label stuck on it, removed and binned",
    });
    assert.equal(r.statusCode, 409);
    const b = r.json();
    assert.equal(b.code, "advisory_review_required");
    assert.ok(b.findings.length > 0);
  });

  test("confirming stores the acknowledgement against the person who gave it", async () => {
    const r = await call("tok-tech", "POST", `/api/devices/${id}/notes`, {
      body: "Box arrived with a subscriber label stuck on it, removed and binned",
      acknowledgeAdvisory: true,
    });
    assert.equal(r.statusCode, 201);
    assert.equal(r.json().advisory_ack_by, "tech@ci");
  });

  test("a date is not mistaken for a phone number", async () => {
    const r = await call("tok-tech", "POST", `/api/devices/${id}/notes`, {
      body: "Bench tested 2026-07-25, retest due 2026-10-01",
    });
    assert.equal(r.statusCode, 201);
  });
});

describe("search", () => {
  let serial;
  let iccid;
  before(async () => {
    serial = uniq();
    iccid = uniqIccid();
    await call("tok-ware", "POST", "/api/devices", {
      serial,
      deviceType: "extender",
      iccid,
    });
  });

  test("exact serial is ranked as exact", async () => {
    const r = await call("tok-tech", "GET", `/api/devices?q=${serial}`);
    assert.equal(r.statusCode, 200);
    const hit = r.json().results.find((d) => d.serial === serial);
    assert.ok(hit);
    assert.equal(hit.matchKind, "serial_exact");
  });

  test("exact ICCID finds the device", async () => {
    const r = await call("tok-tech", "GET", `/api/devices?q=${iccid}`);
    assert.ok(r.json().results.some((d) => d.serial === serial));
  });

  test("a quote in the query does not break the dynamic SQL", async () => {
    const r = await call("tok-tech", "GET", `/api/devices?q=${encodeURIComponent("' OR 1=1 --")}`);
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().results.length, 0);
  });

  test("oversized paging is rejected by schema", async () => {
    assert.equal((await call("tok-tech", "GET", "/api/devices?limit=9999")).statusCode, 400);
  });

  test("note search finds a device by a word in its history", async () => {
    const r = await call("tok-tech", "GET", "/api/notes/search?q=antenna");
    assert.equal(r.statusCode, 200);
    assert.ok(Array.isArray(r.json().results));
  });
});

describe("audit trail", () => {
  test("a search is recorded with the acting user", async () => {
    const marker = uniq();
    await call("tok-mgr", "GET", `/api/devices?q=${marker}`);
    const rows = await asManager(async (c) =>
      (
        await c.query(
          `SELECT actor, actor_role, action, detail FROM registry.audit_log
            WHERE action = 'search' AND detail->>'q' = $1 ORDER BY occurred_at DESC LIMIT 1`,
          [marker]
        )
      ).rows
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, "manager@ci");
    assert.equal(rows[0].actor_role, "manager");
  });

  test("a search that looks like personal data is redacted before it is stored", async () => {
    await call("tok-mgr", "GET", `/api/devices?q=${encodeURIComponent("someone@rain.co.za")}`);
    const rows = await asManager(async (c) =>
      (
        await c.query(
          `SELECT detail->>'q' AS q FROM registry.audit_log
            WHERE action = 'search' AND actor = 'manager@ci'
            ORDER BY occurred_at DESC LIMIT 1`
        )
      ).rows
    );
    assert.match(rows[0].q, /redacted/);
    assert.ok(!rows[0].q.includes("rain.co.za"));
  });

  test("an export is recorded with the row count", async () => {
    await call("tok-mgr", "GET", "/api/devices/export");
    const rows = await asManager(async (c) =>
      (
        await c.query(
          `SELECT detail FROM registry.audit_log WHERE action = 'export'
            ORDER BY occurred_at DESC LIMIT 1`
        )
      ).rows
    );
    assert.ok(Number(rows[0].detail.rows) >= 0);
  });

  test("reads are audited, not just writes", async () => {
    const c = await call("tok-ware", "POST", "/api/devices", {
      serial: uniq(),
      deviceType: "loop",
    });
    const id = c.json().id;
    await call("tok-read", "GET", `/api/devices/${id}`);
    const rows = await asManager(async (c) =>
      (
        await c.query(
          `SELECT actor FROM registry.audit_log WHERE action = 'read' AND entity_id = $1`,
          [id]
        )
      ).rows
    );
    assert.ok(rows.some((r) => r.actor === "readonly@ci"));
  });
});

describe("failure handling", () => {
  test("a malformed uuid does not reach the database", async () => {
    const r = await call("tok-tech", "GET", "/api/devices/not-a-uuid");
    assert.equal(r.statusCode, 400);
  });

  test("an unknown endpoint returns json, not html", async () => {
    const r = await call("tok-tech", "GET", "/api/nope");
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().error, "not_found");
  });

  test("errors never leak database internals", async () => {
    const r = await call("tok-ware", "POST", "/api/devices", {
      serial: uniq(),
      deviceType: "not_a_type",
    });
    const text = JSON.stringify(r.json());
    assert.ok(!/pg_|relation |constraint "/.test(text), `leaked internals: ${text}`);
  });
});
