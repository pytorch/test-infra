# clickhouse db schema
Table schemas used to create tables and materialized view tables in clickhouse.

## Add new table
Currently we do not have automation to upstream the table schema to clickhouse.

Please follow [How-to-add-a-new-custom-table-on-ClickHouse](https://github.com/pytorch/test-infra/wiki/How-to-add-a-new-custom-table-on-ClickHouse).

In order to create table or grant the permissions/roles in clickhouse, please reach out @clee2000 or @huydhn.

Each table is declared once as a per-table `schema.sql` (a snapshot of the current
shape), optionally alongside a `grants.sql` for its permissions. There is no automated
upstreaming — the SQL here is applied to ClickHouse by hand.

## Database directories

A directory named after a database rather than a table holds numbered,
forward-only migration files for every table of one feature; `fortesting/`, the
sandbox, holds three small examples. `migrate.py` applies the files not yet
recorded in that database's `schema_migrations` table:

```sh
export CLICKHOUSE_ENDPOINT=<host> CLICKHOUSE_USERNAME=<user> CLICKHOUSE_PASSWORD=<password>
cd clickhouse_db_schema
python3 migrate.py --folder <dir> status           # ✓ applied, ● not applied, ✗ edited or file missing
python3 migrate.py --folder <dir> apply            # print the statements --execute would run
python3 migrate.py --folder <dir> apply --execute  # run them, statement by statement
python3 migrate.py drop                            # list every table in the sandbox; add
                                                   # --dangerously-and-irreversibly-destroy-data to drop them all
```

- By default everything runs in the sandbox database `fortesting`, whatever the
  directory is named. `--dangerously-and-irreversibly-migrate-database`, placed
  before the command, runs `status` and `apply` in the directory's own database
  instead. Both databases must already exist.
- `drop` needs no folder, only ever touches the sandbox, and empties it
  completely, tables no migration created included: read the dry run first. It
  refuses the database flag. SQL functions are service-wide and are left alone,
  so write `CREATE OR REPLACE FUNCTION`.
- Files are named `NNNNNN-description.sql`: six digits, a dash, a description,
  `.sql`, the next number each time. Anything in the directory that starts with
  a digit or carries `.sql` but does not match is refused.
- Never edit a file once applied: the ledger keeps a checksum and `apply` stops.
  Put the change in a new file.
- A file is recorded only after all its statements succeed, and a failed file is
  re-run from its first statement, so `ALTER`s must be repeatable (`ADD COLUMN
  IF NOT EXISTS`, `DROP COLUMN IF EXISTS`, ...). `CREATE TABLE` stays plain: an
  unrecorded file whose tables already exist is refused, `CREATE OR REPLACE`
  included, so an existing table changes through `ALTER`.
- Plain ClickHouse SQL: statements end with `;`, `--` and `/* */` comments are
  stripped before sending, and every name is bare. A `database.table` name
  anywhere in a file is refused, `system.*` aside, so a sandbox run cannot
  reach a real database. Start each file with
  `-- noqa: disable=CP05,LT01`, or the repository's sqlfluff check rewrites
  ClickHouse's type names into forms ClickHouse does not accept.
