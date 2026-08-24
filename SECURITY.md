# Security

## Reporting a vulnerability

> **TODO(rian):** replace this section with rian's actual disclosure route
> before the repository is shared beyond the immediate team. Do not leave a
> placeholder here — a reporter who cannot find a channel usually picks a
> public one.
>
> Needed: the intake address or portal, the acknowledgement target, and the
> internal owner.

Do not open a public issue for a suspected vulnerability.

## What this system holds

Device-identifying data only: serial numbers, IMEIs, ICCIDs, device type,
status, and repair notes. No names, contacts, addresses or account
identifiers.

**This does not automatically place the register outside POPIA.** An ICCID or
IMEI is device data in isolation, but rian can join it to a subscriber through
its own systems, and data is generally treated as personal where the holder
can re-identify it. The controls that carry that load are access control,
the audit trail and retention limits — not the absence of a name column.
This needs a determination from rian's privacy office; it has not been made.

## Controls implemented

| Control | Where |
|---|---|
| No personal-data columns exist | asserted against the live catalog in the control suite |
| Free text screened for email, SA ID, SA mobile, DOB, street address | `registry.personal_data_findings`, enforced by trigger |
| Ambiguous phrases require a named acknowledger | `notes_ack_present` constraint |
| Every write attributed to an actor | `registry.current_actor()`; writes fail without one |
| Serials and creation metadata immutable | `trg_device_immutable` |
| Notes append-only, corrected by supersession | no UPDATE grant; `supersedes_note_id` |
| Devices never hard-deleted | soft delete with a mandatory reason |
| Audit log append-only, including reads and exports | `trg_audit_append_only` |
| Least privilege by role, including column-level | `GRANT UPDATE (status)` etc. |
| Identifier uniqueness and format enforced in the database | check constraints, partial unique indexes |

Each has a control test. The suite exits non-zero on failure and gates CI.

## Controls NOT implemented

Stated plainly so nobody assumes otherwise:

- **No authentication or authorisation layer.** The database roles exist; the
  API that maps a human to a role does not.
- **No encryption at rest** configured. That is a cluster and storage concern.
- **No TLS enforcement** in the shipped config. `pg_hba.conf` must be
  `hostssl` only; the local compose file deliberately is not.
- **No rate limiting or brute-force protection.**
- **No retention schedule.** `registry.drop_audit_partitions_before()` exists
  but is intentionally unscheduled — the interval is a policy decision.
- **No penetration test, threat model or secure-design review.**

## Secrets

No credentials belong in this repository. `.env` is gitignored, `.env.example`
contains no real values, and CI scans full history with gitleaks. Deployed
environments must take credentials from a secret store, and cloud
authentication should use short-lived OIDC federation rather than long-lived
access keys.
