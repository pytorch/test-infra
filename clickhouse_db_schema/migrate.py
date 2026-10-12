#!/usr/bin/env python3
"""Apply a folder of numbered migration files to ClickHouse.

    clickhouse_db_schema/<database>/000001-create-tables.sql, 000002-<change>.sql, ...
    forward-only, run in order

    python3 migrate.py --folder fortesting status           # ✓ applied, ● not applied, ✗ edited or file missing
    python3 migrate.py --folder fortesting apply            # print the first line of each statement that would run
    python3 migrate.py --folder fortesting apply --execute  # run them, statement by statement
    python3 migrate.py drop                                 # list every table in the sandbox, whatever created it
    python3 migrate.py drop --dangerously-and-irreversibly-destroy-data
                                                            # drop them all: the sandbox is emptied, ledger included

apply and drop only print what they would do unless given their flag. The
options go before the command.

--folder names a directory of migration files, as a path or as the name of a
directory next to this script. The directory is named after the database its
files are written for, and that database must exist. The statements do not run
there by default: they run in the shared sandbox database `fortesting`, so a
schema can be tried, filled with dummy data and dropped without touching
anything real. To run them in the folder's own database pass

    --dangerously-and-irreversibly-migrate-database

drop never runs there, with or without that flag: it empties the sandbox, and
needs no folder.

Applied files are recorded in the target database's schema_migrations table,
one ledger per database. A file is recorded only after every statement in it
succeeded; if one fails, fix the cause and re-run, which re-executes the file
from its first statement. So write ALTERs that can be repeated (ADD COLUMN IF
NOT EXISTS, DROP COLUMN IF EXISTS, MODIFY ...); a CREATE TABLE may be plain,
because the guard below refuses to run a file over tables that already exist,
CREATE OR REPLACE included: an existing table changes through ALTER. Never
edit a file after it has been applied; add a new one. The ledger keeps a
checksum and refuses to continue past an edited file.

One guard protects the tables already in a database: a file that is not
recorded yet but creates a table that already exists is refused (the table is
either left over from a half-applied run, which you drop first, or somebody
else's). drop is the opposite: it lists every table in the sandbox, whatever
created it, and with its flag drops them all, so read the dry run before
passing the flag. SQL functions are service-wide and are left alone; write
CREATE OR REPLACE FUNCTION so a re-apply works.

Files are named NNNNNN-description.sql: six digits, a dash, a description,
.sql. Any file in the folder that starts with a digit or carries .sql in its
name is held to that and refused otherwise; README.md and helper scripts are
left alone. Files are plain ClickHouse SQL: statements end with ';', '--' and
/* */ comments are removed before sending, and every table name is bare and
resolves in the target database. A database.table name anywhere in a file is
refused, system.* aside, so a sandbox run cannot reach a real database.

Connection, through the ClickHouse HTTP interface with a database user:
CLICKHOUSE_ENDPOINT (host, host:port or URL), CLICKHOUSE_USERNAME,
CLICKHOUSE_PASSWORD.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple


# Where a folder's files run unless the flag below says otherwise.
SANDBOX = "fortesting"
# An AI agent must never, under any circumstances, pass this flag. It makes the
# statements run in a real database; only a human decides that, by hand.
DANGEROUSLY_AND_IRREVERSIBLY_MIGRATE_DATABASE = (
    "--dangerously-and-irreversibly-migrate-database"
)

HERE = Path(__file__).resolve().parent
SCRIPT = Path(__file__).name
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
UNKNOWN_TABLE = 60  # ClickHouse's error code when the ledger does not exist yet
# A folder name is a database name and goes into a URL and unquoted SQL: word characters only.
NAME_RE = re.compile(r"\w+")
FILE_RE = re.compile(r"^([0-9]{6})-[\w.-]+\.sql$")
# A file that starts with a digit or carries .sql anywhere in its name is meant
# to be a migration and must match FILE_RE exactly; anything else (README.md,
# helper scripts) is left alone.
LOOKS_LIKE_MIGRATION_RE = re.compile(r"^\d|\.sql", re.I)
# A bare, backquoted or double-quoted identifier.
IDENT = r"`[^`]+`|\"[^\"]+\"|\w+"
# The CREATE forms the script understands: what kind of object, and its name.
CREATE_RE = re.compile(
    r"CREATE\s+(?:OR\s+REPLACE\s+)?"
    r"(TABLE|(?:MATERIALIZED\s+|LIVE\s+|WINDOW\s+)?VIEW|DICTIONARY|FUNCTION)\s+"
    rf"(?:IF\s+NOT\s+EXISTS\s+)?({IDENT})",
    re.I,
)
# database.name where a statement names a table: after TABLE (CREATE, ALTER,
# DROP, TRUNCATE, OPTIMIZE, RENAME, ATTACH, ...), VIEW, DICTIONARY, INSERT INTO,
# a view's TO, FROM, JOIN, and the first operand of EXCHANGE TABLES; the second
# operand sits after AND, which only EXCHANGE_RE looks at.
QUALIFIED_RE = re.compile(
    r"\b(?:TABLES?|VIEW|DICTIONAR(?:Y|IES)|INTO|TO|FROM|JOIN)\s+"
    rf"(?:IF\s+(?:NOT\s+)?EXISTS\s+)?({IDENT})\s*\.\s*({IDENT})",
    re.I,
)
EXCHANGE_RE = re.compile(
    rf"\bEXCHANGE\s+(?:TABLES|DICTIONARIES)\s+(?:{IDENT})\s+AND\s+({IDENT})\s*\.\s*({IDENT})",
    re.I,
)
DROP_ORDER = {"VIEW": 0, "TABLE": 1, "DICTIONARY": 2}  # views first, dictionaries last


class Failed(Exception):
    def __init__(self, message: str, code: Optional[int] = None) -> None:
        super().__init__(message)
        self.code = code  # ClickHouse's error code, when the server sent one


def literal(text: str) -> str:
    """text as a single-quoted ClickHouse string literal."""
    return "'" + text.replace("\\", "\\\\").replace("'", "\\'") + "'"


def quoted(name: str) -> str:
    """name as a backquoted ClickHouse identifier."""
    return "`" + name.replace("\\", "\\\\").replace("`", "\\`") + "`"


def bare(identifier: str) -> str:
    """The name inside a backquoted or double-quoted identifier, else the identifier."""
    quote = identifier[0]
    if quote in '`"':
        return identifier[1:-1].replace(quote * 2, quote).replace("\\" + quote, quote)
    return identifier


# --------------------------------------------------------------------------- executors


class Http:
    """One statement per request to the ClickHouse HTTP interface."""

    def __init__(self, database: str) -> None:
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
        host = url_parts.hostname
        if not host:
            raise Failed(f"CLICKHOUSE_ENDPOINT {endpoint!r} has no host")
        if ":" in host:  # an IPv6 address goes back into its brackets
            host = f"[{host}]"
        self.database = database
        self.url = f"{url_parts.scheme}://{host}:{port}/?" + urllib.parse.urlencode(
            {
                "database": database,
                "default_format": "TabSeparated",
                # On ClickHouse Cloud any replica may answer a request, and
                # one that has not yet seen the parts another replica just
                # wrote returns a stale count. This makes a SELECT wait
                # until its replica has caught up with every insert that
                # finished before it. A no-op on a single server.
                "select_sequential_consistency": 1,
            }
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
            code = error.headers.get("X-ClickHouse-Exception-Code", "")
            raise Failed(
                f"HTTP {error.code}: {error.read().decode(errors='replace').strip()}",
                int(code) if code.isdigit() else None,
            ) from None
        except (OSError, http.client.HTTPException) as error:
            # URLError, timeouts and dropped connections all land here. The server
            # may still be running the statement.
            raise Failed(f"cannot reach {self.url.split('?')[0]}: {error}") from None


def rows_of(executor: Http, sql: str) -> List[dict]:
    """The rows of a SELECT, each a dict, via JSONEachRow."""
    return [json.loads(line) for line in executor.run(sql).splitlines()]


# --------------------------------------------------------------------------- target


@dataclass
class Target:
    folder: Path  # the directory of migration files
    name: str  # its name: the database the files are written for
    database: str  # where the statements run: the sandbox, or name with the flag


def resolve_target(folder_arg: str, migrate_database: bool) -> Target:
    folder = Path(folder_arg)
    if not folder.is_dir() and (HERE / folder_arg).is_dir():
        folder = HERE / folder_arg
    if not folder.is_dir():
        raise Failed(
            f"--folder {folder_arg}: not a directory; give a path, or the name of a "
            f"directory next to {SCRIPT}"
        )
    folder = folder.resolve()
    if not NAME_RE.fullmatch(folder.name):
        raise Failed(
            f"--folder {folder_arg}: {folder.name!r} is not a database name; a "
            "migration folder is named after the database its files are for"
        )
    database = folder.name if migrate_database else SANDBOX
    return Target(folder, folder.name, database)


def check_databases(wanted: List[str]) -> None:
    """Every database named must exist: the folder's, and the one the statements run in."""
    names = ", ".join(literal(name) for name in wanted)
    present = {
        row["name"]
        for row in rows_of(
            Http("system"),
            f"SELECT name FROM system.databases WHERE name IN ({names}) FORMAT JSONEachRow",
        )
    }
    missing = [name for name in wanted if name not in present]
    if missing:
        raise Failed(
            f"ClickHouse has no database named {', '.join(missing)}, or this user "
            "cannot see it; a migration folder is named after the database its "
            f"files are for, and the sandbox {SANDBOX} must exist too"
        )


