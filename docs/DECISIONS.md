# Decisions

Why the system is built the way it is, including the places where the
implementation deliberately differs from what was originally asked for.

This exists because code records *what*, comments record *how*, and neither
survives the question "why don't we just…" asked eighteen months from now by
someone with no context. Several entries below are decisions to **not** do
something, which are exactly the ones that get quietly reversed.

---

## D1 — One database with synchronous replication, not two databases

**Asked for:** two databases, one acting as a fallback.

**Built:** a single logical Postgres cluster with a synchronous standby, a
witness node, and continuous WAL archiving.

**Why:** writing to two independent databases has no atomic commit. The write
lands in A, fails in B, and now neither is trustworthy and nothing tells you
which is right. It is one of the best-documented failure modes in distributed
systems, and it *increases* the chance of data loss rather than reducing it.

Synchronous replication gives the actual guarantee the request was reaching
for: the commit is not acknowledged until two nodes hold it, so RPO is zero.
The witness exists because two nodes cannot arbitrate a failover without
risking split-brain.

**If someone proposes reverting this,** the question to ask is: when A and B
disagree, what procedure decides which one is correct? There is no good
answer, which is the point.

---

## D2 — Authorisation enforced by Postgres, not by the API

**Built:** `registry_app` is `NOINHERIT` and holds no privileges of its own.
Every request opens a transaction and assumes the caller's role with
`SET LOCAL ROLE`. Column-level grants in migration 001 decide what each role
can touch.

**Why:** a bug in application code then cannot grant a technician the ability
to edit an IMEI — the database refuses regardless of what the JavaScript
does. And a forgotten role switch produces "permission denied" rather than a
request running with the union of every privilege. The failure mode is closed.

The `CAN` table in `api/src/config.js` duplicates the same boundaries. That is
for returning a readable 403 instead of a raw database error. **It is not the
security and must never become the only check.**

---

## D3 — `SET LOCAL`, never plain `SET`

`SET LOCAL ROLE` and transaction-scoped `set_config` both revert when the
transaction ends. Plain `SET` persists for the life of a pooled connection
and would silently misattribute every subsequent request to the previous
caller.

This also makes the system compatible with PgBouncer in **transaction**
pooling mode. Switching to session pooling with plain `SET` would reintroduce
the leak. Do not.

---

## D4 — Nothing is ever hard-deleted

Devices soft-delete with a mandatory reason of at least eight characters.
Notes are append-only and corrected by supersession, not by editing. Serial
numbers and creation metadata are immutable.

**Why:** a repair history that can be rewritten is not evidence. Soft deletion
also keeps the audit log's referent alive — an audit row pointing at a device
that no longer exists is close to useless during an investigation.

Uniqueness indexes exclude soft-deleted rows, so a serial can be re-registered
after a mistaken entry.

---

## D5 — Every write is attributed, and unattributed writes fail

`registry.current_actor()` raises if the transaction has not declared who is
acting. There is no anonymous write path and no system user that bypasses it.

Cheaper alternatives — a nullable `created_by`, or attribution added by the
application — both degrade to "unknown" under exactly the circumstances where
you need the answer.

---

## D6 — Personal-data screening is server-side, in two tiers

Client-side validation is a usability feature; anyone with dev tools walks
past it. The control lives in a database trigger.

- **Unambiguous** — email, South African ID number, mobile number, date of
  birth, street address — refused outright. No override exists.
- **Ambiguous** — a word like "subscriber" — returned to the caller, who must
  resubmit with an explicit acknowledgement. That acknowledgement is stored
  against their name.

**Why two tiers:** a single strict tier would make technicians fight the tool
and route around it. A single permissive tier would not be a control. The
acknowledgement is a decision someone owns, not a checkbox that vanishes.

The SA ID detector requires both a plausible date prefix and a passing Luhn
check, because a bare 13-digit run is otherwise indistinguishable from a
device identifier.

---

## D7 — No column exists that could hold a person

Asserted in the control suite against `information_schema`, not by grepping
the migration text. The first attempt did grep, and it managed both possible
errors at once: it flagged a plpgsql local variable named `name`, and missed
an actual `customer_name text` column because `customer` is not followed by
whitespace in `customer_name`.

**The schema is the strongest guarantee here.** Screening catches text; the
absence of a field is what makes the category impossible.

---

## D8 — This does not automatically place the register outside POPIA

An ICCID or IMEI is device data in isolation. rain can join it to a subscriber
through its own systems, and data is generally treated as personal where the
holder can re-identify it.

So the controls that carry the load are access control, the audit trail and
retention limits — **not** the absence of a name column. A determination from
the privacy office is outstanding and this design should not be treated as
settled until it exists.

---

## D9 — Trigram for identifiers, full text for prose

Migration 002 replaced a GIN trigram index on note bodies with a `tsvector`
one after measuring **214 MB versus 3 MB** at 200,000 notes.

Trigram is right for identifiers: short, fixed-format, searched by fragment,
which is how a technician reads six digits off a SIM. It is wrong for prose —
an 80-character sentence yields ~78 trigrams, almost all common English
sequences with long posting lists.

Nothing used the trigram index either, so it was pure write amplification.
The behaviour change is that note search now matches whole words with
stemming: `antenna` finds `antennas`, `anten` finds nothing. For prose that
is the better trade.

---

## D10 — Search is built as dynamic SQL with literal patterns

