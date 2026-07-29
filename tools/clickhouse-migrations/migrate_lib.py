"""Pure, database-free logic for the ClickHouse migration runner: discovery,
validation, ordering, and checksums. Kept importable with only the standard library
so ``migrate.py`` (which owns the connection and CLI) can re-export these names and
the test suite can exercise them without the ClickHouse driver."""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass
from pathlib import Path


logger = logging.getLogger("clickhouse_migrations")

_MIGRATION_RE = re.compile(r"^(\d{4})_(.+)\.sql$")


class MigrationError(Exception):
    """A migration set problem with a user-facing message (malformed file, duplicate
    version, unreadable body). Carries no traceback intent: callers print ``str(exc)``
    and exit non-zero rather than propagate a stack trace."""


@dataclass(frozen=True)
class Migration:
    version: str  # four-digit zero-padded prefix; compared as a plain string
    name: str
    path: Path

    @property
    def sql(self) -> str:
        return self.path.read_text(encoding="utf-8")


@dataclass(frozen=True)
class OrderingReport:
    errors: list[str]  # fatal on apply unless overridden (duplicates never overridable)
    warnings: list[str]  # informational: gaps, or out-of-order when explicitly allowed


def load_sql(migration: Migration) -> str:
    """Read a migration body, converting read/decode failures into a MigrationError so
    the CLI reports a clean message instead of a raw traceback."""
    try:
        return migration.sql
    except UnicodeDecodeError as exc:
        raise MigrationError(f"{migration.path.name} is not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise MigrationError(
            f"Cannot read migration {migration.path.name}: {exc}"
        ) from exc


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
        if not path.is_file():
            continue
        m = _MIGRATION_RE.match(path.name)
        if m:
            found.append(Migration(m.group(1), m.group(2), path))
        else:
            # A .sql file that does not parse is almost always a mis-named migration;
            # warn rather than silently ignore it so the author notices.
            logger.warning(
                "Ignoring %s: not a NNNN_description.sql migration "
                "(needs a four-digit prefix and a non-empty description).",
                path.name,
            )
    return found


def pending_migrations(
    migrations: list[Migration], applied: set[str]
) -> list[Migration]:
    return [m for m in migrations if m.version not in applied]


def current_version(applied: set[str]) -> str | None:
    return max(applied) if applied else None


def compute_checksum(text: str) -> str:
    """SHA-256 of the migration body with ONLY line endings and the trailing EOF
    newline(s) normalized, so re-saving a file with different line endings or an
    added/removed final newline does not read as drift. Every other change — including
    trailing whitespace, even before an interior newline inside a multi-line string
    literal — changes the checksum, keeping drift detection conservative."""
    unified = text.replace("\r\n", "\n").replace("\r", "\n")
    return hashlib.sha256(unified.rstrip("\n").encode("utf-8")).hexdigest()


def _strip_sql_noise(text: str) -> str:
    """Remove ``--``, ``#`` and ``#!`` line comments, ``/* */`` block comments, and
    quoted spans (``'...'``, ``"..."``, ```...```) so a statement separator inside any of
    them is not mistaken for the end of a statement. Only single-quoted string literals
    honour backslash escaping; identifiers (``"..."`` and ```...```) escape their quote by
    doubling it, matching ClickHouse."""
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "#" or text[i : i + 2] == "--":
            nl = text.find("\n", i)
            if nl == -1:
                break
            i = nl
            continue
        if text[i : i + 2] == "/*":
            end = text.find("*/", i + 2)
            i = n if end == -1 else end + 2
            continue
        if ch in "'\"`":
            i += 1
            while i < n:
                c = text[i]
                if c == "\\" and ch == "'":
                    i += 2
                    continue
                if c == ch:
                    if i + 1 < n and text[i + 1] == ch:
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def assert_single_statement(text: str) -> None:
    """Reject an empty body and any statement separator (``;``) that is not inside a
    comment or quoted string. A single optional trailing ``;`` is tolerated."""
    body = _strip_sql_noise(text).strip()
    if not body:
        raise MigrationError("body is empty after stripping comments")
    if body.endswith(";"):
        body = body[:-1]
    if ";" in body:
        raise MigrationError(
            "multiple statements found (interior ';'); one statement per file"
        )