# --------------------------------------------------------------------------- files and ledger


@dataclass
class Migration:
    version: int
    name: str
    statements: List[str]
    checksum: str


def quoted_end(text: str, start: int) -> int:
    """Index just past the quoted run opening at start; len(text) if it never closes."""
    quote = text[start]
    i = start + 1
    while i < len(text):
        if text[i] == "\\":
            i += 2
        elif text[i] == quote:
            if text.startswith(quote, i + 1):  # a doubled quote stands for itself
                i += 2
            else:
                return i + 1
        else:
            i += 1
    return len(text)


def statements(text: str) -> List[str]:
    """Split on ';' outside quotes; -- and /* */ comments are dropped."""
    found: List[str] = []
    current: List[str] = []
    i = 0
    while i < len(text):
        if text.startswith("--", i):
            end = text.find("\n", i)
            i = len(text) if end == -1 else end
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = len(text) if end == -1 else end + 2
        elif text[i] in "'\"`":
            end = quoted_end(text, i)
            current.append(text[i:end])
            i = end
        elif text[i] == ";":
            found.append("".join(current))
            current = []
            i += 1
        else:
            current.append(text[i])
            i += 1
    found.append("".join(current))
    return [sql.strip() for sql in found if sql.strip()]


def unquoted(sql: str) -> str:
    """sql with the contents of its string literals removed; identifiers stay."""
    out: List[str] = []
    i = 0
    while i < len(sql):
        if sql[i] == "'":
            out.append("''")
            i = quoted_end(sql, i)
        elif sql[i] in '"`':
            end = quoted_end(sql, i)
            out.append(sql[i:end])
            i = end
        else:
            out.append(sql[i])
            i += 1
    return "".join(out)


