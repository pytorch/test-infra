# clickhouse db schema
Table schemas used to create tables and materialized view tables in clickhouse.

## Add new table
Currently we do not have automation to upstream the table schema to clickhouse.

Please follow [How-to-add-a-new-custom-table-on-ClickHouse](https://github.com/pytorch/test-infra/wiki/How-to-add-a-new-custom-table-on-ClickHouse).

In order to create table or grant the permissions/roles in clickhouse, please reach out @clee2000 or @huydhn.

Each table is declared once as a per-table `schema.sql` (a snapshot of the current
shape), optionally alongside a `grants.sql` for its permissions. There is no automated
upstreaming — the SQL here is applied to ClickHouse by hand.
