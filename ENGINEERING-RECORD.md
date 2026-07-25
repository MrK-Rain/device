# Engineering record

Why this system is shaped the way it is, what testing found, and what was
measured. Written during the build so the reasoning survives the people.

Where a decision looks odd, the reason is usually here.

---

## 1. Decisions and their reasons

### Authorisation lives in Postgres, not in the API

The API connects as `registry_app`, created `NOINHERIT`. It holds membership
of the four registry roles but inherits none of their privileges, so alone it
can do nothing. Each request assumes the caller's role for the duration of one
transaction.

A bug in the JavaScript therefore cannot let a technician edit an IMEI — the
column grant refuses it regardless. And a forgotten role switch produces
"permission denied" rather than a request running with every privilege the
service holds. The failure mode is closed.

The `CAN` table in `api/src/config.js` duplicates the same boundaries. That is
for returning a readable 403 instead of a raw database error. It is not the
security and must never become the only check.

### `SET LOCAL`, never plain `SET`

Transaction-scoped, so a pooled connection cannot leak one caller's identity
into the next request. Plain `SET` persists for the life of the connection and
would silently misattribute everything after it — including audit rows.

This also makes the design safe under PgBouncer transaction pooling. Do not
switch to session pooling.

### Device types and statuses are lookup tables, not enums

A status was added during design and will be again. `ALTER TYPE ADD VALUE`
cannot be rolled back inside a transaction; a row insert can.

### Nothing is ever hard-deleted

Devices soft-delete with a mandatory reason. Notes are immutable and corrected
by supersession rather than editing. Repair history that can be rewritten is
not evidence, and an audit row pointing at a deleted device is a dead end.

### Writes require an attributed actor

`registry.current_actor()` raises if the session variable is unset, so there
is no anonymous write path. Attribution is a database guarantee, not an
application convention.

### Trigram for identifiers, full text for prose

Trigram is right for serials, IMEIs and ICCIDs: short, fixed-format, searched
by fragment because a technician reads six digits off a SIM. It is wrong for
sentences — see §2.12.

### Search returns no total count

Counting every match on a million-row table to render "page 1 of N" costs more
than the page. `hasMore` drives a Next button and is enough.

### Audit is written inside the same transaction as the change

So an audit row cannot survive a rolled-back change, or go missing from one
that committed. Reads and exports are audited too, not just writes.

### Search terms are screened before being audited

Someone searching a phone number would otherwise write that number into the
audit log. A register that refuses personal data in its notes should not
accumulate it in its own trail.

### Two tiers of personal-data screening

Unambiguous findings — email, South African ID, mobile number, date of birth,
street address — are refused outright with no override. Ambiguous wording,
like "subscriber", returns a question, and confirming records the
acknowledgement against the person's name. A decision someone owns rather than
a checkbox that vanishes.

Precision on the SA ID detector was the hard part: requiring both a plausible
`YYMMDD` prefix and a passing Luhn check keeps it from firing on the
15–20 digit identifiers this system is full of.

### Migrations are append-only and checksum-verified

The runner records a SHA-256 of every applied file and refuses to run if one
changed. CI additionally rejects a PR that modifies a migration already on
`main`. Two environments disagreeing about what schema they run is a
change-control failure, and the checksum guard only catches it afterwards.

### Control tests are the compliance evidence

61 assertions that every stated control actually enforces. They gate CI and
exit non-zero. CI also removes a constraint and re-runs them, failing the
build if they pass — a harness nobody has seen fail is decoration.

---

## 2. Defects found by testing

Recorded because each one would have shipped looking correct.