def refuse_qualified_names(migration: Migration) -> None:
    """A database.name anywhere in the file would reach past the target database."""
    for sql in migration.statements:
        skeleton = unquoted(sql)
        for pattern in (QUALIFIED_RE, EXCHANGE_RE):
            for match in pattern.finditer(skeleton):
                database, name = match.groups()
                if bare(database).lower() == "system":
                    continue
                raise Failed(
                    f"{migration.name}: {database}.{name} names a database; names "
                    f"must be bare and resolve in the database {SCRIPT} selects"
                )


def migrations(folder: Path) -> List[Migration]:
    """The folder's migration files in version order; refuses a misnamed one.

    Every file that starts with a digit or carries .sql in its name must be
    named NNNNNN-description.sql: six ASCII digits, a dash, a description,
    .sql. Other files (README.md, helper scripts) and directories are ignored.
    """
    found: List[Migration] = []
    for path in sorted(folder.iterdir()):
        if path.is_dir() or path.name.startswith("."):
            continue
        match = FILE_RE.match(path.name)
        if not match:
            if LOOKS_LIKE_MIGRATION_RE.search(path.name):
                raise Failed(
                    f"{path.name}: migration files are named NNNNNN-description.sql, "
                    "six digits, a dash, a description and .sql"
                )
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            raise Failed(
                f"{path.name}: cannot be read as UTF-8 text ({error})"
            ) from None
        migration = Migration(
            int(match.group(1)),
            path.name,
            statements(text),
            hashlib.sha256(text.encode()).hexdigest(),
        )
        refuse_qualified_names(migration)
        found.append(migration)
    if not found:
        raise Failed(f"{folder}: no NNNNNN-description.sql files")
    by_version: Dict[int, str] = {}
    for migration in found:
        first = by_version.setdefault(migration.version, migration.name)
        if first != migration.name:
            raise Failed(
                f"{first} and {migration.name} share the version {migration.version:06d}"
            )
    return sorted(found, key=lambda migration: migration.version)


def created_objects(migration: Migration) -> List[Tuple[str, str]]:
    """(kind, name) for each CREATE TABLE / VIEW / DICTIONARY / FUNCTION in the file."""
    created = []
    for sql in migration.statements:
        match = CREATE_RE.match(unquoted(sql))
        if match is None:
            continue
        kind, name = match.groups()
        kind = "VIEW" if "VIEW" in kind.upper() else kind.upper()
        created.append((kind, bare(name)))
    return created


