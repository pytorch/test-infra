# /// script
# requires-python = ">=3.10"
# dependencies = ["clickhouse-connect>=0.10"]
# ///
"""Minimal, forward-only ClickHouse schema-migration runner.

``status`` (read-only) shows the current version, pending migrations, and any ordering
or drift problems. ``apply`` (admin/DDL credentials only) validates the set, then runs
each pending ``NNNN_name.sql`` file as a single statement, recording it in the
``misc.schema_migrations`` ledger only after it succeeds. Run with
``uv run tools/clickhouse-migrations/migrate.py <status|apply>``.

Pure discovery/validation/ordering/checksum logic lives in the sibling ``migrate_lib``
module; this file owns the ClickHouse connection, the ledger, and the CLI.
"""

from __future__ import annotations

import argparse
import logging
import os
import re
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from migrate_lib import (
    Migration,
    MigrationError,
    OrderingReport,
    assert_single_statement,
    check_ordering,
    compute_checksum,
    current_version,
    detect_drift,
    discover_migrations,
    load_sql,
    orphan_versions,
    pending_migrations,
    validate_migrations,
)


__all__ = [
    "Migration",
    "MigrationError",
    "OrderingReport",
    "assert_single_statement",
    "check_ordering",
    "compute_checksum",
    "current_version",
    "detect_drift",
    "discover_migrations",
    "load_sql",
    "orphan_versions",
    "pending_migrations",
    "validate_migrations",
    "CREATE_LEDGER_SQL",
    "ALTER_LEDGER_ADD_CHECKSUM_SQL",
    "read_ledger",
    "applied_versions",
    "run_status",
    "run_apply",
    "run_dry_run",
    "connect",
    "build_parser",
    "main",
]

LEDGER_DB = "misc"
LEDGER_NAME = "schema_migrations"
LEDGER_TABLE = f"{LEDGER_DB}.{LEDGER_NAME}"

# {uuid}/{shard}/{replica} are ClickHouse Cloud macros expanded server-side; the
# braces are literal SQL, so this stays a plain string (never f-string / .format).
CREATE_LEDGER_SQL = """\
CREATE TABLE IF NOT EXISTS misc.schema_migrations
(
    `version` String,
    `name` String,
    `applied_at` DateTime DEFAULT now(),
    `checksum` String DEFAULT ''
)
ENGINE = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', applied_at)
ORDER BY version"""

# Backfills the checksum column onto ledgers created before drift detection existed;
# ADD COLUMN IF NOT EXISTS keeps it a no-op on a fresh ledger the CREATE just made.
ALTER_LEDGER_ADD_CHECKSUM_SQL = (
    "ALTER TABLE misc.schema_migrations "
    "ADD COLUMN IF NOT EXISTS checksum String DEFAULT ''"
)

ACCESS_HINT = (
    "  hint: `apply` needs a DDL/admin credential. Point CLICKHOUSE_USERNAME / "
    "CLICKHOUSE_PASSWORD at an account with CREATE/ALTER rights on the database."
)

ENV_HELP = (
    "Set CLICKHOUSE_HOST (or its alias CLICKHOUSE_ENDPOINT), CLICKHOUSE_USERNAME, "
    "CLICKHOUSE_PASSWORD (and optionally CLICKHOUSE_PORT, default 8443)."
)

logger = logging.getLogger("clickhouse_migrations")

Out = Callable[[str], None]


def resolve_migrations_dir(cli_arg: str | None) -> tuple[Path, bool]:
    if cli_arg:
        return Path(cli_arg), True
    env = os.environ.get("CH_MIGRATIONS_DIR")
    if env:
        return Path(env), True
    root = Path(__file__).resolve().parents[2]
    return root / "clickhouse_db_schema" / "migrations", False


def _env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        raise SystemExit(f"Missing required environment variable {name}. {ENV_HELP}")
    return val


def _host_from_env() -> str:
    raw = os.environ.get("CLICKHOUSE_HOST") or os.environ.get("CLICKHOUSE_ENDPOINT")
    if not raw:
        raise SystemExit(
            f"Missing required environment variable CLICKHOUSE_HOST. {ENV_HELP}"
        )
    host = raw[len("https://") :] if raw.startswith("https://") else raw
    return host[: -len(":8443")] if host.endswith(":8443") else host


