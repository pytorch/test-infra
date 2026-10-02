# `fortesting`: trial of the new test tables

Numbered, forward-only ClickHouse migrations for the test hub tables. They are
trialled in the shared sandbox database `fortesting` and move to `tests` once
the schema is final. Nothing here touches the existing `tests.all_test_runs`
pipeline. What each table holds is documented in the SQL files themselves.

| File | Purpose |
| --- | --- |
| `000001-create-tables.sql` | the initial tables |
| `000002-....sql`, `000003-....sql` | one schema change each, added over time |
| `deploy.py` | runs the files that are not yet recorded in `fortesting.schema_migrations` |
| `populate_dummy_data.py` | fills the tables with made-up data (see Trial data) |
| `test_performance.py` | times the hub's queries and reports what each one reads (see Measuring the queries) |

## Running

```sh
export CLICKHOUSE_ENDPOINT=<host of the Cloud service>   # host, host:port or URL
export CLICKHOUSE_USERNAME=<database user>
export CLICKHOUSE_PASSWORD=<password>

cd clickhouse_db_schema/fortesting
python3 deploy.py status             # ✓ applied / ● not applied per file; exit 2 if anything needs attention
python3 deploy.py apply              # print the first line of each statement --execute would run
python3 deploy.py apply --execute    # run them, statement by statement
python3 deploy.py drop               # print DROPs for the tables and functions created by recorded files, and the ledger
python3 deploy.py drop --yes-dangerously-and-irreversibly-destroy-data
                                     # run them (trial database only); the data is gone for good
```

`apply` and `drop` only print what they would do unless given their flag.

The database user needs `CREATE`, `ALTER`, `DROP`, `SELECT` and `INSERT` on
`fortesting.*`, `SELECT` on `system.tables`, and `CREATE FUNCTION` and `DROP
FUNCTION` for the id hash helper the first file declares (SQL functions are
service-wide, which is why its name carries a project prefix).

Applied files are recorded, with a checksum, in `fortesting.schema_migrations`.
A file is recorded only after every statement in it succeeded. If a statement
fails, the error names the file; fix the cause and run `apply --execute` again.
The file is re-run from its first statement, which is why statements must be
repeatable (next section).

Two guards protect the other tables in the shared database. A file that is not
recorded yet but creates a table that already exists is refused before anything
runs: the table is either left over from a run that failed partway (the message
lists the `DROP` statements to clear it) or it belongs to someone else. And
`drop` only removes tables created by files the ledger records, so it never
touches a table this directory did not create.

## Trial data

`populate_dummy_data.py` fills freshly created tables with deterministic
made-up data: a catalog of some 48,000 Python, C++ and unknown-language tests,
a dozen environments, eleven flag sets, owners, and `--count` attempt rows (50
million by default) spread over the last ten days as CI rounds, with realistic
personalities (always failing, flaky, skipped without a device, mostly xfailed,
a thin tail of crashes and timeouts). The attempt rows are generated on the
server, one `INSERT ... SELECT` per CI round, `--workers` of them at a time; a
statement whose reply is lost is retried, and ClickHouse drops the second copy
if the first had landed. It takes the same connection as `deploy.py`, refuses
to run against `tests`, and refuses tables that already hold rows. The count
is exact: most rounds run whole and in parallel, sized to stay just under it,
and cut rounds then land on it:

```sh
python3 deploy.py apply --execute
python3 populate_dummy_data.py                   # or --count 1000000 for a quick look
python3 deploy.py drop --yes-dangerously-and-irreversibly-destroy-data   # start over
```

## Measuring the queries

`test_performance.py` runs the queries the test hub needs against `runs` and
its catalogs. From the prototype (PR #8660): the list page with its health
metrics, with and without a search, and its next page through the keyset
cursor; the test detail page's metrics and newest attempts. Planned pages: the
list restricted to one platform or to trunk jobs, the flaky tests, the tests
that got slower, the tests that appeared or disappeared, where a test runs and
its history in one configuration, the file, owner and job pages, a file's
failure messages, the time spent per file, and the health of every
environment. It picks its parameters (the newest row, a test, its busiest
environment, where the first list page ends, the week's job ids, a job, a
file, an owner) from the data and reports the server's own elapsed time, rows
and bytes read, over `--rounds` runs of each query. The queries that depend on
the window run once per `--window-days` value; the others run over a fixed
window named in the output. The summary table groups the rows by query, one
per window, so a query's cost can be read top to bottom as the window grows,
and the last line names the slowest queries. Run it after every schema change
to see what moved:

```sh
python3 test_performance.py                 # 3 timed runs per query
python3 test_performance.py --rounds 5 --search softmax
```

## Writing a migration

- Name it `NNNNNN-what-it-does.sql`, six digits, with the next number. One logical change per
  file; forward only, no "down" files.
- Plain ClickHouse SQL. Statements end with `;` at the end of a line. `--`
  comments are allowed anywhere and are stripped before sending, so do not put
  `--` inside a string literal. `/* */` comments are not stripped, so a `;` at
  the end of a line inside one still splits the statement. Names are unqualified and resolve in the
  database named by the `DATABASE` constant in `deploy.py`.
- `ALTER` statements must be safe to run twice, because ClickHouse DDL has no
  transactions and a file that fails partway is re-run from its first
  statement: `ADD COLUMN IF NOT EXISTS`, `DROP COLUMN IF EXISTS`, `ADD INDEX IF
  NOT EXISTS`, `ADD PROJECTION IF NOT EXISTS`; `MODIFY COLUMN`, `MODIFY TTL` and
  `MODIFY SETTING` already are. `CREATE TABLE` stays plain: the guard above
  refuses an unrecorded file whose tables exist, so a half-applied file is
  cleared with the listed `DROP`s and re-run rather than skipped over.
- Never edit a file after it has been applied; `apply` compares checksums and
  stops if one changed. Put the fix in the next file. While trialling in
  `fortesting` you may instead `drop --yes-dangerously-and-irreversibly-destroy-data` and apply
  everything again.

What `ALTER TABLE` can and cannot do in ClickHouse:

| Change | How |
| --- | --- |
| add, drop, rename a column; change a default or comment; add an index or projection | one `ALTER`, metadata only, instant (indexes and projections cover new parts only; `MATERIALIZE INDEX/PROJECTION` builds them for old data) |
| change a column's type | `MODIFY COLUMN`; rewrites the column in a background mutation (`system.mutations`; on Cloud the `ALTER` returns before it finishes) |
| change a column's codec | `MODIFY COLUMN name type CODEC(...)`; metadata only: new parts use it and old parts are recompressed as they merge, or at once with `OPTIMIZE TABLE <t> FINAL` |
| change TTL or a table setting | `MODIFY TTL ...`, `MODIFY SETTING ...` |
| change a materialized view's SELECT | `ALTER TABLE <view> MODIFY QUERY SELECT ...` after adding any new columns to source and target |
| anything about a key column, `ORDER BY`, `PARTITION BY`, the engine or its version column | not possible in place: `DROP TABLE IF EXISTS <t>_new SYNC`, `CREATE TABLE <t>_new ...`, `INSERT INTO <t>_new SELECT ... FROM <t>`, `EXCHANGE TABLES <t> AND <t>_new`, `DROP TABLE <t>_new`, as one migration file. The leading `DROP` makes a re-run after a failure start clean instead of inserting the rows twice |

On ClickHouse Cloud DDL replicates by itself; no `ON CLUSTER`.
