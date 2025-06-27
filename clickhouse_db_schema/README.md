# ClickHouse Table Schemas
Table schemas used to create tables and materialized view tables in ClickHouse.

Currently we do not have automation to upstream or downstream the table schema
to ClickHouse.  These are not synced or completely representative of what is in
ClickHouse right now and should mainly be used as reference.

There is a script `tools/torchci/clickhouse_database_schema_updater.py` that
makes it easier to update and add schemas for tracking.

## Add new table
Please follow [How-to-add-a-new-custom-table-on-ClickHouse](https://github.com/pytorch/test-infra/wiki/How-to-add-a-new-custom-table-on-ClickHouse).

In order to create table or grant the permissions/roles in ClickHouse, please reach out @clee2000 or @huydhn.

Page maintainers: @pytorch/pytorch-dev-infra
<br>
Last verified: 2025-06-24
