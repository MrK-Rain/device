import { withActor, ping } from "../db.js";
import { authenticate } from "../auth.js";

export default async function meta(app) {
  // Liveness: is the process up. No database, no auth — a probe that depends
  // on the database will restart a healthy pod during a brief failover.
  app.get("/health", { logLevel: "warn" }, async () => ({ status: "ok" }));

  // Readiness: should traffic be routed here. This one does check the database.
  app.get("/ready", { logLevel: "warn" }, async (_req, reply) => {
    try {
      const ok = await ping();
      if (!ok) throw new Error("unexpected ping result");
      return { status: "ready" };
    } catch {
      reply.code(503);
      return { status: "not_ready", reason: "database unreachable" };
    }
  });

  app.get("/meta", { preHandler: authenticate }, async (req) =>
    withActor(req.identity, async (client) => {
      const [types, statuses] = await Promise.all([
        client.query(
          "SELECT code, label, short_code FROM registry.device_types WHERE is_active ORDER BY sort_order"
        ),
        client.query(
          "SELECT code, label, is_available, is_terminal FROM registry.device_statuses WHERE is_active ORDER BY sort_order"
        ),
      ]);
      return {
        deviceTypes: types.rows.map((r) => ({
          code: r.code,
          label: r.label,
          shortCode: r.short_code,
        })),
        statuses: statuses.rows.map((r) => ({
          code: r.code,
          label: r.label,
          isAvailable: r.is_available,
          isTerminal: r.is_terminal,
        })),
        you: { actor: req.identity.actor, role: req.identity.role },
      };
    })
  );
}
