#!/usr/bin/env python3
"""Apply the numbered migration files in this directory to ClickHouse.

    000001-create-tables.sql, 000002-<change>.sql, ...  forward-only, run in order

    python3 deploy.py status              # which files are applied (✓), which are not (●)
    python3 deploy.py apply               # print the first line of each statement that would run
    python3 deploy.py apply --execute     # run them, statement by statement
    python3 deploy.py drop                # print the DROPs for the recorded tables and functions
    python3 deploy.py drop --yes-dangerously-and-irreversibly-destroy-data
                                          # run them: those tables, their data and the ledger are gone

apply and drop only print what they would do unless given their flag.

Applied files are recorded in DATABASE.schema_migrations. A file is recorded only
after every statement in it succeeded; if one fails, fix the cause and re-run,
which re-executes the file from its first statement. So write ALTERs that can
be repeated (ADD COLUMN IF NOT EXISTS, DROP COLUMN IF EXISTS, MODIFY ...); a
CREATE TABLE may be plain, because the guard below refuses to run a file over
tables that already exist. Never edit a file after it has been applied; add a
new one. The ledger keeps a checksum and refuses to continue past an edited file.

Two guards protect the other tables in the shared database: a file that is not
recorded yet but creates a table that already exists is refused (the table is
either left over from a half-applied run, which you drop first, or somebody
else's), and drop only removes tables created by recorded files.

Files are plain ClickHouse SQL: statements end with ';' at the end of a line,
'--' comments are removed before sending, table names are unqualified and
resolve in DATABASE.

Connection, through the ClickHouse HTTP interface with a database user:
CLICKHOUSE_ENDPOINT (host, host:port or URL), CLICKHOUSE_USERNAME,
CLICKHOUSE_PASSWORD.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple


# The database every file here targets. Change to "tests" when the schema is final.
DATABASE = "fortesting"

HERE = Path(__file__).resolve().parent
LEDGER = "schema_migrations"
LEDGER_DDL = f"""CREATE TABLE IF NOT EXISTS {LEDGER}
(
    version    UInt32,
    name       String,
    checksum   String,
    applied_at DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY version"""
FILE_RE = re.compile(r"^(\d{6})-[\w.-]+\.sql$")
# The only CREATE forms the script understands; the trailing group catches a
# database prefix (name.) so it can be rejected.
CREATE_RE = re.compile(
    r"CREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|MATERIALIZED\s+VIEW|FUNCTION)\s+"
    r"(?:IF\s+NOT\s+EXISTS\s+)?(\w+)(\.?)",
    re.I,
)
DROP_ORDER = {"VIEW": 0, "TABLE": 1, "FUNCTION": 2}  # views first, functions last
NO_SUCH_TABLE_RE = re.compile(r"\bCode: 60\.")  # UNKNOWN_TABLE


class Failed(Exception):
    pass


# --------------------------------------------------------------------------- executors


class Http:
    """One statement per request to the ClickHouse HTTP interface."""

    def __init__(self) -> None:
        endpoint = os.environ.get("CLICKHOUSE_ENDPOINT", "")
        self.user = os.environ.get("CLICKHOUSE_USERNAME", "")
        self.password = os.environ.get("CLICKHOUSE_PASSWORD", "")
        if not endpoint or not self.user:
            raise Failed(
                "set CLICKHOUSE_ENDPOINT, CLICKHOUSE_USERNAME and CLICKHOUSE_PASSWORD"
            )
        if "://" not in endpoint:
            endpoint = "https://" + endpoint
        url_parts = urllib.parse.urlsplit(endpoint)
        try:
            port = url_parts.port or (8443 if url_parts.scheme == "https" else 8123)
        except ValueError:
            raise Failed(
                f"CLICKHOUSE_ENDPOINT {endpoint!r} has an invalid port"
            ) from None
        self.url = (
            f"{url_parts.scheme}://{url_parts.hostname}:{port}/?"
            + urllib.parse.urlencode(
                {
                    "database": DATABASE,
                    "default_format": "TabSeparated",
                    # On ClickHouse Cloud any replica may answer a request, and
                    # one that has not yet seen the parts another replica just
                    # wrote returns a stale count. This makes a SELECT wait
                    # until its replica has caught up with every insert that
                    # finished before it. A no-op on a single server.
                    "select_sequential_consistency": 1,
                }
            )
        )

    def run(self, sql: str) -> str:
        request = urllib.request.Request(self.url, data=sql.encode(), method="POST")
        request.add_header("X-ClickHouse-User", self.user)
        if self.password:
            request.add_header("X-ClickHouse-Key", self.password)
        try:
            with urllib.request.urlopen(request, timeout=600) as response:
                return response.read().decode()
        except urllib.error.HTTPError as error:
            raise Failed(
                f"HTTP {error.code}: {error.read().decode(errors='replace').strip()}"
            ) from None
        except (OSError, http.client.HTTPException) as error:
            # URLError, timeouts and dropped connections all land here. The server
            # may still be running the statement.
            raise Failed(f"cannot reach {self.url.split('?')[0]}: {error}") from None


# --------------------------------------------------------------------------- files and ledger


@dataclass
class Migration:
    version: int
    name: str
    statements: List[str]
    checksum: str


def statements(text: str) -> List[str]:
    """Split on ';' at the end of a line, after removing -- comments."""
    text = re.sub(r"--[^\n]*", "", text)
    chunks = re.split(r";[ \t]*(?:\n|$)", text)
    return [chunk.strip() for chunk in chunks if chunk.strip()]


def migrations() -> List[Migration]:
    found: List[Migration] = []
    for path in sorted(HERE.glob("*.sql")):
        match = FILE_RE.match(path.name)
        if not match:
            raise Failed(
                f"{path.name}: migration files are named NNNNNN-description.sql"
            )
        text = path.read_text(encoding="utf-8")
        found.append(
            Migration(
                int(match.group(1)),
                path.name,
                statements(text),
                hashlib.sha256(text.encode()).hexdigest(),
            )
        )
    versions = [migration.version for migration in found]
    if len(set(versions)) != len(versions):
        raise Failed("two migration files share a version number")
    return sorted(found, key=lambda migration: migration.version)


def created_objects(migration: Migration) -> List[Tuple[str, str]]:
    """(kind, name) for each CREATE TABLE / MATERIALIZED VIEW / FUNCTION in the file."""
    created = []
    for sql in migration.statements:
        match = CREATE_RE.match(sql)
        if match is None:
            continue
        kind, name, dot = match.groups()
        if dot:
            raise Failed(
                f"{migration.name}: {name}.… carries a database; names must be bare"
            )
        kind = kind.upper()
        kind = "VIEW" if "VIEW" in kind else kind
        created.append((kind, name))
    return created


def ledger(executor) -> Dict[int, Dict[str, str]]:
    """version -> {name, checksum, applied_at}; empty when the ledger does not exist."""
    try:
        rows = executor.run(
            f"SELECT version, name, checksum, applied_at FROM {LEDGER} ORDER BY version"
        )
    except Failed as error:
        if NO_SUCH_TABLE_RE.search(str(error)):
            return {}
        raise
    applied = {}
    try:
        for line in rows.splitlines():
            version, name, checksum, applied_at = line.split("\t")
            applied[int(version)] = {
                "name": name,
                "checksum": checksum,
                "applied_at": applied_at,
            }
    except ValueError:
        raise Failed(
            f"{DATABASE}.{LEDGER} does not have the layout deploy.py expects"
        ) from None
    return applied


def existing_tables(executor, names: List[str]) -> List[str]:
    if not names:
        return []
    quoted = ", ".join(f"'{name}'" for name in names)
    rows = executor.run(
        f"SELECT name FROM system.tables WHERE database = '{DATABASE}' "
        f"AND name IN ({quoted}) ORDER BY name"
    )
    return rows.split()


def check_unmodified(
    files: List[Migration], applied: Dict[int, Dict[str, str]]
) -> None:
    for migration in files:
        record = applied.get(migration.version)
        if record and record["checksum"] != migration.checksum:
            raise Failed(
                f"{migration.name} was edited after it was applied on "
                f"{record['applied_at']}; "
                "put the change in a new file instead "
                "(in a trial database, `drop --yes-dangerously-and-irreversibly-destroy-data` starts over)"
            )


def refuse_if_tables_exist(executor, migration: Migration) -> None:
    """An unrecorded file must not adopt tables that already exist."""
    created = [
        (kind, name) for kind, name in created_objects(migration) if kind != "FUNCTION"
    ]
    existing = existing_tables(executor, [name for _, name in created])
    if not existing:
        return
    drops = "; ".join(
        f"DROP {kind} IF EXISTS {DATABASE}.{name} SYNC"
        for kind, name in created
        if name in existing
    )
    raise Failed(
        f"{migration.name} is not recorded as applied, but these tables already "
        f"exist in {DATABASE}: {', '.join(existing)}. If they are left over from a "
        f"failed run, drop them and retry: {drops}. If they belong to someone else, stop."
    )


def run_statement(executor, migration: Migration, sql: str) -> None:
    try:
        executor.run(sql)
    except Failed as error:
        raise Failed(f"{migration.name}: {error}") from None


def headline(sql: str) -> str:
    return sql.splitlines()[0]


GREEN, YELLOW, RED = "32", "33", "31"


def colored(text: str, color: str) -> str:
    """text in an ANSI color when printing to a terminal, plain otherwise."""
    if sys.stdout.isatty() and not os.environ.get("NO_COLOR"):
        return f"\033[{color}m{text}\033[0m"
    return text


def ok() -> str:
    """The success marker."""
    return colored("OK", GREEN)


# --------------------------------------------------------------------------- commands


def cmd_status(executor, args) -> int:
    files, applied = migrations(), ledger(executor)
    attention = False
    for migration in files:
        record = applied.get(migration.version)
        if record is None:
            mark, state = colored("●", YELLOW), "not applied"
            attention = True
        else:
            mark, state = colored("✓", GREEN), f"applied {record['applied_at']}"
            if record["checksum"] != migration.checksum:
                state += ", " + colored("EDITED since", RED)
                attention = True
        print(f" {mark} {migration.name:48} {state}")
    for version, record in sorted(applied.items()):
        if version not in {migration.version for migration in files}:
            state = f"applied {record['applied_at']}, " + colored("file missing", RED)
            print(f" {colored('✓', GREEN)} {record['name']:48} {state}")
            attention = True
    return 2 if attention else 0


def cmd_apply(executor, args) -> int:
    files, applied = migrations(), ledger(executor)
    check_unmodified(files, applied)
    unapplied = [migration for migration in files if migration.version not in applied]
    if not unapplied:
        print("nothing to apply")
        return 0
    for migration in unapplied:
        refuse_if_tables_exist(executor, migration)
    if args.execute:
        executor.run(LEDGER_DDL)
    for migration in unapplied:
        print(f"== {migration.name}")
        for sql in migration.statements:
            print(f"   {headline(sql)}")
            if args.execute:
                run_statement(executor, migration, sql)
        if args.execute:
            run_statement(
                executor,
                migration,
                f"INSERT INTO {LEDGER} (version, name, checksum) VALUES "
                f"({migration.version}, '{migration.name}', '{migration.checksum}')",
            )
    print(ok() if args.execute else "dry run; add --execute to run these statements")
    return 0


def cmd_drop(executor, args) -> int:
    if DATABASE == "tests":
        raise Failed("drop is for the trial database only")
    applied = ledger(executor)
    if not applied:
        print(f"nothing is recorded in {DATABASE}.{LEDGER}; nothing to drop")
        return 0
    created = []
    for migration in migrations():
        if migration.version in applied:
            created.extend(created_objects(migration))
    created.sort(key=lambda kind_name: DROP_ORDER[kind_name[0]])
    for kind, name in created + [("TABLE", LEDGER)]:
        sql = f"DROP {kind} IF EXISTS {name}" + ("" if kind == "FUNCTION" else " SYNC")
        print(f"   {sql}")
        if args.yes:
            executor.run(sql)
    if args.yes:
        print(ok())
    else:
        print(
            f"dry run; this deletes these tables in {DATABASE}, data included, and "
            "ClickHouse cannot undo it. Pass --yes-dangerously-and-irreversibly-destroy-data to run the statements"
        )
    return 0


def main(argv=None) -> int:
    # allow_abbrev=False everywhere: otherwise argparse would accept a bare --yes
    # as an abbreviation of drop's --yes-dangerously-and-irreversibly-destroy-data.
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        allow_abbrev=False,
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser(
        "status",
        help="show which files are applied and which are not (exit 2 if any is not applied, edited or missing)",
        allow_abbrev=False,
    )
    apply_cmd = subparsers.add_parser(
        "apply",
        help="print, or with --execute run, the files not yet applied",
        allow_abbrev=False,
    )
    apply_cmd.add_argument(
        "--execute",
        action="store_true",
        help="run the statements instead of printing them",
    )
    drop_cmd = subparsers.add_parser(
        "drop",
        help="print, or with its flag run, DROP TABLE for the recorded tables and the ledger",
        allow_abbrev=False,
    )
    drop_cmd.add_argument(
        "--yes-dangerously-and-irreversibly-destroy-data",
        dest="yes",
        action="store_true",
        help="run the statements: the tables and all their rows are deleted for good",
    )
    args = parser.parse_args(argv)
    commands = {"status": cmd_status, "apply": cmd_apply, "drop": cmd_drop}
    try:
        return commands[args.command](Http(), args)
    except Failed as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