def _duplicate_versions(migrations: list[Migration]) -> dict[str, list[str]]:
    """Map each version claimed by more than one file to those file names."""
    by_version: dict[str, list[str]] = {}
    for m in migrations:
        by_version.setdefault(m.version, []).append(m.path.name)
    return {v: names for v, names in by_version.items() if len(names) > 1}


def validate_migrations(migrations: list[Migration]) -> None:
    """Raise MigrationError on any structural problem: a version claimed by two files,
    an unreadable body, an empty/comment-only body, or more than one statement."""
    dupes = _duplicate_versions(migrations)
    if dupes:
        detail = "; ".join(
            f"{v}: {', '.join(sorted(names))}" for v, names in sorted(dupes.items())
        )
        raise MigrationError(f"Duplicate migration version(s): {detail}")
    for m in migrations:
        text = load_sql(m)
        try:
            assert_single_statement(text)
        except MigrationError as exc:
            raise MigrationError(f"{m.path.name}: {exc}") from exc


def _gap_warnings(migrations: list[Migration]) -> list[str]:
    versions = sorted({int(m.version) for m in migrations})
    warnings: list[str] = []
    for prev, nxt in zip(versions, versions[1:]):
        if nxt > prev + 1:
            missing = ", ".join(f"{n:04d}" for n in range(prev + 1, nxt))
            warnings.append(
                f"gap in migration sequence: missing {missing} "
                f"between {prev:04d} and {nxt:04d}"
            )
    return warnings


def check_ordering(
    migrations: list[Migration],
    applied: set[str],
    *,
    allow_out_of_order: bool,
) -> OrderingReport:
    """Assess forward-only ordering. A pending migration numbered below the highest
    applied version is out-of-order (fatal unless ``allow_out_of_order``); a duplicated
    version is always fatal; a gap in the sequence is only a warning."""
    errors: list[str] = []
    warnings: list[str] = []
    for version, names in sorted(_duplicate_versions(migrations).items()):
        errors.append(
            f"duplicate migration version {version}: {', '.join(sorted(names))}"
        )
    if applied:
        frontier = max(applied)
        for m in migrations:
            if m.version not in applied and m.version < frontier:
                msg = (
                    f"out-of-order migration {m.path.name}: version {m.version} "
                    f"precedes already-applied {frontier}"
                )
                if allow_out_of_order:
                    warnings.append(msg + " (allowed by --allow-out-of-order)")
                else:
                    errors.append(msg)
    warnings.extend(_gap_warnings(migrations))
    return OrderingReport(errors=errors, warnings=warnings)


def detect_drift(migrations: list[Migration], ledger: dict[str, str]) -> list[str]:
    """Return a message for every applied migration whose current file no longer
    matches its recorded checksum. Rows with an empty stored checksum (legacy, recorded
    before checksums existed) and applied versions with no file are skipped."""
    by_version = {m.version: m for m in migrations}
    messages: list[str] = []
    for version, stored in ledger.items():
        if not stored:
            continue
        m = by_version.get(version)
        if m is None:
            continue
        current = compute_checksum(load_sql(m))
        if current != stored:
            messages.append(
                f"{m.path.name}: recorded checksum {stored[:12]} "
                f"!= current {current[:12]} (migration file changed after apply)"
            )
    return messages


def orphan_versions(migrations: list[Migration], ledger: dict[str, str]) -> list[str]:
    """Versions recorded in the ledger that have no migration file on disk — usually a
    file deleted or renamed after it was applied. Informational, never fatal."""
    known = {m.version for m in migrations}
    return sorted(v for v in ledger if v not in known)
