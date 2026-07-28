# clickhouse-migrations

A minimal, forward-only ClickHouse schema-migration runner for test-infra: a single
self-contained script, `migrate.py`, run with `uv`. Its one dependency is declared
inline (PEP 723), so there is no install step — `uv run` fetches it on demand.

Two commands: `status` (read-only) and `apply` (writes DDL). A ledger table,
`misc.schema_migrations`, records which migrations have been applied.

## Where migrations live

```
clickhouse_db_schema/migrations/
```

Files are named `NNNN_description.sql` — a four-digit zero-padded prefix, e.g.
`0001_create_misc_radar_pr_state.sql` — and are applied in ascending order of the
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

## Connection

Reads the standard test-infra ClickHouse variables from the environment (see
`.env.example`; a `.env` file can be passed with `uv run --env-file .env ...`):

- `CLICKHOUSE_HOST` — host or URL (`https://` prefix and `:8443` suffix are stripped).
  `CLICKHOUSE_ENDPOINT` is accepted as an alias; `CLICKHOUSE_HOST` wins if both are set.
- `CLICKHOUSE_PORT` — optional, defaults to `8443`.
- `CLICKHOUSE_USERNAME`
- `CLICKHOUSE_PASSWORD`

## status

Shows the current (highest applied) version and the pending migrations. Safe to run
with a read-only credential; it never creates the ledger.

```
uv run tools/clickhouse-migrations/migrate.py status
```

## apply

Applies every pending migration in order, recording each in the ledger only after it
succeeds. Requires a credential with DDL (CREATE/ALTER) rights.

```
uv run tools/clickhouse-migrations/migrate.py apply
uv run tools/clickhouse-migrations/migrate.py apply --dry-run   # prints SQL; no DB connection
```

`--dry-run` needs no credentials and no network. Never run `apply` concurrently:
there is no cross-runner lock.

## Services must never run `apply`

Application services (radar and friends) connect with least-privilege credentials
that read and write table *data* only — never DDL. They must **never** run `apply`.
Schema changes are a deliberate, human-run, admin-credentialed step, decoupled from
service deploys.

## Tests

```
uv run --with pytest pytest tools/clickhouse-migrations/test_migrate.py
```
