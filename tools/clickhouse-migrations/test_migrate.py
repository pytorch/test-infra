"""Tests for migrate.py. Imports the module directly — clickhouse_connect is imported
lazily inside connect(), so these run without the driver installed."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import migrate
import pytest


class FakeResult:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self.result_rows = rows


class FakeClient:
    """Records commands/inserts in order and serves canned ledger reads. Creating the
    ledger flips it to 'exists'; each insert makes that version visible to later reads,
    mirroring the real record-after-success flow."""

    def __init__(
        self,
        applied: list[str] | None = None,
        ledger_exists: bool | None = None,
        fail_on: str | None = None,
        fail_exc: Exception | None = None,
    ) -> None:
        self._applied = list(applied or [])
        self._exists = bool(self._applied) if ledger_exists is None else ledger_exists
        self._fail_on = fail_on
        self._fail_exc = fail_exc
        self.url = "https://fake:8443"
        self.database = "misc"
        self.commands: list[str] = []
        self.inserts: list[tuple[str, Any, Any]] = []
        self.events: list[tuple[str, str]] = []

    def query(self, query: str, parameters: dict[str, Any] | None = None) -> FakeResult:
        if "system.tables" in query:
            return FakeResult([(1 if self._exists else 0,)])
        if "FINAL" in query:
            return FakeResult([(v,) for v in self._applied])
        return FakeResult([])

    def command(self, statement: str, parameters: dict[str, Any] | None = None) -> str:
        self.commands.append(statement)
        self.events.append(("command", statement))
        if "CREATE TABLE" in statement and "schema_migrations" in statement:
            self._exists = True
        if self._fail_on and self._fail_on in statement:
            raise self._fail_exc or RuntimeError("boom")
        return ""

    def insert(self, table: str, data: Any, column_names: Any = None) -> None:
        version = str(data[0][0])
        self.inserts.append((table, data, column_names))
        self.events.append(("insert", version))
        self._applied.append(version)


def _write(d: Path, name: str, sql: str = "SELECT 1") -> None:
    (d / name).write_text(sql, encoding="utf-8")


def test_discovery_orders_by_version_and_ignores_non_matching(tmp_path: Path) -> None:
    _write(tmp_path, "0002_second.sql")
    _write(tmp_path, "0001_first.sql")
    _write(tmp_path, "0010_tenth.sql")
    _write(tmp_path, "notes.txt")  # wrong extension
    _write(tmp_path, "bad_name.sql")  # no NNNN prefix
    _write(tmp_path, "003_short.sql")  # only three digits
    migs = migrate.discover_migrations(tmp_path)
    assert [m.version for m in migs] == ["0001", "0002", "0010"]
    assert [m.name for m in migs] == ["first", "second", "tenth"]


def test_missing_dir_explicit_raises_but_default_is_empty(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        migrate.discover_migrations(tmp_path / "nope", explicit=True)
    assert migrate.discover_migrations(tmp_path / "nope", explicit=False) == []


def test_pending_and_current_version() -> None:
    migs = [
        migrate.Migration("0001", "a", Path("0001_a.sql")),
        migrate.Migration("0002", "b", Path("0002_b.sql")),
    ]
    assert [m.version for m in migrate.pending_migrations(migs, set())] == [
        "0001",
        "0002",
    ]
    assert [m.version for m in migrate.pending_migrations(migs, {"0001"})] == ["0002"]
    assert migrate.current_version(set()) is None
    assert migrate.current_version({"0001", "0002"}) == "0002"


def test_status_all_pending_when_ledger_absent(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql")
    _write(tmp_path, "0002_b.sql")
    migs = migrate.discover_migrations(tmp_path)
    lines: list[str] = []
    rc = migrate.run_status(FakeClient(ledger_exists=False), migs, out=lines.append)
    assert rc == 0
    assert lines[0] == "Current version: none"
    assert any("Pending migrations (2)" in ln for ln in lines)
    assert any(ln.strip().startswith("0001") for ln in lines)


def test_status_with_some_applied(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql")
    _write(tmp_path, "0002_b.sql")
    _write(tmp_path, "0003_c.sql")
    migs = migrate.discover_migrations(tmp_path)
    lines: list[str] = []
    migrate.run_status(FakeClient(applied=["0001", "0002"]), migs, out=lines.append)
    assert lines[0] == "Current version: 0002"
    assert any("Pending migrations (1)" in ln for ln in lines)
    assert any("0003" in ln for ln in lines)


def test_apply_runs_only_pending_in_order_recording_after_success(
    tmp_path: Path,
) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    _write(tmp_path, "0002_b.sql", "CREATE TABLE b")
    migs = migrate.discover_migrations(tmp_path)
    client = FakeClient(ledger_exists=False)
    rc = migrate.run_apply(client, migs, out=lambda _ln: None)
    assert rc == 0
    assert client.commands[0] == migrate.CREATE_LEDGER_SQL
    assert client.commands[1:] == ["CREATE TABLE a", "CREATE TABLE b"]
    body = [e for e in client.events if e != ("command", migrate.CREATE_LEDGER_SQL)]
    assert body == [
        ("command", "CREATE TABLE a"),
        ("insert", "0001"),
        ("command", "CREATE TABLE b"),
        ("insert", "0002"),
    ]


def test_apply_skips_already_applied(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    _write(tmp_path, "0002_b.sql", "CREATE TABLE b")
    migs = migrate.discover_migrations(tmp_path)
    client = FakeClient(applied=["0001"])
    rc = migrate.run_apply(client, migs, out=lambda _ln: None)
    assert rc == 0
    assert client.commands == [migrate.CREATE_LEDGER_SQL, "CREATE TABLE b"]
    assert [ins[1][0][0] for ins in client.inserts] == ["0002"]


def test_apply_stops_without_recording_and_hints_on_access_error(
    tmp_path: Path,
) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    _write(tmp_path, "0002_bad.sql", "CREATE BROKEN")
    migs = migrate.discover_migrations(tmp_path)
    exc = RuntimeError("Code: 497. DB::Exception: ACCESS_DENIED")
    client = FakeClient(ledger_exists=False, fail_on="BROKEN", fail_exc=exc)
    lines: list[str] = []
    rc = migrate.run_apply(client, migs, out=lines.append)
    assert rc == 1
    assert [ins[1][0][0] for ins in client.inserts] == ["0001"]
    assert any("ERROR applying 0002 bad" in ln for ln in lines)
    assert any("DDL/admin credential" in ln for ln in lines)


def test_dry_run_prints_bootstrap_and_ledger_inserts(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    migs = migrate.discover_migrations(tmp_path)
    lines: list[str] = []
    rc = migrate.run_dry_run(migs, out=lines.append)
    assert rc == 0
    joined = "\n".join(lines)
    assert "CREATE TABLE IF NOT EXISTS misc.schema_migrations" in joined
    assert (
        "INSERT INTO misc.schema_migrations (version, name) VALUES ('0001', 'a');"
        in joined
    )
