# Device Registry

System of record for device-identifying data across the fleet: serial numbers,
IMEIs, ICCIDs, device type, status, and a per-device repair log.

**It holds no individual data.** There is no field for a name, contact,
address or account, and free text is screened server-side before it is
accepted. A control test asserts against the live catalog that no such column
has been added.

---

## Status — read this before deploying anything

| Component | State |
|---|---|
| Database schema (`db/migrations/`) | **Tested.** Applies clean, 50 control tests pass, benchmarked at 1M devices. |
| Migration runner (`db/migrate.sh`) | **Tested.** Idempotent, advisory-locked, checksum-guarded. |
| CI gates (`.github/workflows/`) | **Written, not yet run on GitHub.** Verified locally as far as a container allows. |
| API layer (`api/`) | **Tested.** 35 integration tests against a real database, all roles exercised. Authorisation enforced by Postgres grants. |
| Frontend (`web/`) | **Prototype only.** Builds and lints, but still talks to browser storage rather than the API. |
| HA / backup / DR | **Not built.** Requirements documented below; no infrastructure code yet. |
| Compliance mapping | **Blocked.** Needs rian's security policy documents. |

The frontend is a working UI specification, not the platform. It holds every
record in memory and writes to a single browser storage key with a ~5MB
ceiling — around 25,000 devices at best, against a target of a million. Its
personal-data screening also runs client-side, so anyone with dev tools walks
past it. The server-side screening in the schema is the actual control.

---

## Quick start

```bash
# 1. Local database
docker compose up -d

# 2. Apply the schema
export PGHOST=localhost PGUSER=dev PGPASSWORD=dev PGDATABASE=registry
./db/migrate.sh

# 3. Prove the controls hold
PGOPTIONS="-c registry.test_mode=on" \
  psql -v ON_ERROR_STOP=1 -f db/tests/001_control_tests.sql

# 4. Frontend
cd web && npm ci && npm run dev
```

The control suite refuses to run unless `registry.test_mode=on` is set,
because it deletes its own `T-*` fixture rows and must never touch production.

---

## Documents

| File | What it is |
|---|---|
| `DEPLOYMENT-READINESS.md` | 40 outstanding items with severity and owner, before go-live |
| `docs/DECISIONS.md` | Why the system is built this way, including what was deliberately not done |
| `docs/TEST-EVIDENCE.md` | What was measured, what testing caught, what is still unverified |
| `SECURITY.md` | Controls implemented, controls explicitly not implemented |
| `api/README.md` | The authorisation model and endpoint reference |

## Layout

```
api/
  src/db.js                     one transaction per request, actor + role bound
  src/auth.js                   OIDC verification, group to role mapping
  src/routes/                   devices, notes, meta
  test/api.test.js              35 integration tests, no mocks
docs/
  DECISIONS.md                  architecture decision record
  TEST-EVIDENCE.md              measurements and defects caught
db/
  migrate.sh                    migration runner
  migrations/001_*.sql          baseline schema — append-only, never edited
  migrations/002_*.sql          note full-text search
  migrations/003_*.sql          NOINHERIT application role
  migrations/004_*.sql          audit partition safety net
  tests/001_control_tests.sql   61 assertions; exits non-zero on any failure
web/
  src/device-index.jsx          the prototype UI
  src/storage-adapter.js        supplies window.storage outside the sandbox
.github/workflows/
  ci.yml                        schema, controls, migration immutability, build
  security.yml                  secrets, dependencies, CodeQL
```

---

## How CI gates changes

The interesting jobs are not the build:

- **Control tests run against a real Postgres** with `--data-checksums`, the
  same as production. Any regression in a stated control fails the build.
- **The suite is proven able to fail.** CI drops a constraint, re-runs the
  suite, and fails if it *passes* — a test harness that cannot report failure
  is decoration.
- **The guard is proven to hold.** CI runs the suite without
  `registry.test_mode` and fails if it executes anyway.
- **Migrations are append-only.** A PR that modifies a migration already on
  `main` is rejected. Two environments disagreeing about what schema they run
  is a change-control failure, and the runner's checksum guard only catches it
  after the fact.
- **Migrations must be idempotent.** CI applies them twice.
- **Dev auth cannot reach production.** CI boots the config with
  `AUTH_MODE=dev NODE_ENV=production` and fails if the process starts.
- **The app role must hold no privilege of its own.** CI connects as
  `registry_app` and fails if it can read anything without assuming a role.

## Branch protection to set on `main`

CODEOWNERS and workflows do nothing on their own. In repository settings:

- Require a pull request, at least one approval, and CODEOWNERS review
- Require status checks: `schema and controls`, `migrations are append-only`,
  `web build`, `secret scan`, `dependency audit`, `static analysis`
- Dismiss stale approvals on new commits
- Require branches to be up to date before merging
- Require signed commits
- Disallow force pushes and deletions
- No bypass for administrators

Replace the placeholder teams in `.github/CODEOWNERS` first — CODEOWNERS
silently does nothing if a named team does not exist or lacks write access.

---

## Production requirements not yet built

Zero data loss and continuous availability come from the cluster topology, not
from the application. What the schema assumes:

- **Synchronous replication** to a standby in a second availability zone.
  Commit is not acknowledged until both hold the write, giving RPO 0. Add a
  third node as witness — two nodes cannot arbitrate a failover without
  risking split-brain.
- **Continuous WAL archiving** to object storage for point-in-time recovery,
  with restores tested monthly. An untested backup is not a backup.
- **An asynchronous replica in a second region** for regional failure.
- **`data_checksums = on`**, set at `initdb`; it cannot be enabled later
  without rebuilding the cluster.