| # | Defect | Why it mattered |
|---|---|---|
| 2.1 | Personal-data screening blocked notes by **crashing**, not detecting. `text[] \|\| 'literal'` resolved as `anyarray \|\| anyarray` and raised "malformed array literal". | Notes with emails were refused, so it looked right. The advisory tier never ran at all. The flagship control was theatre. |
| 2.2 | The status-history trigger ran with the caller's rights, so a technician with `UPDATE(status)` but no `INSERT` on the history table could not change status at all. | Fixed with `SECURITY DEFINER`. Found only because the tests exercised each role separately. |
| 2.3 | The audit log was updatable. `REVOKE` does not stop a privileged connection. | Added an append-only trigger. Raises the bar to "a superuser drops the trigger", which is itself loggable. |
| 2.4 | Exact barcode scans were routed through fuzzy search: **118 ms**. | Now 7 ms on a unique index. The commonest query in the system was paying for a capability it never needed. |
| 2.5 | plpgsql cached a generic plan for a parameterised `LIKE`, and Postgres cannot extract trigrams from a pattern it has not seen: **9 ms became 700 ms**. | Rebuilt as dynamic SQL with literal patterns. Injection safety comes from stripping input to `[A-Z0-9]` plus `format %L`. |
| 2.6 | The device view ran a correlated `count(*)` over notes for every candidate row. | Counts are now fetched for the returned page only. |
| 2.7 | No index had `serial` as its trailing column, so a filtered browse sorted the whole fleet to return 50 rows: **770 ms**. | Added the facet indexes; ~90 ms. |
| 2.8 | The first control suite printed FAIL and **exited 0**. | It could never have failed a build. This is the defect that makes the other twelve possible. |
| 2.9 | Making the results helper `SECURITY DEFINER` fixed a permissions error and silently broke the role tests — statements under test then ran as superuser, so four "technician may not…" assertions wrongly reported success. | Recording is now privileged; the statement under test is not. A fix that quietly disables the test it was meant to enable. |
| 2.10 | Nested `$x$` inside a `$$` argument confused the lexer. | Assertions go through a helper. |
| 2.11 | The grep-based schema hygiene check flagged a plpgsql local variable named `name`, and **missed an added `customer_name` column** — because `customer` is not followed by whitespace in `customer_name`. | Replaced with a query against `information_schema`. Text pattern-matching cannot tell a column from a comment. |
| 2.12 | The trigram index on note bodies was **214 MB for 200k notes** versus **3 MB** for tsvector, and nothing used it. | An 80-character sentence yields ~78 trigrams, mostly common English with long posting lists. Migration 002. |
| 2.13 | Fastify configures AJV with `removeAdditional: true`, so unknown fields are **silently stripped**. A client posting `customerName` received 201. | For a register whose premise is refusing personal data, silently discarding a personal-data field while reporting success is the wrong failure. Now rejected. |
| 2.14 | Audit partitions ran only to September, and `registry.audit()` runs inside every read and write. | **The whole register would have stopped on 1 October.** Migration 004: 13 months runway, a DEFAULT partition so exhaustion degrades instead of halting, and headroom in the control suite. |
| 2.15 | Test fixtures used fixed IMEIs. Uniqueness is global, so they passed once and 409'd forever after. | Generated per run with a computed Luhn check digit. |

### Claims corrected during the build

- Reported exact lookups of 183 ms and 321 ms were **cold-cache artifacts
  immediately after a VACUUM**. Warm: 0.15–0.45 ms.
- Reported 746 MB for 200k notes was **mostly bloat from an aborted load**.
  True figure after compaction: 54 MB.
- Two note-search tests failed and the tests were wrong, not the function —
  they searched for a note belonging to the device an earlier section
  soft-deletes. Excluding it was correct behaviour.

---

## 3. Measurements

PostgreSQL 16, 1,000,000 devices, 200,000 notes, **single vCPU**. Latencies
are a pessimistic floor; storage is after `VACUUM FULL`.

| | |
|---|---|
| Exact serial lookup, warm | 0.15–0.45 ms |
| Exact IMEI / ICCID, warm | 0.2–0.5 ms |
| Partial identifier (trigram BitmapOr over three indexes) | 4–9 ms |
| Filtered browse, first page of 50 | ~90 ms |
| Deep pagination, `OFFSET 10000` | 300–470 ms |
| Note search, uncommon term | 1.3 ms |
| Note search, term in 25% of notes | ~600 ms |
| Note ingestion through the screening trigger | ~2,700 rows/sec |
| 4 concurrent clients, exact lookups | 98 tps, 41 ms average |
| Devices, 1M rows | 170 MB heap + 460 MB indexes |
| Notes, all-in | 270 bytes each |
| Planning figure | 3–4 GB per million devices, year one |

Throughput is CPU-bound with small per-query work, so it scales with cores.
Storage is not the constraint; audit growth is.

---

## 4. Positions taken, and why

### The dual-database fallback was declined

The request was two databases, one as fallback. Writing to two independent
databases has no atomic commit: the write lands in A, fails in B, and neither
is trustworthy with nothing to say which is right. It causes the data loss it
is meant to prevent.

What was recommended instead: one cluster, synchronous replication to a
standby in a second AZ (RPO 0), a third node as witness to avoid split-brain,
continuous WAL archiving with tested restores, and an async replica in a
second region.

### A Raspberry Pi cannot be the system of record

Capacity is not the obstacle — 1M devices is 1.1 GB and lookups are
sub-millisecond. The obstacles are no ECC memory, consumer flash that
acknowledges `fsync` before the write is durable, one node being no HA, no TPM
to hold a disk-encryption key, and a box that fits in a pocket.

A Pi is a good **bench terminal**, and a defensible **depot-local read
replica**. The scanner-driven kiosk path is built and documented.

### Compliance was not certified

rain's security policies were requested three times and never provided.
Everything built reflects general good practice; whether it meets rain's
standard is unassessed and unassessable from here. A system marked compliant
against a document nobody checked is more dangerous than one marked pending.

### POPIA scope was flagged, not decided

An ICCID or IMEI is device data in isolation, but rain can join it to a
subscriber through its own systems, and data is generally treated as personal
where the holder can re-identify it. The absence of a name column does not
settle it. This needs a determination from the privacy office; it shapes
retention, access logging and breach obligations.

---

## 5. Where to look

| | |
|---|---|
| What is still needed | `DEPLOYMENT-READINESS.md` — 40 items, severity and owner |
| Setup, capacity, CI gates | `README.md` |
| Controls and what is *not* implemented | `SECURITY.md` |
| Authorisation model, endpoints | `api/README.md` |
| Why a decision was made | this file, and comments in the migrations |
