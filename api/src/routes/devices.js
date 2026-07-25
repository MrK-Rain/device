import { withActor } from "../db.js";
import { audit } from "../audit.js";
import { authenticate, require_ } from "../auth.js";
import { CAN } from "../config.js";
import { notFound, forbidden } from "../errors.js";

const SERIAL = { type: "string", minLength: 3, maxLength: 64 };
const DIGITS = (min, max) => ({ type: "string", pattern: `^[0-9]{${min},${max}}$` });

// Validation here is a courtesy that gives a clear message and keeps junk off
// the database. It is not the boundary — 001 has the same rules as constraints.
const createBody = {
  type: "object",
  required: ["serial", "deviceType"],
  additionalProperties: false,
  properties: {
    serial: SERIAL,
    deviceType: { type: "string", maxLength: 32 },
    status: { type: "string", maxLength: 32 },
    imei: { ...DIGITS(15, 15), nullable: true },
    iccid: { ...DIGITS(18, 20), nullable: true },
  },
};

const patchBody = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    status: { type: "string", maxLength: 32 },
    deviceType: { type: "string", maxLength: 32 },
    imei: { ...DIGITS(15, 15), nullable: true },
    iccid: { ...DIGITS(18, 20), nullable: true },
  },
};

const shape = (r) => ({
  id: r.id,
  serial: r.serial,
  deviceType: r.device_type,
  status: r.status,
  imei: r.imei,
  iccid: r.iccid,
  imeiCheckDigitOk: r.imei_check_ok,
  iccidCheckDigitOk: r.iccid_check_ok,
  noteCount: r.note_count === undefined ? undefined : Number(r.note_count),
  createdAt: r.created_at,
  createdBy: r.created_by,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

export default async function devices(app) {
  app.addHook("preHandler", authenticate);

  // ── search / browse ─────────────────────────────────────────────────────
  app.get(
    "/devices",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            q: { type: "string", maxLength: 64 },
            type: { type: "string", maxLength: 32 },
            status: { type: "string", maxLength: 32 },
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            offset: { type: "integer", minimum: 0, maximum: 100000, default: 0 },
          },
        },
      },
    },
    async (req) => {
      const { q, type, status, limit, offset } = req.query;
      return withActor(req.identity, async (client) => {
        const { rows } = await client.query(
          "SELECT * FROM registry.search_devices($1, $2, $3, $4, $5)",
          [q ?? null, type ?? null, status ?? null, limit, offset]
        );
        await audit(client, {
          action: "search",
          entity: "devices",
          detail: { q: q ?? "", type: type ?? null, status: status ?? null, hits: rows.length },
          req,
        });
        return {
          results: rows.map((r) => ({ ...shape(r), matchKind: r.match_kind })),
          // Deliberately no total count. Counting every match on a 1M-row
          // table to render "page 1 of N" costs more than the page itself.
          limit,
          offset,
          hasMore: rows.length === limit,
        };
      });
    }
  );

  // ── one device ──────────────────────────────────────────────────────────
  app.get(
    "/devices/:id",
    { schema: { params: { type: "object", properties: { id: { type: "string", format: "uuid" } } } } },
    async (req) => {
      return withActor(req.identity, async (client) => {
        const { rows } = await client.query(
          `SELECT v.*, (SELECT count(*) FROM registry.device_notes n WHERE n.device_id = v.id) AS note_count
             FROM registry.v_devices v WHERE v.id = $1`,
          [req.params.id]
        );
        if (!rows.length) throw notFound("no such device");
        // Reads are audited too. If this register is ever judged to hold
        // personal data by association, who looked at what is the first
        // question asked.
        await audit(client, {
          action: "read",
          entity: "device",
          entityId: req.params.id,
          req,
        });
        return shape(rows[0]);
      });
    }
  );

  // ── register ────────────────────────────────────────────────────────────
  app.post(
    "/devices",
    { schema: { body: createBody }, preHandler: require_("registering a device", CAN.registerDevice) },
    async (req, reply) => {
      const { serial, deviceType, status, imei, iccid } = req.body;
      const created = await withActor(req.identity, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO registry.devices (serial, device_type, status, imei, iccid)
           VALUES ($1, $2, coalesce($3, 'stock'), $4, $5)
           RETURNING *`,
          [serial, deviceType, status ?? null, imei ?? null, iccid ?? null]
        );
        await audit(client, {
          action: "create",
          entity: "device",
          entityId: rows[0].id,
          detail: { serial: rows[0].serial, deviceType, status: rows[0].status },
          req,
        });
        return rows[0];
      });
      reply.code(201);
      return shape(created);
    }
  );

  // ── amend ───────────────────────────────────────────────────────────────
  app.patch(
    "/devices/:id",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string", format: "uuid" } } },
        body: patchBody,
      },
    },
    async (req) => {
      const { status, deviceType, imei, iccid } = req.body;
      const touchesIdentifiers =
        deviceType !== undefined || imei !== undefined || iccid !== undefined;

      // Checked here for a readable 403. Postgres would refuse anyway: a
      // technician holds UPDATE on the status column only.
      if (touchesIdentifiers && !CAN.editIdentifiers.includes(req.identity.role)) {
        throw forbidden(
          `changing identifiers requires one of: ${CAN.editIdentifiers.join(", ")}`
        );
      }
      if (status !== undefined && !CAN.changeStatus.includes(req.identity.role)) {
        throw forbidden("your role cannot change status");
      }

      return withActor(req.identity, async (client) => {
        const sets = [];
        const vals = [];
        for (const [col, val] of [
          ["status", status],
          ["device_type", deviceType],
          ["imei", imei],
          ["iccid", iccid],
        ]) {
          if (val !== undefined) {
            vals.push(val);
            sets.push(`${col} = $${vals.length}`);
          }
        }
        vals.push(req.params.id);
        const { rows } = await client.query(
          `UPDATE registry.devices SET ${sets.join(", ")}
            WHERE id = $${vals.length} AND deleted_at IS NULL
            RETURNING *`,
          vals
        );
        if (!rows.length) throw notFound("no such device, or it has been deleted");
        await audit(client, {
          action: status !== undefined && sets.length === 1 ? "status_change" : "update",
          entity: "device",
          entityId: rows[0].id,
          detail: { changed: Object.keys(req.body), serial: rows[0].serial },
          req,
        });
        return shape(rows[0]);
      });
    }
  );

  // ── soft delete ─────────────────────────────────────────────────────────
  app.delete(
    "/devices/:id",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string", format: "uuid" } } },
        body: {
          type: "object",
          required: ["reason"],
          additionalProperties: false,
          properties: { reason: { type: "string", minLength: 8, maxLength: 500 } },
        },
      },
      preHandler: require_("deleting a device", CAN.softDelete),
    },
    async (req) => {
      return withActor(req.identity, async (client) => {
        const { rows } = await client.query(
          `UPDATE registry.devices
              SET deleted_at = now(), deleted_by = registry.current_actor(),
                  delete_reason = $2
            WHERE id = $1 AND deleted_at IS NULL
            RETURNING id, serial`,
          [req.params.id, req.body.reason]
        );
        if (!rows.length) throw notFound("no such device, or it is already deleted");
        await audit(client, {
          action: "soft_delete",
          entity: "device",
          entityId: rows[0].id,
          detail: { serial: rows[0].serial, reason: req.body.reason },
          req,
        });
        // The row survives so the audit trail keeps its referent. Callers are
        // told what happened rather than being handed a bare 204.
        return { id: rows[0].id, serial: rows[0].serial, deleted: true, retained: "record retained for audit" };
      });
    }
  );

  // ── export ──────────────────────────────────────────────────────────────
  app.get(
    "/devices/export",
    { preHandler: require_("exporting the register", CAN.export) },
    async (req, reply) => {
      const csv = await withActor(req.identity, async (client) => {
        const { rows } = await client.query(
          `SELECT serial, device_type, status, imei, iccid, created_at
             FROM registry.v_devices ORDER BY serial`
        );
        await audit(client, {
          action: "export",
          entity: "devices",
          detail: { rows: rows.length, format: "csv" },
          req,
        });
        const esc = (v) => {
          const s = v === null || v === undefined ? "" : String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const head = "serial,device_type,status,imei,iccid,created_at";
        return [head, ...rows.map((r) => Object.values(r).map(esc).join(","))].join("\n");
      });
      reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="device-register.csv"`);
      return csv;
    }
  );
}
