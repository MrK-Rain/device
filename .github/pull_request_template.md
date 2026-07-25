## What changes

<!-- One or two sentences. -->

## Why

<!-- Link the ticket. -->

## Checks

- [ ] `db/migrate.sh --status` reviewed; no existing migration was edited
- [ ] Control tests pass locally (`registry.test_mode=on`)
- [ ] New behaviour has a control test, or an explicit note below saying why not
- [ ] No personal data field, column, log line or fixture added
- [ ] No credentials, connection strings or hostnames in the diff
- [ ] Rollback described below if this touches the schema

## Data protection

- [ ] This change does not widen who can read device records
- [ ] This change does not reduce what the audit log captures

<!-- If either is unchecked, say what changed and who signed it off. -->

## Rollback

<!-- For schema changes: the exact steps. "Revert the PR" is not a plan for a
     migration that has already run. -->
