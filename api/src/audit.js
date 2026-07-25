/**
 * Audit helper.
 *
 * Writes through registry.audit() inside the caller's transaction, so an
 * audit row cannot survive a rolled-back change or go missing from one that
 * committed.
 *
 * One subtlety worth the code: search terms are screened before being
 * recorded. Someone searching a phone number would otherwise write that
 * phone number into the audit log — a register that refuses personal data in
 * its notes should not accumulate it in its own trail.
 */

const REDACTED = "[redacted: personal data]";

export async function audit(client, { action, entity, entityId, detail, req }) {
  const payload = { ...(detail ?? {}) };

  if (typeof payload.q === "string" && payload.q.length) {
    const { rows } = await client.query(
      "SELECT cardinality(registry.blocking_findings($1)) AS hits",
      [payload.q]
    );
    if ((rows[0]?.hits ?? 0) > 0) payload.q = REDACTED;
    else payload.q = payload.q.slice(0, 120);
  }

  await client.query(
    "SELECT registry.audit($1, $2, $3, $4::jsonb, $5::uuid, $6::inet)",
    [
      action,
      entity,
      entityId ?? null,
      JSON.stringify(payload),
      req?.id && /^[0-9a-f-]{36}$/i.test(req.id) ? req.id : null,
      req?.ip ?? null,
    ]
  );
}
