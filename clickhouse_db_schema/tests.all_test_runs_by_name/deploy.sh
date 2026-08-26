#!/usr/bin/env bash
# Create the future-only tests.all_test_runs_by_name pipeline.
# This script never drops, replaces, truncates, or backfills either table.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

: "${CLICKHOUSE_ENDPOINT:?set CLICKHOUSE_ENDPOINT}"
: "${CLICKHOUSE_USERNAME:?set CLICKHOUSE_USERNAME}"

if [[ "${CONFIRM_INGESTER_DEPLOYED_AND_DRAINED:-}" != "1" ]]; then
  cat >&2 <<'EOF'
Refusing to create or validate the materialized view until the protected
clickhouse-replicator-s3 Lambda is deployed and old invocations have drained.
Follow the rollout procedure in README.md, then set:
  CONFIRM_INGESTER_DEPLOYED_AND_DRAINED=1
EOF
  exit 1
fi

ch() {
  local sql="$1"
  local -a args=(
    --host "$CLICKHOUSE_ENDPOINT"
    --port "${CLICKHOUSE_PORT:-9440}"
    --secure
    --user "$CLICKHOUSE_USERNAME"
  )
  if [[ -n "${CLICKHOUSE_PASSWORD:-}" ]]; then
    args+=(--password "$CLICKHOUSE_PASSWORD")
  fi
  clickhouse-client "${args[@]}" --query "$sql"
}

render_schema_part() {
  local part="$1" sql
  case "$part" in
    table)
      sql=$(awk '/^CREATE MATERIALIZED VIEW/{exit} {print}' schema.sql)
      ;;
    mv)
      sql=$(awk '/^CREATE MATERIALIZED VIEW/{found=1} found {print}' schema.sql)
      ;;
    *)
      echo "unknown schema part: $part" >&2
      return 1
      ;;
  esac
  printf '%s\n' "$sql"
}

validate_existing_mv() {
  local target source
  IFS=$'\t' read -r target source < <(
    ch "SELECT
          extract(replaceAll(create_table_query, '\`', ''),
                  'TO[[:space:]]+([^[:space:]]+)'),
          extract(replaceAll(as_select, '\`', ''),
                  'FROM[[:space:]]+([^[:space:];]+)')
        FROM system.tables
        WHERE database = 'tests'
          AND name = 'all_test_runs_by_name_mv'
        FORMAT TSV"
  ) || true

  if [[ "$target" != "tests.all_test_runs_by_name" ||
        "$source" != "tests.all_test_runs" ]]; then
    echo "existing tests.all_test_runs_by_name_mv has an unexpected target or source" >&2
    exit 1
  fi
}

IFS=$'\t' read -r table_exists mv_exists < <(
  ch "SELECT
        countIf(name = 'all_test_runs_by_name'),
        countIf(name = 'all_test_runs_by_name_mv')
      FROM system.tables
      WHERE database = 'tests'
        AND name IN ('all_test_runs_by_name', 'all_test_runs_by_name_mv')
      FORMAT TSV"
)

case "${table_exists}:${mv_exists}" in
  0:0)
    echo "== creating tests.all_test_runs_by_name"
    ch "$(render_schema_part table)"
    echo "== creating tests.all_test_runs_by_name_mv"
    ch "$(render_schema_part mv)"
    echo "Installed. Existing parent rows were not copied."
    ;;
  1:1)
    echo "== table and MV already exist; leaving both unchanged"
    validate_existing_mv
    echo "Already installed."
    ;;
  *)
    cat >&2 <<EOF
Refusing to continue from a partial installation:
  tests.all_test_runs_by_name exists:    ${table_exists}
  tests.all_test_runs_by_name_mv exists: ${mv_exists}

Inspect the existing object before either completing it manually or removing
the partial installation in the order documented in README.md. This script
never drops or replaces ClickHouse objects.
EOF
    exit 1
    ;;
esac