- **ECC memory.** Checksums detect corruption; they do not repair it.
- **Storage with power-loss protection.** Consumer SSDs acknowledge `fsync`
  before the write is durable, which silently breaks the durability guarantee
  everything above depends on.

The full cluster settings this schema assumes are listed at the end of
`db/migrations/001_device_registry.sql`.

### Raspberry Pi as a bench terminal — yes

Distinct from the question below. A Pi running Chromium in kiosk mode against
the central server is a sound and cheap workbench terminal, and the UI is
built for it: the production bundle is 62 kB gzipped, and a USB barcode
scanner presents as a keyboard, types the identifier and sends Enter. The
search field now opens the record automatically on an unambiguous exact
match, so a scan goes straight to the repair log with nothing to tap.

Practical notes:

- **Screen.** The layout goes two-pane at 920px. The official 7" panel is
  800x480 and works, but 480px of height is cramped for the notes log. A
  1024x600 panel or any HDMI monitor is materially better.
- **Harden as a kiosk.** Read-only root filesystem — it stops SD card wear,
  survives yanked power, and reboots to a known state.
- **It holds a session, not data.** That makes the physical-security problem
  much smaller than for a database host, but not zero. Short-lived sessions,
  auto-lock on idle, and device certificates rather than shared credentials.
- **Fleet patching is the real cost.** Twenty depots of Pis need a managed
  image and unattended upgrades, or they quietly rot. Budget for that.
- **Decide the offline behaviour.** A bench that loses the WAN cannot look
  anything up. Either accept it, or run a local read replica at the depot —
  which is the one place a Pi earns a database role.

### On running the system of record on a Raspberry Pi

Capacity is not the obstacle — 1M devices measured at 1.1GB, and exact
identifier lookups at 2–10ms. A Pi 5 with NVMe would serve a few hundred
internal users comfortably.

What rules it out for the system of record is the last three bullets above,
plus: one node is no HA, there is no TPM to hold a disk-encryption key, and
the box fits in a pocket. A Pi is a reasonable **depot-local read cache** that
keeps working when the WAN drops and syncs back to the central cluster. The
system of record stays central.

---

## Measured capacity

All figures from 1,000,000 devices and 200,000 notes on PostgreSQL 16, after
`VACUUM FULL` so the numbers are not inflated by test-load bloat. The test box
had **one vCPU**, so treat latencies as a pessimistic floor.

| Operation | Measured |
|---|---|
| Exact serial lookup (barcode scan), warm | **0.15–0.45 ms** |
| Exact IMEI / ICCID lookup, warm | **0.2–0.5 ms** |
| Partial identifier fragment (trigram) | **4–9 ms** index work |
| Filtered browse, first page of 50 | **~90 ms** |
| Note search, uncommon term | **1.3 ms** |
| Note search, term matching 25% of all notes | **~600 ms** — see below |
| 4 concurrent clients, exact lookups, 1 vCPU | **98 tps, 41 ms average** |

| Storage | Measured |
|---|---|
| Devices, 1M rows | 170 MB heap + 460 MB indexes = **630 MB** |
| Notes | **270 bytes each** all-in, so ~540 MB at 2M notes |
| Status history, 1M rows | ~150 MB |
| Audit log | **untested**; grows fastest of anything here |

Budget **3–4 GB per million devices** for the first year including notes and
audit. Storage is not the constraint; audit growth is the thing to watch.

Throughput is CPU-bound and the per-query work is small, so it scales with
cores. A few hundred internal users doing occasional lookups is comfortably
inside this.

### Known limitations

- **Note search on very common terms is slow.** `search_notes()` aggregates
  every matching note before applying `LIMIT`, so a term appearing in a
  quarter of all notes costs ~600 ms while an uncommon one costs 1.3 ms. The
  fix is a bounded two-phase query returning the most recent N matches. Not
  yet implemented, and the synthetic test data exaggerates it — only four
  distinct note bodies exist, so every word is a common word.
- **Deep pagination degrades.** `OFFSET 10000` measured 300–470 ms because
  Postgres walks the skipped rows. Keyset pagination (`WHERE serial > $last`)
  fixes it. Only matters if anyone actually pages that far, which for a
  register of this kind is unlikely.
- **Note ingestion runs at ~2,700 rows/second** with the screening trigger
  active — six regex passes per row. Irrelevant for a technician writing one
  note; it means a 2M-row historical import takes roughly 12 minutes.

### Not yet tested

- The audit log at scale, under sustained write load, with partition rotation
- Concurrency beyond 4 clients, or on more than one core
- Autovacuum behaviour and bloat over months of real churn
- Failover, replication lag, or recovery from a WAL archive
- Realistic data distribution — the synthetic set correlates device type with
  status perfectly and has only four note bodies

## Loading the initial fleet

Use `COPY` into a staging table, not the paste box in the prototype. Drop the
three `*_trgm` GIN indexes first, load, then rebuild them `CONCURRENTLY` —
pushing a million rows through live GIN indexes is several times slower.

Budget 3–4GB per million devices once notes and a year of audit history exist.

---

## Outstanding

The frontend is not yet wired to the API — `web/src/storage-adapter.js` has
the seam, and its `api` backend throws rather than pretending. That is the
next piece of work, and it is small.

Compliance with rian's security policies **has not been assessed**, because
the policy documents have not been provided. What is implemented reflects
general good practice: least privilege by role, attributed writes, an
append-only audit log, data minimisation asserted in CI. Whether that meets
rian's standard is a separate question that needs the actual documents and a
named reviewer.
