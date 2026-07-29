"""Tests for migrate.py. Imports the module directly — clickhouse_connect is imported
lazily inside connect(), so these run without the driver installed."""

from __future__ import annotations

import sys
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
    mirroring the real record-after-success flow.

    ``_applied`` maps version -> stored checksum. The bootstrap ALTER (add checksum
    column) is recorded in ``alters``/``bootstrap`` but NOT in ``commands``/``events``,
    so assertions written before the checksum column stay valid."""

    def __init__(
        self,
        applied: list[str] | dict[str, str] | None = None,
        ledger_exists: bool | None = None,
        fail_on: str | None = None,
        fail_exc: Exception | None = None,
        has_checksum: bool = True,
        insert_exc: Exception | None = None,
    ) -> None:
        if isinstance(applied, dict):
            self._applied: dict[str, str] = dict(applied)
        else:
            self._applied = dict.fromkeys(applied or [], "")
        self._exists = bool(self._applied) if ledger_exists is None else ledger_exists
        self._has_checksum = has_checksum
        self._fail_on = fail_on
        self._fail_exc = fail_exc
        self._insert_exc = insert_exc
        self.url = "https://fake:8443"
        self.database = "misc"
        self.commands: list[str] = []
        self.alters: list[str] = []
        self.bootstrap: list[str] = []
        self.inserts: list[tuple[str, Any, Any]] = []
        self.events: list[tuple[str, str]] = []

    def query(self, query: str, parameters: dict[str, Any] | None = None) -> FakeResult:
        if "system.tables" in query:
            return FakeResult([(1 if self._exists else 0,)])
        if "system.columns" in query:
            return FakeResult([(1 if self._has_checksum else 0,)])
        if "FINAL" in query:
            if "checksum" in query:
                return FakeResult([(v, cs) for v, cs in self._applied.items()])
            return FakeResult([(v,) for v in self._applied])
        return FakeResult([])

    def command(self, statement: str, parameters: dict[str, Any] | None = None) -> str:
        if "ADD COLUMN" in statement and "checksum" in statement:
            self.alters.append(statement)
            self.bootstrap.append(statement)
            return ""
        self.commands.append(statement)
        self.events.append(("command", statement))
        if "CREATE TABLE" in statement and "schema_migrations" in statement:
            self._exists = True
            self._has_checksum = True
            self.bootstrap.append(statement)
        if self._fail_on and self._fail_on in statement:
            raise self._fail_exc or RuntimeError("boom")
        return ""

    def insert(self, table: str, data: Any, column_names: Any = None) -> None:
        row = data[0]
        version = str(row[0])
        if self._insert_exc is not None:
            raise self._insert_exc
        self.inserts.append((table, data, column_names))
        self.events.append(("insert", version))
        self._applied[version] = str(row[2]) if len(row) > 2 else ""


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


# --- ordering (F1) ---------------------------------------------------------------


def _mig(v: str) -> migrate.Migration:
    return migrate.Migration(v, "x", Path(f"{v}_x.sql"))


def test_check_ordering_flags_duplicate_version() -> None:
    report = migrate.check_ordering(
        [_mig("0001"), _mig("0001")], set(), allow_out_of_order=False
    )
    assert any("duplicate" in e for e in report.errors)


def test_check_ordering_out_of_order_and_gap() -> None:
    migs = [_mig("0001"), _mig("0002"), _mig("0003")]
    strict = migrate.check_ordering(migs, {"0001", "0003"}, allow_out_of_order=False)
    assert any("0002" in e for e in strict.errors)
    lax = migrate.check_ordering(migs, {"0001", "0003"}, allow_out_of_order=True)
    assert lax.errors == []
    assert any("0002" in w for w in lax.warnings)
    gapped = migrate.check_ordering(
        [_mig("0001"), _mig("0003")], {"0001"}, allow_out_of_order=False
    )
    assert any("gap" in w for w in gapped.warnings)


def test_apply_refuses_out_of_order(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    _write(tmp_path, "0003_c.sql", "CREATE TABLE c")
    _write(tmp_path, "0002_b.sql", "CREATE TABLE b")
    migs = migrate.discover_migrations(tmp_path)
    client = FakeClient(applied=["0001", "0003"])
    lines: list[str] = []
    rc = migrate.run_apply(client, migs, out=lines.append)
    assert rc == 1
    assert any("out-of-order" in ln and "0002_b.sql" in ln for ln in lines)
    assert client.commands == []
    assert client.inserts == []


def test_apply_allow_out_of_order(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    _write(tmp_path, "0003_c.sql", "CREATE TABLE c")
    _write(tmp_path, "0002_b.sql", "CREATE TABLE b")
    migs = migrate.discover_migrations(tmp_path)
    client = FakeClient(applied=["0001", "0003"])
    lines: list[str] = []
    rc = migrate.run_apply(client, migs, out=lines.append, allow_out_of_order=True)
    assert rc == 0
    assert any("WARNING" in ln and "out-of-order" in ln for ln in lines)
    assert [ins[1][0][0] for ins in client.inserts] == ["0002"]


def test_apply_gap_is_warning_not_error(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    _write(tmp_path, "0003_c.sql", "CREATE TABLE c")
    migs = migrate.discover_migrations(tmp_path)
    client = FakeClient(applied=["0001"])
    lines: list[str] = []
    rc = migrate.run_apply(client, migs, out=lines.append)
    assert rc == 0
    assert any("gap" in ln.lower() for ln in lines)
    assert [ins[1][0][0] for ins in client.inserts] == ["0003"]


def test_status_reports_out_of_order_as_warning(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    _write(tmp_path, "0003_c.sql", "CREATE TABLE c")
    _write(tmp_path, "0002_b.sql", "CREATE TABLE b")
    migs = migrate.discover_migrations(tmp_path)
    client = FakeClient(applied=["0001", "0003"])
    lines: list[str] = []
    rc = migrate.run_status(client, migs, out=lines.append)
    assert rc == 0
    assert any("WARNING" in ln and "out-of-order" in ln for ln in lines)
    assert client.commands == []


# --- validation (F5, F6) ---------------------------------------------------------


def test_validate_rejects_duplicate_version(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    _write(tmp_path, "0001_b.sql", "CREATE TABLE b")
    migs = migrate.discover_migrations(tmp_path)
    with pytest.raises(migrate.MigrationError) as ei:
        migrate.validate_migrations(migs)
    assert "0001" in str(ei.value)


def test_apply_refuses_duplicate_version(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    _write(tmp_path, "0001_b.sql", "CREATE TABLE b")
    migs = migrate.discover_migrations(tmp_path)
    client = FakeClient(ledger_exists=False)
    with pytest.raises(migrate.MigrationError):
        migrate.run_apply(client, migs, out=lambda _ln: None)
    assert client.commands == []


def test_validate_rejects_empty_and_comment_only(tmp_path: Path) -> None:
    _write(tmp_path, "0001_empty.sql", "   \n  \t")
    migs = migrate.discover_migrations(tmp_path)
    with pytest.raises(migrate.MigrationError):
        migrate.validate_migrations(migs)
    _write(tmp_path, "0001_empty.sql", "-- only a comment\n/* and a block */")
    migs = migrate.discover_migrations(tmp_path)
    with pytest.raises(migrate.MigrationError):
        migrate.validate_migrations(migs)


def test_assert_single_statement_accepts() -> None:
    migrate.assert_single_statement("SELECT 1")
    migrate.assert_single_statement("SELECT 1;")
    migrate.assert_single_statement("SELECT 'a;b'")
    migrate.assert_single_statement("SELECT 1 -- trailing;comment")
    migrate.assert_single_statement("SELECT 1 /* block;comment */")
    migrate.assert_single_statement("SELECT 'a\\';b'")
    migrate.assert_single_statement("SELECT 'a''b;c'")
    migrate.assert_single_statement("SELECT `col;name`")
    migrate.assert_single_statement('SELECT "col;name"')
    migrate.assert_single_statement('SELECT "a""b;c"')


def test_assert_single_statement_rejects() -> None:
    with pytest.raises(migrate.MigrationError):
        migrate.assert_single_statement("SELECT 1; SELECT 2")
    with pytest.raises(migrate.MigrationError):
        migrate.assert_single_statement("   ")
    with pytest.raises(migrate.MigrationError):
        migrate.assert_single_statement("-- only comment")


def test_assert_single_statement_handles_hash_comments() -> None:
    # ClickHouse # and #! line comments are stripped like --
    migrate.assert_single_statement("ALTER TABLE t DELETE WHERE 1 # note; more")
    migrate.assert_single_statement("SELECT 1 #! shebang; style")
    with pytest.raises(migrate.MigrationError):
        migrate.assert_single_statement("# just a hash comment")
    with pytest.raises(migrate.MigrationError):
        migrate.assert_single_statement("#! shebang only")


def test_discover_warns_on_non_matching_sql(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    _write(tmp_path, "0001_ok.sql", "SELECT 1")
    _write(tmp_path, "003_short.sql", "SELECT 1")
    _write(tmp_path, "00001_long.sql", "SELECT 1")
    _write(tmp_path, "0002_.sql", "SELECT 1")
    _write(tmp_path, "nope.sql", "SELECT 1")
    with caplog.at_level("WARNING", logger="clickhouse_migrations"):
        migs = migrate.discover_migrations(tmp_path)
    assert [m.version for m in migs] == ["0001"]
    warned = " ".join(r.message for r in caplog.records)
    for bad in ("003_short.sql", "00001_long.sql", "0002_.sql", "nope.sql"):
        assert bad in warned


def test_discover_skips_non_file_sql_entries(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "SELECT 1")
    (tmp_path / "0009_dir.sql").mkdir()
    assert [m.version for m in migrate.discover_migrations(tmp_path)] == ["0001"]


# --- checksum & drift (F2) -------------------------------------------------------


def test_compute_checksum_normalizes_line_endings_and_eof_newline() -> None:
    base = migrate.compute_checksum("CREATE TABLE a")
    # line endings and a trailing EOF newline (or several) are neutral
    assert base == migrate.compute_checksum("CREATE TABLE a\n")
    assert base == migrate.compute_checksum("CREATE TABLE a\n\n")
    assert base == migrate.compute_checksum("CREATE TABLE a\r\n")
    # trailing whitespace on a line is now content, as is a different statement
    assert base != migrate.compute_checksum("CREATE TABLE a   ")
    assert base != migrate.compute_checksum("CREATE TABLE b")


def test_compute_checksum_detects_interior_trailing_whitespace() -> None:
    # trailing spaces before an interior newline (e.g. inside a multi-line string
    # literal) are a real edit and MUST change the checksum; per-line rstrip hid this.
    clean = "INSERT INTO t VALUES ('line1\nline2')"
    spaced = "INSERT INTO t VALUES ('line1   \nline2')"
    assert migrate.compute_checksum(clean) != migrate.compute_checksum(spaced)


def test_drift_detects_interior_trailing_whitespace(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "INSERT INTO t VALUES ('a\nb')")
    migs = migrate.discover_migrations(tmp_path)
    stored = migrate.compute_checksum("INSERT INTO t VALUES ('a   \nb')")
    client = FakeClient(applied={"0001": stored})
    lines: list[str] = []
    rc = migrate.run_status(client, migs, out=lines.append)
    assert rc == 1
    assert any("DRIFT" in ln for ln in lines)


def test_apply_records_checksum(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    migs = migrate.discover_migrations(tmp_path)
    client = FakeClient(ledger_exists=False)
    rc = migrate.run_apply(client, migs, out=lambda _ln: None)
    assert rc == 0
    _table, data, cols = client.inserts[0]
    assert cols == ["version", "name", "checksum"]
    assert data[0][0] == "0001"
    assert data[0][2] == migrate.compute_checksum("CREATE TABLE a")


def test_apply_bootstrap_creates_then_alters(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    migs = migrate.discover_migrations(tmp_path)
    client = FakeClient(ledger_exists=False)
    migrate.run_apply(client, migs, out=lambda _ln: None)
    assert client.bootstrap == [
        migrate.CREATE_LEDGER_SQL,
        migrate.ALTER_LEDGER_ADD_CHECKSUM_SQL,
    ]
    assert client.alters == [migrate.ALTER_LEDGER_ADD_CHECKSUM_SQL]


def test_apply_refuses_on_drift(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    migs = migrate.discover_migrations(tmp_path)
    client = FakeClient(applied={"0001": migrate.compute_checksum("CREATE TABLE OLD")})
    lines: list[str] = []
    rc = migrate.run_apply(client, migs, out=lines.append)
    assert rc == 1
    assert any("changed after it was recorded" in ln for ln in lines)
    assert client.commands == []
    assert client.inserts == []


def test_status_reports_drift_rc1_and_is_read_only(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    migs = migrate.discover_migrations(tmp_path)
    client = FakeClient(applied={"0001": migrate.compute_checksum("CREATE TABLE OLD")})
    lines: list[str] = []
    rc = migrate.run_status(client, migs, out=lines.append)
    assert rc == 1
    assert any("DRIFT" in ln for ln in lines)
    assert client.commands == []
    assert client.alters == []


def test_no_drift_for_legacy_empty_checksum(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    migs = migrate.discover_migrations(tmp_path)
    client = FakeClient(applied={"0001": ""})
    lines: list[str] = []
    rc = migrate.run_status(client, migs, out=lines.append)
    assert rc == 0
    assert not any("DRIFT" in ln for ln in lines)


def test_status_does_not_backfill_checksum_on_legacy_ledger(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    migs = migrate.discover_migrations(tmp_path)
    client = FakeClient(applied=["0001"], has_checksum=False)
    lines: list[str] = []
    rc = migrate.run_status(client, migs, out=lines.append)
    assert rc == 0
    assert client.commands == []
    assert client.alters == []
    # a legacy ledger (no checksum column) reads back as version -> "" and is untouched
    assert migrate.read_ledger(FakeClient(applied=["0001"], has_checksum=False)) == {
        "0001": ""
    }


def test_status_warns_on_orphan_ledger_entry(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    migs = migrate.discover_migrations(tmp_path)
    client = FakeClient(applied={"0001": "", "0007": ""})  # 0007 has no file on disk
    lines: list[str] = []
    rc = migrate.run_status(client, migs, out=lines.append)
    assert any("0007" in ln and "no migration file" in ln for ln in lines)


def test_dry_run_escapes_single_quote_in_name(tmp_path: Path) -> None:
    _write(tmp_path, "0001_o'brien.sql", "SELECT 1")
    migs = migrate.discover_migrations(tmp_path)
    lines: list[str] = []
    migrate.run_dry_run(migs, out=lines.append)
    assert any("'o''brien'" in ln for ln in lines)


def test_apply_non_access_command_error_omits_hint(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    _write(tmp_path, "0002_bad.sql", "CREATE BROKEN")
    migs = migrate.discover_migrations(tmp_path)
    client = FakeClient(
        ledger_exists=False, fail_on="BROKEN", fail_exc=RuntimeError("syntax error")
    )
    lines: list[str] = []
    rc = migrate.run_apply(client, migs, out=lines.append)
    assert rc == 1
    assert any("ERROR applying 0002 bad" in ln for ln in lines)
    assert not any("DDL/admin credential" in ln for ln in lines)


def test_read_ledger_variants() -> None:
    assert migrate.read_ledger(FakeClient(ledger_exists=False)) == {}
    assert migrate.read_ledger(FakeClient(applied={"0001": "abc"})) == {"0001": "abc"}
    legacy = FakeClient(applied=["0001", "0002"], has_checksum=False)
    assert migrate.read_ledger(legacy) == {"0001": "", "0002": ""}


def test_applied_versions_wraps_read_ledger() -> None:
    client = FakeClient(applied={"0001": "x", "0002": "y"})
    assert migrate.applied_versions(client) == {"0001", "0002"}


def test_detect_drift_skips_legacy_and_missing_file(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    migs = migrate.discover_migrations(tmp_path)
    ledger = {"0001": "", "0009": "recorded-but-no-file"}
    assert migrate.detect_drift(migs, ledger) == []


# --- partial failure (F3) --------------------------------------------------------


def test_apply_insert_failure_is_critical_and_stops(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    _write(tmp_path, "0002_b.sql", "CREATE TABLE b")
    migs = migrate.discover_migrations(tmp_path)
    client = FakeClient(
        ledger_exists=False, insert_exc=RuntimeError("ledger write failed")
    )
    lines: list[str] = []
    rc = migrate.run_apply(client, migs, out=lines.append)
    assert rc == 1
    assert any(ln.startswith("CRITICAL") and "0001" in ln for ln in lines)
    assert any("idempotent" in ln for ln in lines)
    assert "CREATE TABLE b" not in client.commands


# --- no-pending branches ---------------------------------------------------------


def test_apply_no_pending(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    migs = migrate.discover_migrations(tmp_path)
    client = FakeClient(applied={"0001": migrate.compute_checksum("CREATE TABLE a")})
    lines: list[str] = []
    rc = migrate.run_apply(client, migs, out=lines.append)
    assert rc == 0
    assert any("No pending migrations" in ln for ln in lines)
    assert client.inserts == []


def test_status_no_pending(tmp_path: Path) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    migs = migrate.discover_migrations(tmp_path)
    client = FakeClient(applied={"0001": migrate.compute_checksum("CREATE TABLE a")})
    lines: list[str] = []
    rc = migrate.run_status(client, migs, out=lines.append)
    assert rc == 0
    assert any("Pending migrations: none" in ln for ln in lines)


# --- dry-run hardening (F7) ------------------------------------------------------


def test_dry_run_multi_statement_clean_nonzero(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _write(tmp_path, "0001_a.sql", "SELECT 1; SELECT 2")
    connects: list[int] = []
    monkeypatch.setattr(migrate, "connect", lambda: connects.append(1))
    rc = migrate.main(["apply", "--dry-run", "--migrations-dir", str(tmp_path)])
    assert rc == 1
    assert connects == []  # dry-run must never open a connection
    err = capsys.readouterr().err
    assert "ERROR" in err
    assert "Traceback" not in err


def test_dry_run_non_utf8_clean_nonzero(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    (tmp_path / "0001_a.sql").write_bytes(b"\xff\xfe not utf-8")
    connects: list[int] = []
    monkeypatch.setattr(migrate, "connect", lambda: connects.append(1))
    rc = migrate.main(["apply", "--dry-run", "--migrations-dir", str(tmp_path)])
    assert rc == 1
    assert connects == []
    assert "Traceback" not in capsys.readouterr().err


@pytest.mark.skipif(
    hasattr(__import__("os"), "geteuid") and __import__("os").geteuid() == 0,
    reason="root bypasses file permission bits",
)
def test_dry_run_unreadable_clean_nonzero(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    p = tmp_path / "0001_a.sql"
    p.write_text("SELECT 1", encoding="utf-8")
    p.chmod(0o000)
    connects: list[int] = []
    monkeypatch.setattr(migrate, "connect", lambda: connects.append(1))
    try:
        rc = migrate.main(["apply", "--dry-run", "--migrations-dir", str(tmp_path)])
    finally:
        p.chmod(0o644)
    assert rc == 1
    assert connects == []
    assert "Traceback" not in capsys.readouterr().err


# --- CLI plumbing (main, build_parser, connect, env) -----------------------------


def test_build_parser_apply_flags() -> None:
    parser = migrate.build_parser()
    args = parser.parse_args(["apply", "--dry-run", "--allow-out-of-order"])
    assert args.command == "apply"
    assert args.dry_run is True
    assert args.allow_out_of_order is True
    assert parser.parse_args(["status"]).command == "status"


def test_resolve_migrations_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    path, explicit = migrate.resolve_migrations_dir(str(tmp_path))
    assert explicit and path == tmp_path
    monkeypatch.setenv("CH_MIGRATIONS_DIR", str(tmp_path))
    path, explicit = migrate.resolve_migrations_dir(None)
    assert explicit and path == tmp_path
    monkeypatch.delenv("CH_MIGRATIONS_DIR", raising=False)
    path, explicit = migrate.resolve_migrations_dir(None)
    assert not explicit and path.name == "migrations"


def test_main_status_dispatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    fake = FakeClient(ledger_exists=False)
    monkeypatch.setattr(migrate, "connect", lambda: fake)
    rc = migrate.main(["status", "--migrations-dir", str(tmp_path)])
    assert rc == 0
    assert fake.commands == []


def test_main_apply_dispatch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")
    fake = FakeClient(ledger_exists=False)
    monkeypatch.setattr(migrate, "connect", lambda: fake)
    rc = migrate.main(["apply", "--migrations-dir", str(tmp_path)])
    assert rc == 0
    assert fake.alters == [migrate.ALTER_LEDGER_ADD_CHECKSUM_SQL]


def test_main_missing_explicit_dir_returns_2(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    rc = migrate.main(["status", "--migrations-dir", str(tmp_path / "nope")])
    assert rc == 2
    assert "ERROR" in capsys.readouterr().err


def test_main_apply_dry_run_never_connects(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")

    def boom() -> Any:
        raise AssertionError("connect() must not be called for --dry-run")

    monkeypatch.setattr(migrate, "connect", boom)
    rc = migrate.main(["apply", "--dry-run", "--migrations-dir", str(tmp_path)])
    assert rc == 0
    assert "DRY RUN" in capsys.readouterr().out


def test_main_non_access_error_prints_no_hint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")

    def boom() -> Any:
        raise RuntimeError("network down")

    monkeypatch.setattr(migrate, "connect", boom)
    rc = migrate.main(["status", "--migrations-dir", str(tmp_path)])
    assert rc == 1
    err = capsys.readouterr().err
    assert "network down" in err
    assert "DDL/admin credential" not in err


def test_main_access_error_prints_hint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _write(tmp_path, "0001_a.sql", "CREATE TABLE a")

    def boom() -> Any:
        raise RuntimeError("Code: 497. DB::Exception: ACCESS_DENIED")

    monkeypatch.setattr(migrate, "connect", boom)
    rc = migrate.main(["apply", "--migrations-dir", str(tmp_path)])
    assert rc == 1
    assert "DDL/admin credential" in capsys.readouterr().err


def test_is_access_error_variants() -> None:
    assert migrate._is_access_error(RuntimeError("Code: 497. ACCESS_DENIED"))
    assert migrate._is_access_error(RuntimeError("Code: 516 something"))
    assert migrate._is_access_error(RuntimeError("AUTHENTICATION failed"))

    class Coded(Exception):
        code = 497

    assert migrate._is_access_error(Coded())
    assert not migrate._is_access_error(RuntimeError("Code: 500 server error"))
    assert not migrate._is_access_error(RuntimeError("plain failure"))


def test_env_and_host_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CLICKHOUSE_USERNAME", raising=False)
    with pytest.raises(SystemExit):
        migrate._env("CLICKHOUSE_USERNAME")
    monkeypatch.delenv("CLICKHOUSE_HOST", raising=False)
    monkeypatch.delenv("CLICKHOUSE_ENDPOINT", raising=False)
    with pytest.raises(SystemExit):
        migrate._host_from_env()
    monkeypatch.setenv("CLICKHOUSE_ENDPOINT", "https://endpoint.example:8443")
    assert migrate._host_from_env() == "endpoint.example"
    monkeypatch.setenv("CLICKHOUSE_HOST", "https://host.clickhouse.cloud:8443")
    assert migrate._host_from_env() == "host.clickhouse.cloud"


def test_connect_kwargs_and_proxy_bypass(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CLICKHOUSE_HOST", "https://abc.clickhouse.cloud:8443")
    monkeypatch.setenv("CLICKHOUSE_USERNAME", "user")
    monkeypatch.setenv("CLICKHOUSE_PASSWORD", "pass")
    monkeypatch.setenv("CLICKHOUSE_PORT", "9440")
    monkeypatch.setenv("NO_PROXY", "localhost")
    monkeypatch.delenv("no_proxy", raising=False)
    captured: dict[str, Any] = {}

    class FakeCH:
        @staticmethod
        def get_client(**kwargs: Any) -> str:
            captured.update(kwargs)
            return "CLIENT"

    monkeypatch.setitem(sys.modules, "clickhouse_connect", FakeCH)
    client = migrate.connect()
    assert client == "CLIENT"
    assert captured["host"] == "abc.clickhouse.cloud"
    assert captured["port"] == 9440
    assert captured["secure"] is True
    assert captured["interface"] == "https"
    assert captured["username"] == "user"
    assert captured["password"] == "pass"
    import os

    assert ".clickhouse.cloud" in os.environ["NO_PROXY"].split(",")


def test_connect_invalid_port_raises_systemexit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CLICKHOUSE_HOST", "host")
    monkeypatch.setenv("CLICKHOUSE_USERNAME", "user")
    monkeypatch.setenv("CLICKHOUSE_PASSWORD", "pass")
    monkeypatch.setenv("CLICKHOUSE_PORT", "not-an-int")
    with pytest.raises(SystemExit):
        migrate.connect()