def connect() -> Any:
    host = _host_from_env()
    username = _env("CLICKHOUSE_USERNAME")
    password = _env("CLICKHOUSE_PASSWORD")
    try:
        port = int(os.environ.get("CLICKHOUSE_PORT") or "8443")
    except ValueError:
        raise SystemExit("Invalid CLICKHOUSE_PORT: must be an integer.") from None
    # clickhouse_connect's TLS to *.clickhouse.cloud fails through a corporate proxy;
    # excluding the domain from NO_PROXY/no_proxy routes it directly.
    for var in ("NO_PROXY", "no_proxy"):
        entries = [e.strip() for e in os.environ.get(var, "").split(",") if e.strip()]
        if ".clickhouse.cloud" not in entries:
            os.environ[var] = ",".join([*entries, ".clickhouse.cloud"])
    import clickhouse_connect  # lazy: keeps this module importable without the dep

    return clickhouse_connect.get_client(
        host=host,
        username=username,
        password=password,
        port=port,
        secure=True,
        interface="https",
    )


def _ledger_has_checksum(client: Any) -> bool:
    # system.columns lets status detect a pre-checksum ledger without altering it.
    rows = client.query(
        "SELECT count() FROM system.columns "
        "WHERE database = {db:String} AND table = {name:String} "
        "AND name = 'checksum'",
        parameters={"db": LEDGER_DB, "name": LEDGER_NAME},
    ).result_rows
    return bool(rows) and int(rows[0][0]) > 0


def read_ledger(client: Any) -> dict[str, str]:
    """Return ``{version: checksum}`` for applied migrations. Empty when the ledger does
    not exist; checksum is ``''`` for every row when the checksum column is absent, so a
    read-only caller never has to create or alter anything to read the ledger."""
    exists = client.query(
        "SELECT count() FROM system.tables "
        "WHERE database = {db:String} AND name = {name:String}",
        parameters={"db": LEDGER_DB, "name": LEDGER_NAME},
    ).result_rows
    if not exists or int(exists[0][0]) == 0:
        return {}
    if _ledger_has_checksum(client):
        rows = client.query(
            f"SELECT version, checksum FROM {LEDGER_TABLE} FINAL"
        ).result_rows
        return {str(r[0]): str(r[1]) for r in rows}
    rows = client.query(f"SELECT version FROM {LEDGER_TABLE} FINAL").result_rows
    return {str(r[0]): "" for r in rows}


def applied_versions(client: Any) -> set[str]:
    return set(read_ledger(client).keys())


def _is_access_error(exc: BaseException) -> bool:
    code = getattr(exc, "code", None)
    if isinstance(code, int) and code in (497, 516):
        return True
    msg = str(exc)
    if re.search(r"Code:\s*(?:497|516)\b", msg):
        return True
    return "ACCESS_DENIED" in msg or "AUTHENTICATION" in msg


def run_status(client: Any, migrations: list[Migration], out: Out = print) -> int:
    validate_migrations(migrations)
    ledger = read_ledger(client)
    applied = set(ledger.keys())
    out(f"Current version: {current_version(applied) or 'none'}")
    pending = pending_migrations(migrations, applied)
    if pending:
        out(f"Pending migrations ({len(pending)}):")
        for m in pending:
            out(f"  {m.version}  {m.name}")
    else:
        out("Pending migrations: none")
    # status is a read-only diagnostic: ordering problems are reported, never fatal.
    report = check_ordering(migrations, applied, allow_out_of_order=True)
    for line in [*report.errors, *report.warnings]:
        out(f"WARNING: {line}")
    for version in orphan_versions(migrations, ledger):
        out(f"WARNING: ledger records {version} but no migration file is present")
    rc = 0
    for message in detect_drift(migrations, ledger):
        out(f"DRIFT: {message}")
        rc = 1
    return rc


