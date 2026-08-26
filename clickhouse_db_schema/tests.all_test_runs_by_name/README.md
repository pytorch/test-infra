# `tests.all_test_runs_by_name`

A compact, test-identity-sorted copy of `tests.all_test_runs`, maintained by
an incremental materialized view (`schema.sql` has the why and the intended
queries). The table starts empty: parent history is intentionally not
backfilled, gaps are not monitored, and the first few minutes after creation
may be incomplete while ClickHouse Cloud propagates the view. The source
ingester uses `materialized_views_ignore_errors=1`, so failures in this
best-effort mirror do not reject inserts into `tests.all_test_runs`; those
failures instead leave gaps in this table.

## Deploy

Requires `clickhouse-client` and admin credentials:

1. Before merging, run as the Lambda's ClickHouse user (not an admin — the
   constraint being tested is per-user):

   ```sql
   SELECT 1 SETTINGS materialized_views_ignore_errors=1
   ```

   The merged Lambda attaches this setting to every `tests.all_test_runs`
   insert immediately — before the view exists — so a settings-profile
   constraint that rejects it would break all test ingest at Lambda deploy
   time, not at MV creation time. If the query is rejected, lift the
   constraint before merging.
2. Merge the change and wait for the
   [`clickhouse-replicator-s3` deployment workflow](../../.github/workflows/clickhouse-replicator-s3-lambda.yml)
   to finish successfully. The workflow waits for AWS to finish the update and
   verifies the deployed code hash. The deployed Lambda must include
   `materialized_views_ignore_errors=1` on the `tests.all_test_runs` insert.
3. Wait at least 15 minutes after the workflow succeeds. This is Lambda's
   maximum execution duration and ensures invocations that started with the
   previous code have drained before the materialized view is created. Use
   the wait to confirm ingest survived the setting change:
   `tests.all_test_runs` still receives rows and `errors.gen_errors` gets no
   new `tests.all_test_runs` entries.
4. Deploy the ClickHouse objects, explicitly confirming both prerequisites:

```sh
export CLICKHOUSE_ENDPOINT=<ClickHouse Cloud host>
export CLICKHOUSE_USERNAME=<admin user>
export CLICKHOUSE_PASSWORD=<password> # optional when client config supplies it

CONFIRM_INGESTER_DEPLOYED_AND_DRAINED=1 ./deploy.sh
```

The script is non-destructive: it never drops, replaces, truncates, or
backfills anything. Re-running with both objects present validates them; on a
partial installation it stops for manual inspection.

## Removal (and partial-install cleanup)

Once no consumer needs the table, drop the MV first so parent inserts stop
targeting it, then the table. The Lambda safeguard may be reverted only after
the `DROP VIEW` succeeds:

```sql
DROP VIEW tests.all_test_runs_by_name_mv;
DROP TABLE tests.all_test_runs_by_name;
```