def ledger(executor: Http) -> Dict[int, Dict[str, str]]:
    """version -> {name, checksum, applied_at}; empty when the ledger does not exist."""
    try:
        rows = rows_of(
            executor,
            f"SELECT version, name, checksum, applied_at FROM {LEDGER} "
            "ORDER BY version FORMAT JSONEachRow",
        )
    except Failed as error:
        if error.code == UNKNOWN_TABLE:
            return {}
        raise
    applied = {}
    try:
        for row in rows:
            applied[int(row["version"])] = {
                "name": row["name"],
                "checksum": row["checksum"],
                "applied_at": row["applied_at"],
            }
    except (KeyError, TypeError, ValueError):
        raise Failed(
            f"{executor.database}.{LEDGER} does not have the layout {SCRIPT} expects"
        ) from None
    return applied


def existing_tables(executor: Http, names: List[str]) -> List[str]:
    if not names:
        return []
    rows = rows_of(
        executor,
        f"SELECT name FROM system.tables WHERE database = {literal(executor.database)} "
        f"AND name IN ({', '.join(literal(name) for name in names)}) "
        "ORDER BY name FORMAT JSONEachRow",
    )
    return [row["name"] for row in rows]


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
                f"(in the sandbox {SANDBOX}, `drop --dangerously-and-irreversibly-destroy-data` starts over)"
            )


def refuse_if_tables_exist(executor: Http, migration: Migration) -> None:
    """An unrecorded file must not adopt tables that already exist."""
    created = [
        (kind, name) for kind, name in created_objects(migration) if kind != "FUNCTION"
    ]
    existing = existing_tables(executor, [name for _, name in created])
    if not existing:
        return
    drops = "; ".join(
        f"DROP {kind} IF EXISTS {executor.database}.{quoted(name)} SYNC"
        for kind, name in created
        if name in existing
    )
    raise Failed(
        f"{migration.name} is not recorded as applied, but these tables already "
        f"exist in {executor.database}: {', '.join(existing)}. If they are left over "
        f"from a failed run, drop them and retry: {drops}. If they belong to someone "
        "else, stop."
    )


def run_statement(executor: Http, migration: Migration, sql: str) -> None:
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


def cmd_status(executor: Http, files: List[Migration], args) -> int:
    applied = ledger(executor)
    attention = False
    for migration in files:
        record = applied.get(migration.version)
        if record is None:
            mark, state = colored("●", YELLOW), "not applied"
            attention = True
        else:
            mark, state = colored("✓", GREEN), f"applied {record['applied_at']}"
            if record["checksum"] != migration.checksum:
                mark = colored("✗", RED)
                state += ", " + colored("EDITED since", RED)
                attention = True
        print(f" {mark} {migration.name:48} {state}")
    for version, record in sorted(applied.items()):
        if version not in {migration.version for migration in files}:
            state = f"applied {record['applied_at']}, " + colored("file missing", RED)
            print(f" {colored('✗', RED)} {record['name']:48} {state}")
            attention = True
    return 2 if attention else 0


def cmd_apply(executor: Http, files: List[Migration], args) -> int:
    applied = ledger(executor)
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
                f"({migration.version}, {literal(migration.name)}, "
                f"{literal(migration.checksum)})",
            )
    print(ok() if args.execute else "dry run; add --execute to run these statements")
    return 0


@dataclass
class SandboxTable:
    name: str
    engine: str
    rows: Optional[int]  # None for views and dictionaries
    needs: List[
        str
    ]  # sandbox objects this one loads: a dictionary's source, a view's tables


def sandbox_tables(executor: Http) -> List[SandboxTable]:
    """Every table, view and dictionary in the sandbox, in an order safe to drop."""
    rows = rows_of(
        executor,
        "SELECT name, engine, total_rows, loading_dependencies_database, "
        "loading_dependencies_table FROM system.tables "
        f"WHERE database = {literal(SANDBOX)} ORDER BY name FORMAT JSONEachRow",
    )
    tables = []
    for row in rows:
        needs = [
            table
            for database, table in zip(
                row["loading_dependencies_database"], row["loading_dependencies_table"]
            )
            if database == SANDBOX
        ]
        total = row["total_rows"]
        tables.append(
            SandboxTable(
                row["name"], row["engine"], None if total is None else int(total), needs
            )
        )
    return drop_order(tables)


