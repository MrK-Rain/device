# Deployment readiness

What stands between the current repository and a system rain can run in
production. Ordered by what stops you, not by effort.

Severity: **P0** blocks go-live · **P1** needed within the first weeks ·
**P2** should be scheduled

Owner column: **rain** means nobody outside your organisation can supply it.

---

## 1. Blockers — nothing works without these

| # | Item | Sev | Owner | Notes |
|---|---|---|---|---|
| 1.1 | ~~Wire the frontend to the API~~ | P0 | eng | **Done.** `web/src/api-client.js` talks to the real endpoints; `device-index.jsx` searches, creates, edits, deletes and adds notes against the server when `VITE_STORAGE_BACKEND=api`, gated by the caller's role from `/api/meta`. Bulk import, per-note deletion and "clear everything" are disabled in this mode rather than faked, because the API has none of those (1.8, D4). Still open: there is no login UI, so it authenticates with a static bearer token from `VITE_API_TOKEN` — see 1.6 and `.env.example`. That token is a real interim gap, not a placeholder to ignore. |
| 1.2 | **A database to deploy to** | P0 | rain + eng | No cluster exists. Hosting was asked and not yet answered, and it gates items 3.x entirely. |
| 1.3 | **`initdb --data-checksums`** | P0 | DBA | Cannot be enabled later without rebuilding the cluster. Miss it at creation and you carry it forever. |
| 1.4 | **Secret delivery** | P0 | rain + eng | The app reads `PGPASSWORD` from the environment. Nothing decides how it gets there. Prefer IAM or certificate auth over a password. |
| 1.5 | **TLS end to end** | P0 | eng | `pg_hba.conf` must be `hostssl` only, and `PGSSLMODE=verify-full`. `require` encrypts but authenticates nothing, so it will talk happily to an impostor. |
| 1.6 | **IdP configuration** | P0 | rain | `OIDC_JWKS_URI`, `OIDC_ISSUER`, `OIDC_AUDIENCE`, and the real directory group names for `AUTH_ROLE_MAP`. The values shipped are placeholders and match nothing. |
| 1.7 | **Schedule audit partition rotation** | P0 | DBA | `registry.audit()` runs inside every read and write, so exhausted partitions stop the whole register. Migration 004 gives 13 months of runway and a default partition as a net, but the job is still required. Run daily, not monthly: `SELECT registry.ensure_audit_partitions_ahead(3)`. Alert when `v_audit_partition_health.months_headroom < 2` or `rows_in_default > 0`. |
| 1.8 | **Bulk import path** | P0 | eng | Device data "will be provided later" and a million rows cannot come through the API. Needs `COPY` into a staging table, validation against the same rules, and a reconciliation report of what was rejected and why. |

---

## 2. Decisions and inputs only rain can supply

| # | Item | Sev | Notes |
|---|---|---|---|
| 2.1 | **Security policy documents** | P0 | Compliance has not been assessed and cannot be. Everything built reflects general good practice; whether it meets rain's standard is unanswered. |
| 2.2 | **POPIA determination** | P0 | Is a register of ICCIDs and IMEIs personal information, given rain can join them to subscribers? This changes retention, access logging and breach obligations. Needs the privacy office, not an engineer. |
| 2.3 | **Retention periods** | P1 | `drop_audit_partitions_before()` exists and is deliberately unscheduled. How long do audit rows, notes and soft-deleted devices live? |
| 2.4 | **Hosting target** | P0 | AWS, Azure, on-prem. Blocks all infrastructure work. |
| 2.5 | **Named service owner and on-call rota** | P0 | Who is paged at 03:00. |
| 2.6 | **Branch protection** | P0 | Workflows and CODEOWNERS do nothing until enabled in repository settings. List is in the main README. |
| 2.7 | **Replace CODEOWNERS placeholders** | P0 | `@rain/PLACEHOLDER-*`. CODEOWNERS fails silently if a team does not exist or lacks write access. |
| 2.8 | **Vulnerability disclosure route** | P1 | `SECURITY.md` has a marked TODO. A reporter who cannot find a channel usually picks a public one. |
| 2.9 | **Depot offline behaviour** | P1 | A bench that loses the WAN cannot look anything up. Accept it, or fund a depot-local read replica. |
| 2.10 | **Change management for production DDL** | P1 | Who approves a migration reaching production, and how that approval is recorded. |

---

## 3. Infrastructure — none of this exists yet

All of it blocked on 2.4.

