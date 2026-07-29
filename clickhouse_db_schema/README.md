# clickhouse db schema
Table schemas used to create tables and materialized view tables in clickhouse.

## Add new table
Currently we do not have automation to upstream the table schema to clickhouse.

Please follow [How-to-add-a-new-custom-table-on-ClickHouse](https://github.com/pytorch/test-infra/wiki/How-to-add-a-new-custom-table-on-ClickHouse).

In order to create table or grant the permissions/roles in clickhouse, please reach out @clee2000 or @huydhn.

## Two paradigms: declarative `schema.sql` vs. `migrations/`

Most tables here are declared once as a per-table `schema.sql` (a snapshot of the
current shape). A newer subset is instead managed by the migration runner in
`tools/clickhouse-migrations/`: their canonical definition is the ordered
`NNNN_*.sql` files under `migrations/`, applied and tracked in a ledger.

For a migration-managed table, `migrations/` is the single source of truth — do **not**
also add a competing `schema.sql` for it, and to change it add the next-numbered
migration rather than editing an applied one. `misc.greenlight_pr_state` is
migration-managed (see `migrations/0001_*`, `0002_*`); it deliberately has no
declarative `schema.sql`.
