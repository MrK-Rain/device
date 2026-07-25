import { withActor } from "../db.js";
import { audit } from "../audit.js";
import { authenticate, require_ } from "../auth.js";
import { CAN } from "../config.js";
import { notFound } from "../errors.js";

export default async function notes(app) {
  app.addHook("preHandler", authenticate);

  app.get(
    "/devices/:id/notes",
    { schema: { params: { type: "object", properties: { id: { type: "string", format: "uuid" } } } } },
    async (req) =>
      withActor(req.identity, async (client) => {
        const { rows } = await client.query(
          `SELECT n.id, n.kind, n.body, n.created_at, n.created_by,
                  n.supersedes_note_id, n.advisory_findings, n.advisory_ack_by
             FROM registry.device_notes n
             JOIN registry.v_devices v ON v.id = n.device_id
            WHERE n.device_id = $1
            ORDER BY n.created_at DESC`,
          [req.params.id]
        );
        return {
          notes: rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            body: r.body,
            createdAt: r.created_at,
            createdBy: r.created_by,
            supersedesNoteId: r.supersedes_note_id,
            advisoryFindings: r.advisory_findings,
            advisoryAckBy: r.advisory_ack_by,
          })),
        };
      })
  );

  /**
   * Adding a note is the one write where the personal-data rule is felt.
   *
   * Findings come in two tiers. Unambiguous ones — an email address, a South
   * African ID number, a mobile number — are refused outright by the trigger
   * in 001 and surface as a 422. Ambiguous ones, like the word "subscriber",
   * are returned to the caller first, and the note is only written if the
   * caller comes back having explicitly acknowledged it. The acknowledgement
   * is stored against their name, so it is a decision someone owns rather
   * than a checkbox that disappears.
   */
  app.post(
    "/devices/:id/notes",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string", format: "uuid" } } },
        body: {
          type: "object",
          required: ["body"],
          additionalProperties: false,
          properties: {
            body: { type: "string", minLength: 2, maxLength: 4000 },
            kind: { type: "string", enum: ["repair", "observation"], default: "repair" },
            supersedesNoteId: { type: "string", format: "uuid" },
            acknowledgeAdvisory: { type: "boolean", default: false },
          },
        },
      },
      preHandler: require_("adding a note", CAN.addNote),
    },
    async (req, reply) => {
      const { body, kind, supersedesNoteId, acknowledgeAdvisory } = req.body;

      const outcome = await withActor(req.identity, async (client) => {
        const exists = await client.query(
          "SELECT 1 FROM registry.v_devices WHERE id = $1",
          [req.params.id]
        );
        if (!exists.rowCount) throw notFound("no such device, or it has been deleted");

        const { rows: scan } = await client.query(
          "SELECT registry.personal_data_findings($1) AS findings",
          [body]
        );
        const findings = scan[0].findings ?? [];
        const advisory = findings.filter((f) => f.startsWith("advisory:"));

        if (advisory.length && !acknowledgeAdvisory) {
          // Not an error the caller did something wrong — a question they
          // have to answer. 409 rather than 422 so a client can tell the
          // difference between "fix this" and "confirm this".
          return {
            status: 409,
            payload: {
              code: "advisory_review_required",
              message:
                "this note may contain personal data. Confirm it does not, or reword it.",
              findings: advisory,
              resubmitWith: { acknowledgeAdvisory: true },
            },
          };
        }

        const { rows } = await client.query(
          `INSERT INTO registry.device_notes
             (device_id, kind, body, supersedes_note_id, advisory_findings, advisory_ack_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, kind, body, created_at, created_by, advisory_findings, advisory_ack_by`,
          [
            req.params.id,
            kind ?? "repair",
            body,
            supersedesNoteId ?? null,
            advisory,
            advisory.length ? req.identity.actor : null,
          ]
        );
        await audit(client, {
          action: "create",
          entity: "note",
          entityId: rows[0].id,
          detail: {
            deviceId: req.params.id,
            kind: rows[0].kind,
            advisoryAcknowledged: advisory.length > 0,
            findings: advisory,
          },
          req,
        });
        return { status: 201, payload: rows[0] };
      });

      reply.code(outcome.status);
      return outcome.payload;
    }
  );

  // Find devices whose history mentions given terms — the batch-fault query.
  app.get(
    "/notes/search",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["q"],
          additionalProperties: false,
          properties: {
            q: { type: "string", minLength: 2, maxLength: 200 },
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
          "SELECT * FROM registry.search_notes($1, $2, $3, $4, $5)",
          [q, type ?? null, status ?? null, limit, offset]
        );
        await audit(client, {
          action: "search",
          entity: "notes",
          detail: { q, hits: rows.length },
          req,
        });
        return {
          results: rows.map((r) => ({
            deviceId: r.device_id,
            serial: r.serial,
            deviceType: r.device_type,
            status: r.status,
            noteHits: Number(r.note_hits),
            lastMentionAt: r.last_hit_at,
            excerpt: r.excerpt,
          })),
          limit,
          offset,
          hasMore: rows.length === limit,
        };
      });
    }
  );
}
