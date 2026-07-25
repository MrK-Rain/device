import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

import { config } from "./config.js";
import { translate } from "./errors.js";
import { close as closeDb } from "./db.js";
import devices from "./routes/devices.js";
import notes from "./routes/notes.js";
import meta from "./routes/meta.js";

export async function build(opts = {}) {
  const app = Fastify({
    // Never derive request identity or client IP from headers unless we know
    // a proxy is in front. Otherwise a caller sets X-Forwarded-For and both
    // the rate limiter and the audit log believe them.
    trustProxy: config.trustProxy,
    genReqId: (req) => req.headers["x-request-id"] ?? randomUUID(),
    bodyLimit: 256 * 1024,
    // Fastify configures AJV with removeAdditional: true by default, which
    // silently strips properties the schema does not declare. For this API
    // that is the wrong default twice over: a client that posts a field we
    // do not recognise gets a 201 and believes it was stored, and a client
    // that posts something like customerName gets no signal that a register
    // which forbids personal data just discarded it. Reject instead.
    ajv: {
      customOptions: {
        removeAdditional: false,
        useDefaults: true,
        coerceTypes: true, // query strings arrive as text; limit/offset are ints
        allErrors: false,
      },
    },
    disableRequestLogging: true, // replaced below with a redacted version
    logger: {
      level: process.env.LOG_LEVEL ?? (config.isProd ? "info" : "debug"),
      redact: {
        // A bearer token in a log file is a credential in a log file.
        paths: ["req.headers.authorization", "req.headers.cookie", "body.body"],
        censor: "[redacted]",
      },
      serializers: {
        req: (r) => ({ method: r.method, url: r.url, id: r.id }),
      },
    },
    ...opts,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false, // this serves JSON, not documents
    hsts: config.isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.windowMs,
    // Per authenticated user where possible, so one busy depot cannot
    // exhaust the budget for everyone behind the same NAT.
    keyGenerator: (req) => req.identity?.actor ?? req.ip,
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  app.addHook("onResponse", async (req, reply) => {
    req.log.info({
      id: req.id,
      method: req.method,
      url: req.url,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
      actor: req.identity?.actor,
      role: req.identity?.role,
    });
  });

  app.setErrorHandler((err, req, reply) => {
    // Fastify's own schema failures arrive with validation attached.
    if (err.validation) {
      reply.code(400);
      return {
        error: "bad_request",
        message: "the request did not match the expected shape",
        detail: err.validation.map((v) => `${v.instancePath || "body"} ${v.message}`),
        requestId: req.id,
      };
    }

    const api = translate(err);

    // 5xx means we broke something; log the original with a stack. 4xx is the
    // caller being told no, which is not an incident.
    if (api.status >= 500) {
      req.log.error({ err, id: req.id }, "request failed");
    } else {
      req.log.warn({ id: req.id, code: api.code, status: api.status }, api.message);
    }

    reply.code(api.status);
    return {
      error: api.code,
      message: api.message,
      ...(api.detail ? { detail: api.detail } : {}),
      requestId: req.id,
    };
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404);
    return { error: "not_found", message: "no such endpoint", requestId: req.id };
  });

  await app.register(meta);
  await app.register(devices, { prefix: "/api" });
  await app.register(notes, { prefix: "/api" });

  return app;
}

// Only start a server when run directly, so tests can build the app in-process.
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await build();

  const shutdown = async (signal) => {
    app.log.info({ signal }, "shutting down");
    // Stop accepting first, then drain the pool, so in-flight transactions
    // commit rather than being cut off mid-write.
    try {
      await app.close();
      await closeDb();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "shutdown failed");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(
      { mode: config.auth.mode, env: config.nodeEnv },
      "device registry API listening"
    );
  } catch (err) {
    app.log.error({ err }, "failed to start");
    process.exit(1);
  }
}
