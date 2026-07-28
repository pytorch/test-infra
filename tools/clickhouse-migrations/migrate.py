# /// script
# requires-python = ">=3.10"
# dependencies = ["clickhouse-connect>=0.10"]
# ///
"""Minimal, forward-only ClickHouse schema-migration runner.

``status`` (read-only) shows the current version and pending migrations. ``apply``
(admin/DDL credentials only) runs each pending ``NNNN_name.sql`` file as a single
statement, recording it in the ``misc.schema_migrations`` ledger only after it
succeeds. Run with ``uv run tools/clickhouse-migrations/migrate.py <status|apply>``.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any


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
    `applied_at` DateTime DEFAULT now()
)
ENGINE = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', applied_at)
ORDER BY version"""

ACCESS_HINT = (
    "  hint: `apply` needs a DDL/admin credential. Point CLICKHOUSE_USERNAME / "
    "CLICKHOUSE_PASSWORD at an account with CREATE/ALTER rights on the database."
)

ENV_HELP = (
    "Set CLICKHOUSE_HOST (or its alias CLICKHOUSE_ENDPOINT), CLICKHOUSE_USERNAME, "
    "CLICKHOUSE_PASSWORD (and optionally CLICKHOUSE_PORT, default 8443)."
)

_MIGRATION_RE = re.compile(r"^(\d{4})_(.+)\.sql$")

Out = Callable[[str], None]


@dataclass(frozen=True)
class Migration:
    version: str  # four-digit zero-padded prefix; compared as a plain string
    name: str
    path: Path

    @property
    def sql(self) -> str:
        return self.path.read_text(encoding="utf-8")


def resolve_migrations_dir(cli_arg: str | None) -> tuple[Path, bool]:
    if cli_arg:
        return Path(cli_arg), True
    env = os.environ.get("CH_MIGRATIONS_DIR")
    if env:
        return Path(env), True
    root = Path(__file__).resolve().parents[2]
    return root / "clickhouse_db_schema" / "migrations", False


def discover_migrations(
    migrations_dir: Path, explicit: bool = False
) -> list[Migration]:
    # A missing explicit dir is a typo worth erroring on; a missing default is empty.
    if not migrations_dir.is_dir():
        if explicit:
            raise FileNotFoundError(
                f"Migrations directory does not exist: {migrations_dir}"
            )
        return []
    found: list[Migration] = []
    for path in sorted(migrations_dir.glob("*.sql")):
        m = _MIGRATION_RE.match(path.name)
        if m and path.is_file():
            found.append(Migration(m.group(1), m.group(2), path))
    return found


def pending_migrations(
    migrations: list[Migration], applied: set[str]
) -> list[Migration]:
    return [m for m in migrations if m.version not in applied]


def current_version(applied: set[str]) -> str | None:
    return max(applied) if applied else None


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


def applied_versions(client: Any) -> set[str]:
    # Empty when the ledger table does not exist yet, so a fresh database never crashes.
    exists = client.query(
        "SELECT count() FROM system.tables "
        "WHERE database = {db:String} AND name = {name:String}",
        parameters={"db": LEDGER_DB, "name": LEDGER_NAME},
    ).result_rows
    if not exists or int(exists[0][0]) == 0:
        return set()
    rows = client.query(f"SELECT version FROM {LEDGER_TABLE} FINAL").result_rows
    return {str(r[0]) for r in rows}


def _is_access_error(exc: BaseException) -> bool:
    code = getattr(exc, "code", None)
    if isinstance(code, int) and code in (497, 516):
        return True
    msg = str(exc)
    if re.search(r"Code:\s*(?:497|516)\b", msg):
        return True
    return "ACCESS_DENIED" in msg or "AUTHENTICATION" in msg


def run_status(client: Any, migrations: list[Migration], out: Out = print) -> int:
    applied = applied_versions(client)
    out(f"Current version: {current_version(applied) or 'none'}")
    pending = pending_migrations(migrations, applied)
    if pending:
        out(f"Pending migrations ({len(pending)}):")
        for m in pending:
            out(f"  {m.version}  {m.name}")
    else:
        out("Pending migrations: none")
    return 0


def run_dry_run(migrations: list[Migration], out: Out = print) -> int:
    out("-- DRY RUN: no database connection is made; all discovered migrations shown.")
    out(CREATE_LEDGER_SQL + ";")
    out("")
    for m in migrations:
        safe_name = m.name.replace("'", "''")
        out(f"-- {m.version} {m.name}")
        out(m.sql.strip() + ";")
        out("")
        out(
            f"INSERT INTO {LEDGER_TABLE} (version, name) VALUES ('{m.version}', '{safe_name}');"
        )
        out("")
    return 0


def run_apply(client: Any, migrations: list[Migration], out: Out = print) -> int:
    endpoint = getattr(client, "url", None) or "unknown endpoint"
    database = getattr(client, "database", None) or "unknown database"
    out(f"Applying DDL to ClickHouse {endpoint} (database: {database})")
    client.command(CREATE_LEDGER_SQL)
    pending = pending_migrations(migrations, applied_versions(client))
    if not pending:
        out("No pending migrations. Nothing to apply.")
        return 0
    for m in pending:
        out(f"Applying {m.version} {m.name}...")
        try:
            client.command(m.sql)
        except Exception as exc:
            out(f"ERROR applying {m.version} {m.name}: {type(exc).__name__}: {exc}")
            if _is_access_error(exc):
                out(ACCESS_HINT)
            return 1
        client.insert(
            LEDGER_TABLE, [[m.version, m.name]], column_names=["version", "name"]
        )
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
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    migrations_dir, explicit = resolve_migrations_dir(args.migrations_dir)
    try:
        migrations = discover_migrations(migrations_dir, explicit=explicit)
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    if args.command == "apply" and args.dry_run:
        return run_dry_run(migrations)
    try:
        client = connect()
        if args.command == "apply":
            return run_apply(client, migrations)
        return run_status(client, migrations)
    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        if _is_access_error(exc):
            print(ACCESS_HINT, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