def run_dry_run(migrations: list[Migration], out: Out = print) -> int:
    validate_migrations(migrations)
    out("-- DRY RUN: no database connection is made; all discovered migrations shown.")
    out(CREATE_LEDGER_SQL + ";")
    out(ALTER_LEDGER_ADD_CHECKSUM_SQL + ";")
    out("")
    for m in migrations:
        safe_name = m.name.replace("'", "''")
        out(f"-- {m.version} {m.name}")
        out(load_sql(m).strip() + ";")
        out("")
        out(
            f"INSERT INTO {LEDGER_TABLE} (version, name) VALUES ('{m.version}', '{safe_name}');"
        )
        out("")
    return 0


def _bootstrap_ledger(client: Any) -> None:
    client.command(CREATE_LEDGER_SQL)
    client.command(ALTER_LEDGER_ADD_CHECKSUM_SQL)


def run_apply(
    client: Any,
    migrations: list[Migration],
    out: Out = print,
    *,
    allow_out_of_order: bool = False,
) -> int:
    validate_migrations(migrations)
    endpoint = getattr(client, "url", None) or "unknown endpoint"
    database = getattr(client, "database", None) or "unknown database"
    out(f"Applying DDL to ClickHouse {endpoint} (database: {database})")
    ledger = read_ledger(client)
    applied = set(ledger.keys())

    report = check_ordering(migrations, applied, allow_out_of_order=allow_out_of_order)
    for warning in report.warnings:
        out(f"WARNING: {warning}")
    if report.errors:
        for error in report.errors:
            out(f"ERROR: {error}")
        out(
            "Refusing to apply. Fix ordering, or re-run with --allow-out-of-order "
            "(duplicate versions are never allowed)."
        )
        return 1

    drift = detect_drift(migrations, ledger)
    if drift:
        for message in drift:
            out(f"ERROR: {message}")
        out("Refusing to apply: an applied migration changed after it was recorded.")
        return 1

    _bootstrap_ledger(client)
    pending = pending_migrations(migrations, applied)
    if not pending:
        out("No pending migrations. Nothing to apply.")
        return 0
    for m in pending:
        out(f"Applying {m.version} {m.name}...")
        sql = load_sql(m)
        try:
            client.command(sql)
        except Exception as exc:
            out(f"ERROR applying {m.version} {m.name}: {type(exc).__name__}: {exc}")
            if _is_access_error(exc):
                out(ACCESS_HINT)
            return 1
        try:
            client.insert(
                LEDGER_TABLE,
                [[m.version, m.name, compute_checksum(sql)]],
                column_names=["version", "name", "checksum"],
            )
        except Exception as exc:
            # The DDL ran but the ledger row did not land: a re-run would re-run this
            # statement, so surface it loudly and stop the chain here.
            out(
                f"CRITICAL: applied {m.version} but FAILED to record it in the ledger: "
                f"{type(exc).__name__}: {exc}"
            )
            out(
                "Re-running is safe only if this migration is idempotent "
                "(IF [NOT] EXISTS); otherwise insert the ledger row manually before "
                "re-running so it is not applied twice."
            )
            return 1
        out(f"  recorded {m.version} in {LEDGER_TABLE}")
    out(f"Applied {len(pending)} migration(s).")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="migrate.py",
        description="Minimal, idempotent ClickHouse schema-migration runner.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    status_p = sub.add_parser(
        "status", help="Show current version and pending migrations (read-only)."
    )
    apply_p = sub.add_parser(
        "apply", help="Apply pending migrations (requires admin/DDL credentials)."
    )
    for p in (status_p, apply_p):
        p.add_argument(
            "--migrations-dir",
            default=None,
            help="Migrations dir (default: clickhouse_db_schema/migrations, or $CH_MIGRATIONS_DIR).",
        )
    apply_p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the SQL that would run; makes no database connection.",
    )
    apply_p.add_argument(
        "--allow-out-of-order",
        action="store_true",
        help="Apply a pending migration numbered below the highest applied version.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    args = build_parser().parse_args(argv)
    migrations_dir, explicit = resolve_migrations_dir(args.migrations_dir)
    try:
        migrations = discover_migrations(migrations_dir, explicit=explicit)
        if args.command == "apply" and args.dry_run:
            return run_dry_run(migrations)
        client = connect()
        if args.command == "apply":
            return run_apply(
                client, migrations, allow_out_of_order=args.allow_out_of_order
            )
        return run_status(client, migrations)
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        if _is_access_error(exc):
            print(ACCESS_HINT, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
