# clickhouse-migrations

A minimal, forward-only ClickHouse schema-migration runner for test-infra:
`migrate.py`, run with `uv` (its pure discovery/validation/ordering/checksum logic
lives in the sibling `migrate_lib.py`). The one runtime dependency is declared inline
(PEP 723), so there is no install step — `uv run` fetches it on demand.

Two commands: `status` (read-only) and `apply` (writes DDL). A ledger table,
`misc.schema_migrations`, records which migrations have been applied, along with a
`checksum` of each so a later edit to an applied migration can be detected as drift.

## Where migrations live

```
clickhouse_db_schema/migrations/
```

Files are named `NNNN_description.sql` — a four-digit zero-padded prefix, e.g.
`0001_create_misc_greenlight_pr_state.sql` — and are applied in ascending order of the
prefix. Override the directory with `--migrations-dir <path>` or `CH_MIGRATIONS_DIR`.

## Authoring a migration

1. Pick the next number: highest existing `NNNN` + 1, zero-padded to four digits.
2. **One statement per file.** The whole file is executed as a single ClickHouse
   command; there is no statement splitter. Put exactly one statement per file and no
   trailing `;`.
3. **Make it idempotent — use `IF [NOT] EXISTS`.** ClickHouse has no DDL
   transactions, and a migration is recorded only after it succeeds, so a re-run must
   be safe: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
4. On ClickHouse Cloud, write the engine explicitly with the keeper path, replica,
   and version column, e.g.
   `SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', version)`.
5. **Never edit an applied migration.** Its checksum is recorded on apply; changing
   the file afterwards is reported as drift (see below). To change a table, add the
   next-numbered migration. The checksum normalizes **only** line endings (CRLF/CR to
   LF) and a trailing end-of-file newline; every other change — including trailing
   whitespace, indentation, and comments — trips drift. This is conservative by
   design: do not reformat an applied migration.

Both commands validate the whole set before doing anything: a version claimed by two
files, an empty or comment-only body, or more than one statement in a file is a hard
error. A `*.sql` file whose name is not `NNNN_description.sql` (four-digit prefix,
non-empty description) is skipped with a warning rather than silently ignored.

## Connection

Reads the standard test-infra ClickHouse variables from the environment (see
`.env.example`; a `.env` file can be passed with `uv run --env-file .env ...`):

- `CLICKHOUSE_HOST` — host or URL (`https://` prefix and `:8443` suffix are stripped).
  `CLICKHOUSE_ENDPOINT` is accepted as an alias; `CLICKHOUSE_HOST` wins if both are set.
- `CLICKHOUSE_PORT` — optional, defaults to `8443`.
- `CLICKHOUSE_USERNAME`
- `CLICKHOUSE_PASSWORD`

## status

Shows the current (highest applied) version and the pending migrations, and reports
any ordering issues (as warnings) and any drift (exit code 1). Safe to run with a
read-only credential: it only reads `system.tables`, `system.columns`, and the ledger,
and never creates or alters anything — not even to add the `checksum` column.

```
uv run tools/clickhouse-migrations/migrate.py status
```

## Ordering (forward-only)

Migrations apply in ascending version order and the runner is forward-only:

- A pending migration numbered **below** the highest applied version (someone slipped
  `0007` in after `0009` shipped) is refused by `apply`. Pass `--allow-out-of-order`
  to apply it anyway; `status` always reports it as a warning.
- A **gap** in the sequence (missing `0008`) is only a warning — apply proceeds.
- A **duplicate** version (two files, same `NNNN`) is always a hard error and is never
  overridable.

## Checksums and drift

On `apply`, each migration's checksum is recorded in the ledger. Before applying,
`apply` re-checks every already-applied migration: if a file's current checksum no
longer matches what was recorded, that is **drift** and the whole run is refused (fix
the drift or add a new forward migration — never edit the applied file). Rows recorded
before checksums existed store an empty checksum and are skipped. `status` reports
drift with exit code 1 but, being read-only, never repairs it.

## apply

Applies every pending migration in order, recording each in the ledger only after it
succeeds. Requires a credential with DDL (CREATE/ALTER) rights.

```
uv run tools/clickhouse-migrations/migrate.py apply
uv run tools/clickhouse-migrations/migrate.py apply --dry-run            # prints SQL; no DB connection
uv run tools/clickhouse-migrations/migrate.py apply --allow-out-of-order # apply a below-frontier migration
```

`--dry-run` needs no credentials and no network; it prints the SQL and runs the same
pre-flight validation.

**Partial failure.** A migration's DDL runs first, then its ledger row is written. If
the DDL succeeds but the ledger write then fails, `apply` prints a `CRITICAL` line
naming the version and stops immediately. Re-running is safe **only** if that migration
is idempotent (`IF [NOT] EXISTS`); otherwise insert the ledger row by hand before
re-running so the statement is not applied twice.

**Concurrency.** There is no cross-runner lock. Never run `apply` from two places at
once (two admins, a retrying CI job, a cron overlap): concurrent runs can each see the
same pending set and apply a non-idempotent statement twice. Treat `apply` as a
single, deliberate, single-operator action.

## Services must never run `apply`

Application services (PyTorch Green Light and friends) connect with least-privilege credentials
that read and write table *data* only — never DDL. They must **never** run `apply`.
Schema changes are a deliberate, human-run, admin-credentialed step, decoupled from
service deploys.

## Tests

Run with coverage (branch coverage and the `fail_under` gate are configured in
`.coveragerc`; `--cov-config` points at it since the command runs from the repo root):

```
uv run --with pytest --with pytest-cov pytest \
  --cov-config=tools/clickhouse-migrations/.coveragerc \
  --cov=migrate --cov=migrate_lib \
  tools/clickhouse-migrations/test_migrate.py
```

The suite never touches a real ClickHouse — it drives the runner through an in-memory
fake client.