def drop_order(tables: List[SandboxTable]) -> List[SandboxTable]:
    """Dependents first: ClickHouse refuses to drop a table something still loads from.

    So a dictionary goes before its source table, a view before the tables it
    reads and writes, and a table before a dictionary its defaults call.
    """
    by_name = {table.name: table for table in tables}
    dependents = {table.name: 0 for table in tables}
    for table in tables:
        for name in table.needs:
            if name in dependents:
                dependents[name] += 1
    ordered: List[SandboxTable] = []
    ready = [table for table in tables if dependents[table.name] == 0]
    while ready:
        ready.sort(key=lambda table: (DROP_ORDER[drop_kind(table.engine)], table.name))
        table = ready.pop(0)
        ordered.append(table)
        for name in table.needs:
            if name in dependents:
                dependents[name] -= 1
                if dependents[name] == 0:
                    ready.append(by_name[name])
    # Dependencies cannot form a cycle; should one appear, the rest goes last
    # and ClickHouse has the final say.
    placed = {table.name for table in ordered}
    ordered.extend(table for table in tables if table.name not in placed)
    return ordered


def drop_kind(engine: str) -> str:
    if engine == "Dictionary":
        return "DICTIONARY"
    if "View" in engine:  # MaterializedView, View, LiveView, WindowView
        return "VIEW"
    return "TABLE"


def cmd_drop(executor: Http, args) -> int:
    """Empty the sandbox: every table in it goes, whatever created it."""
    if executor.database != SANDBOX:  # main already refuses the flag for drop
        raise Failed(
            f"drop empties the sandbox {SANDBOX} only; nothing in {executor.database} is dropped"
        )
    tables = sandbox_tables(executor)
    if not tables:
        print(f"{SANDBOX} holds no tables; nothing to drop")
        return 0
    for table in tables:
        sql = f"DROP {drop_kind(table.engine)} IF EXISTS {SANDBOX}.{quoted(table.name)} SYNC"
        about = table.engine
        if table.rows is not None:
            about += f", {table.rows:,} rows"
        print(f"   {sql}  -- {about}")
        if args.yes:
            executor.run(sql)
    if args.yes:
        print(ok())
    else:
        print(
            f"dry run; this deletes every table in {SANDBOX}, data included, whether or "
            "not a migration created it, and ClickHouse cannot undo it. Pass "
            "--dangerously-and-irreversibly-destroy-data to run the statements"
        )
    return 0


def main(argv=None) -> int:
    # allow_abbrev=False everywhere: otherwise argparse would accept a bare
    # --dangerously as an abbreviation of the long flags.
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        allow_abbrev=False,
    )
    parser.add_argument(
        "--folder",
        metavar="DIR",
        help="directory of NNNNNN-description.sql files, named after the database "
        "they are written for; a path, or the name of a directory next to this "
        "script. status and apply need it, drop does not",
    )
    parser.add_argument(
        DANGEROUSLY_AND_IRREVERSIBLY_MIGRATE_DATABASE,
        dest="migrate_database",
        action="store_true",
        help=f"run in the folder's own database instead of the sandbox {SANDBOX}",
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
        help=f"list every table in the sandbox {SANDBOX}, or with its flag drop them all; never a real database",
        allow_abbrev=False,
    )
    drop_cmd.add_argument(
        "--dangerously-and-irreversibly-destroy-data",
        dest="yes",
        action="store_true",
        help=f"run the statements: every table in {SANDBOX} and all its rows are deleted for good",
    )
    args = parser.parse_args(argv)
    try:
        if args.command == "drop":
            if args.migrate_database:
                raise Failed(
                    f"drop empties the sandbox {SANDBOX} and never runs in a real database; "
                    f"leave out {DANGEROUSLY_AND_IRREVERSIBLY_MIGRATE_DATABASE}"
                )
            check_databases([SANDBOX])
            print(f"database {SANDBOX} (the sandbox)")
            return cmd_drop(Http(SANDBOX), args)
        if args.folder is None:
            parser.error(f"{args.command} needs --folder")
        target = resolve_target(args.folder, args.migrate_database)
        # A misnamed file or a qualified name stops us before we connect.
        files = migrations(target.folder)
        check_databases(sorted({target.name, target.database}))
        where = (
            "the sandbox" if target.database == SANDBOX else "the folder's own database"
        )
        print(f"folder   {target.folder}")
        print(f"database {target.database} ({where})")
        command = cmd_status if args.command == "status" else cmd_apply
        return command(Http(target.database), files, args)
    except Failed as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
