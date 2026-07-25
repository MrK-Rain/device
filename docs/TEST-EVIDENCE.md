# Test evidence

What was measured, what testing caught, and what remains unverified.

Kept as a separate record because "we tested it" is not evidence, and because
the defects below are the argument for why the control suite gates the build.

---

## Environment

PostgreSQL 16.14, **single vCPU**, 512 MB `shared_buffers`, `--data-checksums`
enabled. Treat every latency as a pessimistic floor; a production host will
have more cores and the workload is CPU-bound with small per-query work.

Dataset: 1,000,000 devices, 200,000 notes, sizes taken after `VACUUM FULL` so
they are not inflated by aborted test loads.

---

## Measured performance

| Operation | Result |
|---|---|
| Exact serial lookup (barcode scan), warm | **0.15–0.45 ms** |
| Exact IMEI / ICCID lookup, warm | **0.2–0.5 ms** |
| Partial identifier fragment, trigram | 4–9 ms index work |
| Filtered browse, first page of 50 | ~90 ms |
| Deep pagination, `OFFSET 10000` | 300–470 ms |
| Note search, uncommon term | 1.3 ms |
| Note search, term matching 25% of notes | ~600 ms |
| Note ingestion through the screening trigger | ~2,700 rows/sec |
| 4 concurrent clients, exact lookups, 1 vCPU | 98 tps, 41 ms average |

## Measured storage

| Object | Result |
|---|---|
| Devices, 1M rows | 170 MB heap + 460 MB indexes = **630 MB** |
| Notes | **270 bytes each**, all-in — ~540 MB at 2M notes |
| Status history, 1M rows | ~150 MB |
| Trigram index on note bodies (removed) | 214 MB at 200k notes |
| Full-text index replacing it | **3 MB** at 200k notes |

Planning figure: **3–4 GB per million devices** for the first year including
notes and audit history.

---

## Defects that testing caught

Listed because each one would have shipped, and several looked correct from
the outside.

### 1. Personal-data screening blocked notes by crashing, not detecting

`text[] || 'literal'` resolved as `anyarray || anyarray` and raised "malformed
array literal" on every match. Notes containing an email address *were*
refused — so it looked like the control worked — but the function was
erroring, and advisory detection never ran at all.

**The most dangerous class of bug here:** a control that appears to work.

### 2. Technicians could not change device status at all

The status-history trigger inserted into a table the technician role has no
`INSERT` grant on. Fixed with `SECURITY DEFINER`, so the trail is written on
behalf of the schema owner regardless of who triggered it.

### 3. The audit log was editable

`REVOKE` expresses intent; it does not stop a privileged connection. Now
enforced by a trigger that refuses `UPDATE` and `DELETE` outright.

### 4. The control suite reported four false passes

Making the results helper `SECURITY DEFINER` fixed a permissions error but
caused the statements *under test* to run as the owner — so four
"technician may not…" assertions reported that the technician could. Recording
is now privileged; the statement under test is not.

### 5. Barcode scans were routed through fuzzy search

118 ms for the single commonest query in the system. Exact identifier lookups
now short-circuit to the unique index: **7 ms**, and 0.15 ms warm.

### 6. Substring search was 80× slower than the SQL allowed

plpgsql cached a generic plan; Postgres cannot extract trigrams from a pattern
it has not seen. The raw SQL measured 9 ms, the function 700 ms.

### 7. A 214 MB index that nothing used

GIN trigram on note bodies, never referenced by any query, heading for ~2 GB
at 2M notes. Replaced with a 3 MB full-text index.

### 8. Fastify silently stripped unknown request fields

`removeAdditional: true` is the default. A client posting `customerName`
received a 201 and would believe it was stored.

### 9. A dated outage in the audit log

Partitions existed for three months. `registry.audit()` runs inside every read
and write, so on 1 October 2026 the entire register — searches included —
would have stopped. Now 13 months of runway, a default partition as a net, and
headroom asserted in the suite.

### 10. Schema hygiene by grep did not work

The first data-minimisation check flagged a plpgsql local variable named
`name` and missed an added `customer_name` column. Replaced with a query
against `information_schema`.

### 11. Fixed test identifiers collided across runs

IMEI and ICCID uniqueness is global, so literals passed once and returned 409
forever after. Tests now generate Luhn-valid identifiers per run.

---

## Current suite

| Suite | Count | Gate |
|---|---|---|
| Database control tests | **61** | exits non-zero; CI proves it by removing a constraint and checking the suite catches it |
| API integration tests | **35** | real database, all four roles, no mocks |

CI additionally asserts:

- Migrations apply twice with the second run a no-op
- Migration checksums verify
- No PR modifies a migration already on `main`
- The control suite refuses to run without its `test_mode` guard
- `AUTH_MODE=dev` cannot boot under `NODE_ENV=production`
- `registry_app` can read nothing without assuming a role

---

## Not verified

Stated plainly so nobody reads the numbers above as broader assurance.

- **The audit log at scale.** The fastest-growing table here has never held
  rows under load. Growth rate, rotation under write pressure, and query cost
  against a year of history are all unknown.
- **Concurrency beyond 4 clients** or on more than one core.
- **Failover, replication lag, and recovery from a WAL archive.** No cluster
  exists to test against.
- **Autovacuum and bloat** over months of real churn.
- **Realistic data distribution.** The synthetic set correlates device type
  with status perfectly and contains four distinct note bodies, which
  exaggerates the common-term search weakness and makes the check-digit
  partial index useless in testing.
- **Penetration test and threat model.** Neither has been done.
- **Accessibility.** The UI has never been audited.
- **Real hardware.** No test on a Pi, a bench screen, or a barcode scanner.
- **Anything about rain's security policies.** Not provided, not assessed.