plpgsql caches a generic plan for a parameterised `LIKE`, and Postgres cannot
extract trigrams from a pattern it has not yet seen. Measured 9 ms became
700 ms.

Injection safety comes from stripping the query to `[A-Z0-9]` and `[0-9]`
before use and routing every interpolation through `format %L`. There is a
control test that puts a quote and a backslash through it.

Four separate query paths exist because they need four different plans:
exact serial, exact IMEI/ICCID, empty query with filters, and substring.
Sharing one query let the planner flip to an ordered index scan on a `LIMIT`
and abandon trigram entirely.

---

## D11 — Migrations are append-only and checksum-verified

The runner records a SHA-256 of every applied file and refuses to run if one
changed. CI separately rejects a PR that modifies a migration already on
`main`.

**Why both:** the checksum catches drift after it has shipped; CI catches it
before. Two environments disagreeing about what schema they run is a
change-control failure, not an inconvenience.

---

## D12 — The control suite is a build gate, and CI proves it can fail

The first version printed FAIL and exited zero, which means it could never
have failed a build. It now exits non-zero, and CI drops a constraint,
re-runs the suite, and fails the build if it *passes*.

A test harness nobody has seen fail is decoration.

---

## D13 — Audit rows are written inside the transaction they describe

Not asynchronously, not from application logs. An audit entry cannot survive a
rolled-back change, nor go missing from one that committed.

Reads and exports are audited as well as writes. If this register is ever
judged to hold personal data by association, who looked at what is the first
question asked.

Search terms are screened before being recorded — someone searching a phone
number would otherwise write that phone number into the audit log.

---

## D14 — Unknown request fields are rejected, not ignored

Fastify configures AJV with `removeAdditional: true` by default, silently
stripping undeclared properties. A client posting `customerName` received a
201 and would reasonably believe it had been stored.

For a register whose premise is refusing personal data, silently discarding a
personal-data field while reporting success is the wrong failure twice over.

---

## D15 — Search returns no total count

Counting every match on a million-row table to render "page 1 of N" costs more
than the page does. `hasMore` is enough to drive a Next button.

---

## D16 — Lookup tables, not enums, for device types and statuses

A status was added during design and will be again. `ALTER TYPE ADD VALUE`
cannot be rolled back inside a transaction; a row insert can. The lookup
tables also carry `is_available`, `is_terminal` and `sort_order`, which an
enum cannot.

---

## D17 — A Raspberry Pi is a bench terminal, not the system of record

**Capacity is not the obstacle** — 1M devices measured at 1.1 GB with
sub-millisecond identifier lookups. A Pi 5 would serve the read load easily.

What rules it out for the database: no ECC memory, so bit flips corrupt data
that checksums can detect but not repair; consumer flash acknowledges `fsync`
before the write is durable, which breaks the durability guarantee everything
else depends on; one node is no HA; and there is no TPM to hold a
disk-encryption key on a device that fits in a pocket.

As a kiosk it is a good fit and the UI supports it: an unambiguous exact
identifier match opens the record automatically, so a barcode scan needs no
touch. A depot-local **read replica** is the one place a Pi earns a database
role, because losing it loses nothing.

---

## D18 — The prototype UI is a specification, not the platform

It holds every record in memory and writes to a single browser storage key
with a ~5 MB ceiling — roughly 25,000 devices against a target of a million.
It was built to establish the workflow and it does that well. It was never
going to be the deployed system, and improving it would not change that.

---

## D19 — The default audit partition is a net, not a plan

`registry.audit()` runs inside every read and write, so exhausted partitions
stop the entire register — a dated outage, originally 1 October 2026. The
default partition converts that into a degraded state needing cleanup.

Rows accumulating in it mean rotation has stopped, and creating a partition
overlapping those rows will fail until they are drained. **Alert on it being
non-empty. Do not let it become normal.**

The rotation job runs daily rather than monthly: a monthly job has twelve
chances a year to be silently broken.

---

## D20 — Compliance with rain's security policies is not claimed

The policy documents were not provided, so no assessment was made and none is
implied. What is implemented reflects general good practice: least privilege,
attributed writes, an append-only audit trail, data minimisation asserted in
CI.

**A system marked "compliant" against a document nobody checked is more
dangerous than one marked "pending review", because it gets signed off.**

---

## D21 — GitLab CI is a port, not a drop-in equivalent

**Built:** `.gitlab-ci.yml`, alongside the existing `.github/workflows/`
rather than replacing it, covering the same jobs: schema and controls, API
integration tests, migration immutability, web build, secret scanning,
dependency audit, and schema hygiene.

**Two places it is not equivalent, on purpose:**

- **Static analysis.** CodeQL is GitHub-native. GitLab's free-tier substitute
  is the semgrep-based SAST template (`Jobs/SAST.gitlab-ci.yml`), included
  here. It is a different engine with different coverage — treat a clean run
  as "semgrep found nothing," not as "CodeQL-equivalent found nothing."
- **Secret scanning.** GitLab ships a built-in Secret Detection template, but
  it scans only the merge request diff by default. Invariant #8 requires
  full-history scanning, so this uses a hand-rolled `gitleaks` job with
  `GIT_DEPTH: "0"` instead — same tool as the GitHub Action, same guarantee.
  Switching to the built-in template later would silently weaken this control.

**Still open:** the weekly schedule (Monday 04:00 UTC in the GitHub workflow)
has no equivalent in this file — GitLab schedules are created once in the UI
under CI/CD > Schedules, not in YAML. Nobody has created it yet.
