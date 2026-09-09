"""Pins the three artifacts that must agree on ``misc.greenlight_pr_state``'s column order.

The S3 -> ClickHouse replicator inserts positionally -- ``general_adapter`` issues
``INSERT ... SELECT *, (bucket, key) AS _meta`` -- so the writer's JSONEachRow field order, the
adapter's schema string, and the table's own DDL are one contract, and order is as load-bearing
as membership. A skew raises ``NUMBER_OF_COLUMNS_DOESNT_MATCH``, which ``general_adapter``
swallows into ``errors.gen_errors``; nothing alerts on that table, so the only symptom is that
rows stop arriving. Nothing at build time links the three, and each lives in a tree the other
two's CI does not watch.

``greenlight.state_emit.emit_row`` is the source of truth: these tests read the adapter and
replay the migrations, and fail when either stops matching what the writer emits. The row order
is probed out of the writer rather than restated here -- a hand-copied list would only pin these
tests against themselves.

``_meta`` is the one column the writer and the adapter both omit, because the replicator appends
it. That is also why the DDL must keep it last among the ordinary columns.

The same silence covers the wiring that reaches that schema at all: an object key the replicator
does not recognize, or a table no longer pointed at this adapter, drops the row just as quietly as
a column skew. Those two are checked against the imported module -- real values and real function
identity, not text -- because the replicator's only runtime dependency is one greenlight already
has.
"""

from __future__ import annotations

import gzip
import importlib.util
import json
import re
from datetime import UTC, datetime
from functools import cache
from pathlib import Path
from typing import TYPE_CHECKING, NamedTuple

import pytest

from greenlight import state_emit
from greenlight.constants import S3_BUCKET, S3_KEY_PREFIX

if TYPE_CHECKING:
    from types import ModuleType

ROOT = Path(__file__).resolve().parents[2]

_ADAPTER = "aws/lambda/clickhouse-replicator-s3/lambda_function.py"
_SQL_DIR = "greenlight/sql"
_WRITER = "greenlight/src/greenlight/state_emit.py"

assert (ROOT / _ADAPTER).is_file()
assert (ROOT / _SQL_DIR).is_dir()

_TABLE = "misc.greenlight_pr_state"
# Carries the open paren so a suffixed rename (`..._v2`) misses this rather than prefix-matching
# it and failing later, deep in the parse, with something other than the message written here.
_ADAPTER_FN = "def greenlight_pr_state_adapter("
_REPLICATOR_APPENDED = "_meta"

_SQL_COMMENT_RE = re.compile(r"--[^\n]*")
_IDENT_RE = re.compile(r"`?(\w+)`?")
_COLUMN_RE = re.compile(r"`?(\w+)`?\s+(.+)", re.DOTALL)
_SCHEMA_RE = re.compile(r'schema\s*=\s*"""(.*?)"""', re.DOTALL)
# Everything a column definition may carry AFTER its type. Cut here and what remains is the type.
_TYPE_MODIFIER_RE = re.compile(
    r"\b(?:DEFAULT|MATERIALIZED|ALIAS|EPHEMERAL|CODEC|TTL|COMMENT|AFTER|FIRST|NOT\s+NULL|NULL)\b",
    re.IGNORECASE,
)
_WHITESPACE_RE = re.compile(r"\s+")
_LOW_CARDINALITY_RE = re.compile(r"^lowcardinality\((.*)\)$")
# MATERIALIZED/ALIAS columns are computed server-side: `SELECT *` never yields them and a
# positional INSERT never fills them, so they are outside this contract.
_COMPUTED_RE = re.compile(r"\b(?:MATERIALIZED|ALIAS)\b", re.IGNORECASE)
_CREATE_RE = re.compile(r"^CREATE\s+TABLE\b", re.IGNORECASE)
_ALTER_RE = re.compile(r"^ALTER\s+TABLE\b", re.IGNORECASE)
_ADD_COLUMN_RE = re.compile(r"^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(.*)$", re.IGNORECASE | re.DOTALL)
_MODIFY_COLUMN_RE = re.compile(r"^MODIFY\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(`?\w+`?\s+.+)$", re.IGNORECASE | re.DOTALL)
_DROP_COLUMN_RE = re.compile(r"^DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?`?(\w+)`?\b", re.IGNORECASE)
_MODIFY_ORDER_BY_RE = re.compile(r"^MODIFY\s+ORDER\s+BY\b", re.IGNORECASE)
_AFTER_RE = re.compile(r"\bAFTER\s+`?(\w+)`?", re.IGNORECASE)
_FIRST_RE = re.compile(r"\bFIRST\b", re.IGNORECASE)

_FIXED = datetime(2026, 7, 30, 12, 0, tzinfo=UTC)
_HASH = "a" * 64
_EMIT_ID = "e" * 32


