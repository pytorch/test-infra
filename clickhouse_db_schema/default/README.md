# Default database migrations

This directory contains forward-only migrations for tables in the `default`
database. Number each new migration after the highest number already present in
this directory, regardless of which `default.*` table it changes.

The matching per-table `schema.sql` file is the current schema snapshot. Apply
the migration through the procedure in the parent
[`clickhouse_db_schema/README.md`](../README.md); never edit a migration once it
has been applied.