| # | Item | Sev | Notes |
|---|---|---|---|
| 3.1 | Primary + **synchronous** standby in a second AZ | P0 | Commit not acknowledged until both hold it. This is what RPO 0 means. |
| 3.2 | Third node as witness | P0 | Two nodes cannot arbitrate a failover without risking split-brain. |
| 3.3 | Continuous WAL archiving to object storage | P0 | Point-in-time recovery. |
| 3.4 | Asynchronous replica in a second region | P1 | Regional failure. |
| 3.5 | **Automated monthly restore test** | P0 | An untested backup is not a backup. This is the single most skipped item on lists like this. |
| 3.6 | API runtime, probes wired to `/health` and `/ready` | P0 | `/health` deliberately does not touch the database — a liveness probe that does will restart healthy instances during a failover. |
| 3.7 | Connection pooler (PgBouncer or equivalent) | P1 | Transaction pooling is safe here: the API uses `SET LOCAL ROLE` and transaction-scoped `set_config`, both of which end with the transaction. Session pooling with plain `SET` would leak one caller's identity into the next request — do not switch to it. |
| 3.8 | Shared rate-limit store | P1 | `@fastify/rate-limit` is in-memory. Across N instances the real limit is N × max, and it resets on every deploy. Needs Redis to mean anything. |
| 3.9 | Log aggregation | P1 | Logs go to stdout with tokens redacted. Nothing ships or retains them. |
| 3.10 | Metrics and alerting | P1 | Replication lag, pool saturation, error rate, audit-write failures, partition headroom, restore-test outcome. |
| 3.11 | Infrastructure as code | P1 | Nothing exists. Clicking it together once is how environments drift. |
| 3.12 | CD pipeline | P1 | Use OIDC federation to the cloud, not long-lived access keys. Environment protection rules on production. |
| 3.13 | Kiosk image for bench terminals | P2 | Read-only root filesystem, unattended upgrades, managed image. Fleet patching is the real cost of Pis. |

---

## 4. Engineering gaps

| # | Item | Sev | Notes |
|---|---|---|---|
| 4.1 | Token revocation | P1 | A leaver's JWT stays valid until it expires. Keep TTLs short, or introspect. |
| 4.2 | Idempotency keys on POST | P1 | A retried registration returns 409 instead of the original result. Clients on flaky depot links will hit this. |
| 4.3 | Note supersession endpoint | P2 | Column and constraint exist; no route uses them, so a mistaken note cannot be corrected. |
| 4.4 | Note search on very common terms | P2 | ~600 ms because it aggregates every match before `LIMIT`; uncommon terms are 1.3 ms. Fix is a bounded two-phase query. |
| 4.5 | Keyset pagination | P2 | `OFFSET 10000` measured 300–470 ms. Only matters if anyone pages that deep. |
| 4.6 | Frontend accessibility pass | P1 | Never audited. Keyboard navigation, contrast, screen reader labels. |
| 4.7 | Error budget / SLO definition | P2 | "Must not fail" needs numbers before anyone can tell whether it is failing. |

---

## 5. Testing not yet done

| # | Item | Sev | Notes |
|---|---|---|---|
| 5.1 | **Audit log at scale** | P0 | The fastest-growing table here and it has never held rows under load. Growth rate, partition rotation under write pressure, query cost against a year of history. |
| 5.2 | **Failover drill** | P0 | Never tested. Promote the standby, measure the gap, confirm nothing was lost. |
| 5.3 | **Restore drill** | P0 | Restore to a point in time from WAL archive, verify integrity. |
| 5.4 | Load test with realistic distribution | P1 | Synthetic data correlates type with status perfectly and has four note bodies. Concurrency beyond 4 clients and one core is untested. |
| 5.5 | Penetration test and threat model | P0 | Neither exists. |
| 5.6 | Autovacuum and bloat over time | P2 | Measured once; behaviour over months of churn is unknown. |
| 5.7 | **UAT with actual technicians** | P0 | Nobody who will use this has seen it. Cheapest place to find out the workflow is wrong. |
| 5.8 | Kiosk hardware test | P1 | Real Pi, real screen, real barcode scanner. |

---

## 6. Operational readiness

| # | Item | Sev | Notes |
|---|---|---|---|
| 6.1 | Runbooks | P0 | Failover, point-in-time restore, partition exhaustion, credential rotation, "the API is 500ing". |
| 6.2 | Go-live checklist and rollback plan | P0 | For schema changes, "revert the PR" is not a rollback. |
| 6.3 | Training for technicians and warehouse | P1 | Including *why* the personal-data rule exists — people route around rules they think are arbitrary. |
| 6.4 | Access review process | P1 | Who grants and revokes registry roles in the directory, and how often membership is reviewed. |
| 6.5 | Incident and breach procedure | P0 | Tied to 2.2. If this is POPIA-relevant data, notification timelines apply. |

---

## Already done, for contrast

- Schema, tested at 1M devices — 4 migrations, all applied clean from empty
- **61 control tests** gating CI, exiting non-zero on failure, and CI proves the
  suite can fail by removing a constraint and checking it catches it
- API with authorisation enforced by Postgres grants rather than application
  logic, **35 integration tests** against a real database, no mocks
- Every read and write audited inside the same transaction as the change
- Two-tier personal-data screening, server-side, with owned acknowledgement
- Migrations append-only and checksum-verified; CI rejects edits to applied ones
- Secret scanning, dependency audit, CodeQL, data-minimisation asserted against
  the live catalog

---

## If you only do five things first

1. **1.1** — wire the frontend to the API, so there is something to evaluate
2. **2.4** — decide hosting, which unblocks all of section 3
3. **2.1 and 2.2** — get the policies and the POPIA determination in writing
4. **1.7** — schedule partition rotation, because the alternative is dated
5. **5.7** — put it in front of a technician before building anything else