def _drift(artifact: str, detail: str) -> str:
    return (
        f"{artifact} drifted from {_WRITER}, which is the source of truth for the state row's "
        f"column order: change {artifact} to match it, or change all three together ({_WRITER}, "
        f"{_SQL_DIR}/*.sql, {_ADAPTER}). The replicator's INSERT is positional, so a skew raises "
        f"NUMBER_OF_COLUMNS_DOESNT_MATCH -- which general_adapter swallows into errors.gen_errors, "
        f"leaving no signal but rows that stop arriving. {detail}"
    )


def _split_top_level(text: str) -> list[str]:
    """Split on the commas outside parentheses, keeping ``Tuple(bucket String, key String)`` whole."""
    parts: list[str] = []
    depth = 0
    start = 0
    for index, char in enumerate(text):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif char == "," and depth == 0:
            parts.append(text[start:index])
            start = index + 1
    parts.append(text[start:])
    return [part.strip() for part in parts if part.strip()]


def _parenthesized(text: str, search_from: int) -> str:
    """The contents of the parenthesis group opening at or after ``search_from``."""
    open_at = text.find("(", search_from)
    assert open_at != -1, f"no parenthesis group after offset {search_from} in: {text!r}"
    depth = 0
    for index in range(open_at, len(text)):
        if text[index] == "(":
            depth += 1
        elif text[index] == ")":
            depth -= 1
            if depth == 0:
                return text[open_at + 1 : index]
    raise AssertionError(f"unbalanced parentheses from offset {open_at} in: {text!r}")


class _Column(NamedTuple):
    name: str
    type: str


def _column_name(definition: str) -> str:
    match = _IDENT_RE.match(definition)
    assert match is not None, f"no column name at the head of {definition!r}"
    return match.group(1)


def _strip_modifiers(rest: str) -> str:
    """``rest`` up to the first modifier keyword outside parentheses -- i.e. the bare type."""
    for match in _TYPE_MODIFIER_RE.finditer(rest):
        # Depth 0 only: a modifier keyword can legitimately be a field name inside a compound type
        # (``Tuple(comment String)``), where it is part of the type rather than the end of it.
        if rest.count("(", 0, match.start()) == rest.count(")", 0, match.start()):
            return rest[: match.start()]
    return rest


def _normalize_type(raw: str) -> str:
    """Fold the spellings ClickHouse itself treats as one type.

    Case and internal whitespace are both insignificant to ClickHouse, and 002 relies on it:
    it restates ``version`` as ``DATETIME64 (3)``, the sqlfluff-canonical form inside an
    ALTER, for the ``DateTime64(3)`` that 001 declares.
    """
    return _WHITESPACE_RE.sub("", _strip_modifiers(raw)).lower()


def _read_schema_equivalents(table_type: str) -> set[str]:
    """The adapter spellings that are safe to read a column of ``table_type`` with.

    Exactly one widening is allowed, and only in this direction: a ``LowCardinality(T)`` table
    column may be read as bare ``T``. LowCardinality is an encoding, not a type -- the s3 reader
    parses the JSON value as ``T`` either way and ClickHouse applies the dictionary on insert,
    which is what the adapter already does for ``repo``, ``status`` and ``reason``.

    Nothing else is allowed, including things that would in fact work:

    * ``Nullable(T)`` against ``T`` is rejected outright -- a null parses on the read side and
      then fails the insert, which is the same swallowed error this file exists to prevent.
    * A narrower numeric read type (``Int32`` for an ``Int64`` column) is rejected: the read
      schema is what parses the JSON, so the overflow happens before any widening could help.
    * ``DateTime64`` precision must match exactly; a different one silently rescales.
    * Bare ``T`` in the table read as ``LowCardinality(T)`` is harmless but rejected anyway --
      the pair is ambiguous enough to be worth a human deciding, so this asserts the narrow
      thing and makes someone come here rather than allowing it in silence.
    """
    equivalents = {table_type}
    unwrapped = _LOW_CARDINALITY_RE.match(table_type)
    if unwrapped is not None:
        equivalents.add(unwrapped.group(1))
    return equivalents


def _ordinary_column(definition: str) -> _Column | None:
    """The declared column, or ``None`` when it is computed server-side rather than stored."""
    match = _COLUMN_RE.match(definition)
    assert match is not None, f"no `<name> <type>` at the head of {definition!r}"
    name, rest = match.group(1), match.group(2)
    if _COMPUTED_RE.search(rest):
        return None
    declared = _normalize_type(rest)
    assert declared, f"no type on column `{name}` in {definition!r}"
    return _Column(name, declared)


def _index_of(columns: list[_Column], name: str) -> int | None:
    return next((index for index, column in enumerate(columns) if column.name == name), None)


