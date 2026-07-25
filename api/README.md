# Device Registry API

HTTP interface to the register. Node 20, Fastify, Postgres.

## The one design decision worth understanding

**Authorisation is enforced by Postgres, not by this service.**

The API connects as `registry_app`, a role created `NOINHERIT` in migration
003. It holds membership of the four registry roles but inherits none of
their privileges, so on its own it can do nothing at all. Every request opens
a transaction that assumes the caller's role:

```sql
SET LOCAL ROLE registry_technician;
SET LOCAL registry.actor      = 'someone@rain';
SET LOCAL registry.actor_role = 'technician';
```

`SET LOCAL` reverts when the transaction ends, so a pooled connection cannot
leak one caller's identity into the next request. Plain `SET` would persist
for the life of the connection and silently misattribute everything after it.

Two consequences that are the point of the exercise:

- A bug in this service **cannot** let a technician edit an IMEI. The column
  grant in migration 001 refuses it regardless of what the JavaScript does.
- A forgotten `SET LOCAL ROLE` produces "permission denied", not a request
  running with the union of every privilege. The failure mode is closed.

The `CAN` table in `src/config.js` duplicates the same boundaries. That is for
returning a readable 403 rather than a raw database error — it is not the
security, and it must never be the only check.

## Running it

```bash
npm ci

# Point at a database that has migrations 001-003 applied
export PGHOST=localhost PGDATABASE=registry
export PGUSER=registry_app PGPASSWORD=...   # from the secret store

# Production: verify the token against your IdP
export AUTH_MODE=oidc
export OIDC_JWKS_URI=https://idp.example/.well-known/jwks.json
export OIDC_ISSUER=https://idp.example/
export OIDC_AUDIENCE=device-registry
export AUTH_ROLE_MAP='{"rain-device-managers":"manager", ...}'

npm start
```

`AUTH_MODE=dev` accepts static tokens with no signature verification, for
tests. `config.js` refuses to start if it is combined with
`NODE_ENV=production`, and CI asserts that refusal.

## Endpoints

| Method | Path | Roles |
|---|---|---|
| GET | `/health` | none — liveness, does not touch the database |
| GET | `/ready` | none — readiness, does |
| GET | `/api/meta` | any |
| GET | `/api/devices?q=&type=&status=&limit=&offset=` | any |
| GET | `/api/devices/:id` | any |
| POST | `/api/devices` | warehouse, manager |
| PATCH | `/api/devices/:id` | status: any writer · identifiers: warehouse, manager |
| DELETE | `/api/devices/:id` | manager, reason required |
| GET | `/api/devices/export` | manager |
| GET | `/api/devices/:id/notes` | any |
| POST | `/api/devices/:id/notes` | technician, warehouse, manager |
| GET | `/api/notes/search?q=` | any |

Search returns no total count. Counting every match on a million-row table to
render "page 1 of N" costs more than the page does; `hasMore` is enough to
drive a Next button.

## Adding a note, and the two tiers of screening

`POST /api/devices/:id/notes` is where the no-personal-data rule is felt.

- **Unambiguous findings** — an email address, a South African ID number, a
  mobile number, a date of birth, a street address — are refused by the
  database trigger and return **422**. There is no override.
- **Ambiguous findings** — a word like "subscriber" — return **409** with
  `code: advisory_review_required` and the findings. Resubmitting with
  `acknowledgeAdvisory: true` writes the note and records the acknowledgement
  against the caller's name. It is a decision someone owns, not a checkbox
  that vanishes.

## Audit

Every read, search, create, update, delete and export writes a row through
`registry.audit()` **inside the same transaction**, so an audit entry cannot
survive a rolled-back change or go missing from one that committed.

Search terms are screened before they are recorded. Someone searching a phone
number would otherwise write that phone number into the audit log, and a
register that refuses personal data in its notes should not accumulate it in
its own trail.

## Tests

```bash
AUTH_MODE=dev NODE_ENV=test \
PGUSER=registry_app PGPASSWORD=... PGDATABASE=registry_test PGSSLMODE=disable \
npm test
```

35 integration tests against a real database. There are no mocks — the whole
design rests on Postgres enforcing authorisation, and a mocked database would
test nothing but the mock.

Set `TEST_ADMIN_DATABASE_URL` to let teardown remove fixtures. It needs owner
rights because no application role can `DELETE` from any of these tables,
which is deliberate.

## Not implemented

- **Bulk import.** A million rows must go through `COPY` into a staging
  table, not this API.
- **Note supersession endpoint.** The column and constraint exist; there is
  no route to use them yet.
- **Pagination beyond `OFFSET`.** Fine for the first pages, degrades deep;
  keyset paging is the fix if anyone ever needs it.
- **Idempotency keys** on POST. A retried device registration currently
  returns 409 rather than the original result.
- **Any caching.** Every request hits the database.
