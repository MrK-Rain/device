/**
 * Translating Postgres refusals into HTTP.
 *
 * The database is the authority on what is allowed, so its errors carry the
 * real reasons. Mapping them here means a constraint added in a migration
 * produces a sensible API response without anyone editing the API.
 *
 * What is never done: forwarding a raw driver error to the client. Those
 * carry table names, constraint names and sometimes row contents.
 */

export class ApiError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const badRequest = (m, d) => new ApiError(400, "bad_request", m, d);
export const unauthorized = (m = "authentication required") =>
  new ApiError(401, "unauthorized", m);
export const forbidden = (m = "not permitted for your role") =>
  new ApiError(403, "forbidden", m);
export const notFound = (m = "not found") => new ApiError(404, "not_found", m);
export const conflict = (m, d) => new ApiError(409, "conflict", m, d);
export const unprocessable = (m, d) => new ApiError(422, "unprocessable", m, d);

const CONSTRAINT_MESSAGES = {
  devices_serial_norm_key: ["conflict", "that serial is already registered"],
  devices_imei_key: ["conflict", "that IMEI is already registered to another device"],
  devices_iccid_key: ["conflict", "that ICCID is already registered to another device"],
  devices_imei_fmt: ["unprocessable", "IMEI must be exactly 15 digits"],
  devices_iccid_fmt: ["unprocessable", "ICCID must be 18 to 20 digits"],
  devices_serial_len: ["unprocessable", "serial must be between 3 and 64 characters"],
  devices_serial_fmt: ["unprocessable", "serial contains characters that are not allowed"],
  devices_serial_no_pii: ["unprocessable", "serial appears to contain personal data"],
  devices_delete_reason: ["unprocessable", "a deletion reason of at least 8 characters is required"],
  devices_delete_pair: ["unprocessable", "deletion requires both a timestamp and an actor"],
  notes_body_len: ["unprocessable", "a note must be between 2 and 4000 characters"],
  notes_ack_present: [
    "unprocessable",
    "this note needs an explicit acknowledgement that it contains no personal data",
  ],
};

const BY_KIND = {
  conflict,
  unprocessable,
  forbidden,
  badRequest,
};

/**
 * @param {unknown} err
 * @returns {ApiError}
 */
export function translate(err) {
  if (err instanceof ApiError) return err;

  const code = err?.code;
  const constraint = err?.constraint;
  const message = String(err?.message ?? "");

  if (constraint && CONSTRAINT_MESSAGES[constraint]) {
    const [kind, text] = CONSTRAINT_MESSAGES[constraint];
    return BY_KIND[kind](text);
  }

  switch (code) {
    case "23505": // unique_violation, constraint name not recognised above
      return conflict("that value is already recorded against another device");
    case "23503": // foreign_key_violation
      return unprocessable("device type or status is not one of the permitted values");
    case "23514": // check_violation
      // The screening trigger raises with this code and a message written for
      // a human, so it is safe and useful to pass along.
      if (message.startsWith("note rejected:")) {
        return unprocessable(message.replace(/^note rejected:\s*/, ""), {
          reason: "personal_data",
        });
      }
      if (message.includes("immutable")) {
        return unprocessable(
          "serial and creation details cannot be changed; soft-delete and re-register instead"
        );
      }
      return unprocessable("the database rejected this value");
    case "42501": // insufficient_privilege
      if (message.includes("no actor set")) {
        // A bug in this service, not the caller's fault. Do not blame them.
        return new ApiError(500, "internal", "request was not attributed to an actor");
      }
      if (message.includes("append-only")) {
        return forbidden("audit records cannot be altered");
      }
      return forbidden("your role does not permit that");
    case "57014": // query_canceled — the statement timeout fired
      return new ApiError(504, "timeout", "the query took too long and was cancelled");
    case "40001": // serialization_failure
    case "40P01": // deadlock_detected
      return new ApiError(409, "retry", "concurrent update, please retry");
    case "53300": // too_many_connections
    case "08006": // connection_failure
      return new ApiError(503, "unavailable", "the database is unavailable");
    default:
      return new ApiError(500, "internal", "internal error");
  }
}