def _apply_add_column(definition: str, columns: list[_Column]) -> None:
    column = _ordinary_column(definition)
    if column is None:
        return
    after = _AFTER_RE.search(definition)
    if after is not None:
        anchor = _index_of(columns, after.group(1))
        assert anchor is not None, (
            f"{_SQL_DIR} places `{column.name}` AFTER `{after.group(1)}`, which no earlier migration adds"
        )
        columns.insert(anchor + 1, column)
    elif _FIRST_RE.search(definition):
        columns.insert(0, column)
    else:
        columns.append(column)


def _apply_alter_clause(clause: str, columns: list[_Column]) -> None:
    add = _ADD_COLUMN_RE.match(clause)
    if add is not None:
        _apply_add_column(add.group(1), columns)
        return
    modify = _MODIFY_COLUMN_RE.match(clause)
    if modify is not None:
        # A MODIFY COLUMN restates a type or default in place: it never moves the column, but the
        # type it restates IS the column's type from here on, so the replay has to take it.
        modified = _ordinary_column(modify.group(1))
        assert modified is not None, f"{_SQL_DIR} modifies a column into a computed one: {clause!r}"
        index = _index_of(columns, modified.name)
        assert index is not None, f"{_SQL_DIR} modifies `{modified.name}`, which no earlier migration adds"
        columns[index] = modified
        return
    drop = _DROP_COLUMN_RE.match(clause)
    if drop is not None:
        index = _index_of(columns, drop.group(1))
        assert index is not None, f"{_SQL_DIR} drops `{drop.group(1)}`, which no earlier migration adds"
        del columns[index]
        return
    assert _MODIFY_ORDER_BY_RE.match(clause) is not None, (
        f"{_SQL_DIR} has a DDL clause this replay cannot model: {clause!r}. Teach it that clause -- "
        f"a migration it reads as a no-op is a column order it silently stops checking."
    )


def _apply_statement(statement: str, columns: list[_Column]) -> None:
    assert _TABLE in statement, f"{_SQL_DIR} holds a statement that is not about {_TABLE}: {statement!r}"
    if _CREATE_RE.match(statement):
        for definition in _split_top_level(_parenthesized(statement, statement.index(_TABLE))):
            column = _ordinary_column(definition)
            if column is not None:
                columns.append(column)
        return
    assert _ALTER_RE.match(statement) is not None, f"{_SQL_DIR} holds an unrecognized statement: {statement!r}"
    for clause in _split_top_level(statement[statement.index(_TABLE) + len(_TABLE) :]):
        _apply_alter_clause(clause, columns)


def _table_columns() -> list[_Column]:
    """The table's ordinary columns, in order, by replaying every migration in filename order."""
    paths = sorted((ROOT / _SQL_DIR).glob("*.sql"))
    assert paths, f"no migrations under {_SQL_DIR}"
    columns: list[_Column] = []
    for path in paths:
        for raw in _SQL_COMMENT_RE.sub("", path.read_text()).split(";"):
            statement = raw.strip()
            if statement:
                _apply_statement(statement, columns)
    assert columns
    return columns


def _sql_columns() -> list[_Column]:
    return [column for column in _table_columns() if column.name != _REPLICATOR_APPENDED]


def _adapter_columns() -> list[_Column]:
    text = (ROOT / _ADAPTER).read_text()
    start = text.find(_ADAPTER_FN)
    assert start != -1, f"no `{_ADAPTER_FN}` in {_ADAPTER}; re-target this test at its new name"
    end = text.find("\ndef ", start)
    match = _SCHEMA_RE.search(text[start:] if end == -1 else text[start:end])
    assert match is not None, f'no `schema = """..."""` inside {_ADAPTER_FN} in {_ADAPTER}'
    columns: list[_Column] = []
    for definition in _split_top_level(match.group(1)):
        column = _ordinary_column(definition)
        assert column is not None, f"{_ADAPTER} declares a computed column in its read schema: {definition!r}"
        columns.append(column)
    assert columns, f"{_ADAPTER_FN} declares an empty schema in {_ADAPTER}"
    return columns


def _writer_columns() -> list[str]:
    captured: list[str] = []

    def emit(row_gzip: bytes, _key: str) -> None:
        captured.extend(json.loads(gzip.decompress(row_gzip).decode("utf-8")))

    state_emit.emit_row(
        repo="o/r",
        pr_number=1,
        head_sha="h",
        status="LAND",
        reason="clean",
        eval_hash=_HASH,
        message="LGTM",
        eval_job="ej",
        agent_job="aj",
        run_id=9,
        shadow=False,
        now=lambda: _FIXED,
        emit=emit,
        new_emit_id=lambda: _EMIT_ID,
    )

    assert captured
    return captured


_SOURCES = {
    _ADAPTER: _adapter_columns,
    _SQL_DIR: _sql_columns,
}


@pytest.mark.parametrize("artifact", list(_SOURCES))
def test_state_row_columns_match_the_writer(artifact: str) -> None:
    extracted = [column.name for column in _SOURCES[artifact]()]
    canonical = _writer_columns()
    assert extracted == canonical, _drift(artifact, f"it declares {extracted}, the writer emits {canonical}.")


def test_adapter_column_types_match_the_table() -> None:
    # Order and membership are only half the contract. A type skew is not a positional error, so it
    # raises a parse/convert failure rather than NUMBER_OF_COLUMNS_DOESNT_MATCH -- but general_adapter
    # swallows both into errors.gen_errors identically, so the symptom is the same silent stop. The
    # writer emits JSON and carries no types, which is why this pair is adapter against table.
    table = {column.name: column.type for column in _sql_columns()}
    mismatched = {
        column.name: (column.type, table[column.name])
        # A name absent from the table is drift the name test above reports; skip it rather than
        # raise a KeyError that buries that clearer message.
        for column in _adapter_columns()
        if column.name in table and column.type not in _read_schema_equivalents(table[column.name])
    }
    assert not mismatched, _drift(
        _ADAPTER,
        f"these columns are read with a type the table does not hold, as (adapter, table): {mismatched}. "
        f"Only a LowCardinality(T) column read as bare T is allowed; see _read_schema_equivalents for "
        f"why the rest -- Nullable, narrower numerics, a different DateTime64 precision -- are not.",
    )


@cache
def _replicator() -> ModuleType:
    """The replicator imported for real, so its wiring is checked as values rather than as text."""
    spec = importlib.util.spec_from_file_location("_clickhouse_replicator_s3", ROOT / _ADAPTER)
    assert spec is not None, f"cannot load {_ADAPTER} as a module"
    assert spec.loader is not None, f"{_ADAPTER} has no module loader"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_writers_key_prefix_is_a_registered_path() -> None:
    # Read out of the replicator's own SUPPORTED_PATHS and keyed by the writer's own S3_KEY_PREFIX,
    # so neither side of this is a literal restated here. An unregistered prefix is not an error in
    # the replicator -- extract_clickhouse_table_name simply returns None and the object is ignored,
    # so the rows never even reach the adapter to fail.
    registered = _replicator().SUPPORTED_PATHS.get(S3_KEY_PREFIX)
    assert registered == _TABLE, _drift(
        _ADAPTER,
        f"SUPPORTED_PATHS maps {S3_KEY_PREFIX!r} to {registered!r} rather than to {_TABLE}. The writer "
        f"keys every object under that prefix, so the entry must exist and must name this table.",
    )


def test_an_emitted_object_key_routes_to_the_state_table() -> None:
    # The registration above stated as the replicator resolves it: a key the writer really produces,
    # through the function the replicator really dispatches on. SUPPORTED_PATHS is matched by
    # `startswith(f"{path}/")`, not by equality, so the entry can be present and correct and a key
    # still fail to route -- this is the assertion that covers the prefix boundary itself.
    key = state_emit.object_key("pytorch/pytorch", 1, "2026-07-30 12:00:00.000", _EMIT_ID)
    routed = _replicator().extract_clickhouse_table_name(S3_BUCKET, key)
    assert routed == _TABLE, _drift(
        _ADAPTER,
        f"it routes {key!r} to {routed!r} rather than {_TABLE}.",
    )


def test_the_state_table_is_wired_to_the_state_adapter() -> None:
    # Routing to the table is only half of it: OBJECT_CONVERTER is what turns that table into the
    # schema the two tests above pin. Left unwired, every column here can be correct and no row lands.
    module = _replicator()
    wired = module.OBJECT_CONVERTER.get(_TABLE)
    assert wired is module.greenlight_pr_state_adapter, _drift(
        _ADAPTER,
        f"OBJECT_CONVERTER maps {_TABLE} to {getattr(wired, '__name__', wired)!r} rather than to "
        f"greenlight_pr_state_adapter, so the column list this file pins is not the one it inserts with.",
    )


def test_meta_stays_the_last_ordinary_column() -> None:
    columns = [column.name for column in _table_columns()]
    assert columns[-1] == _REPLICATOR_APPENDED, _drift(
        _SQL_DIR,
        f"`{_REPLICATOR_APPENDED}` is not the last ordinary column: {columns}. general_adapter "
        f"appends it as the final expression of its `SELECT *, (bucket, key)`, so every column "
        f"added after it lands in the wrong slot -- or, when the counts still match, silently "
        f"stores the bucket/key tuple's value.",
    )
