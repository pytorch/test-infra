from typing import Any, Dict, List, Optional, Tuple

import pytest
from clickhouse_connect.driver.exceptions import (  # type: ignore[import-not-found]
    DatabaseError,
    DataError,
    ProgrammingError,
)
from flake_test_fail_autorevert.client import (
    _clickhouse_error_code,
    _should_fast_fail,
    MAX_ATTEMPTS,
    NON_RETRYABLE,
    NON_RETRYABLE_CH_ERROR_CODES,
    RETRYABLE,
    run_query,
)


# The HTTP driver embeds the ClickHouse numeric code in the message; these mirror the
# real driver strings so the tests exercise the actual classification path.
SYNTAX_ERR = DatabaseError(
    "HTTPDriver for https://x received ClickHouse error code 62\n"
    " Code: 62. DB::Exception: Syntax error (SYNTAX_ERROR)"
)
UNKNOWN_TABLE_ERR = DatabaseError(
    "HTTPDriver for https://x received ClickHouse error code 60\n"
    " Code: 60. DB::Exception: Unknown table (UNKNOWN_TABLE)"
)
MEMORY_LIMIT_ERR = DatabaseError(
    "HTTPDriver for https://x received ClickHouse error code 241\n"
    " Code: 241. DB::Exception: Memory limit exceeded (MEMORY_LIMIT_EXCEEDED)"
)
NO_CODE_ERR = DatabaseError("The ClickHouse server returned an error.")


class _Result:
    def __init__(self, rows: List[Tuple[Any, ...]]) -> None:
        self.result_rows = rows


class _FlakyThenOk:
    """Raises `exc` on the first `fail_times` calls, then returns rows."""

    def __init__(self, exc: Exception, fail_times: int, rows: List[Tuple[Any, ...]]):
        self.exc = exc
        self.remaining = fail_times
        self.rows = rows
        self.calls = 0

    def query(self, query: str, parameters: Optional[Dict[str, Any]] = None) -> _Result:
        self.calls += 1
        if self.remaining > 0:
            self.remaining -= 1
            raise self.exc
        return _Result(self.rows)


class _AlwaysRaise:
    def __init__(self, exc: Exception):
        self.exc = exc
        self.calls = 0

    def query(self, query: str, parameters: Optional[Dict[str, Any]] = None) -> _Result:
        self.calls += 1
        raise self.exc


# --- error-code parsing / classification (pure) ---


def test_parse_code_from_code_prefix():
    assert _clickhouse_error_code(SYNTAX_ERR) == 62


def test_parse_code_from_error_code_phrase():
    exc = DatabaseError("received ClickHouse error code 241")
    assert _clickhouse_error_code(exc) == 241


def test_parse_code_absent_returns_none():
    assert _clickhouse_error_code(NO_CODE_ERR) is None


def test_fast_fail_on_query_bug_code():
    assert _should_fast_fail(SYNTAX_ERR) is True
    assert _should_fast_fail(UNKNOWN_TABLE_ERR) is True


def test_no_fast_fail_on_transient_code():
    # MEMORY_LIMIT_EXCEEDED (241) is transient on the shared cluster => retry.
    assert _should_fast_fail(MEMORY_LIMIT_ERR) is False


def test_no_fast_fail_when_code_absent():
    # Unknown/absent code defaults to retryable (safe for transient transport faults).
    assert _should_fast_fail(NO_CODE_ERR) is False


def test_fast_fail_on_client_side_subclasses():
    assert _should_fast_fail(ProgrammingError("concurrent session")) is True
    assert _should_fast_fail(DataError("bad column data")) is True


# --- run_query retry / fast-fail behavior ---


def test_run_query_retries_on_transient_database_error(monkeypatch):
    # A bare DatabaseError carrying MEMORY_LIMIT_EXCEEDED must be retried, not aborted.
    monkeypatch.setattr("flake_test_fail_autorevert.client.time.sleep", lambda s: None)
    client = _FlakyThenOk(MEMORY_LIMIT_ERR, 1, [(1,)])
    rows = run_query(client, "SELECT 1")
    assert rows == [(1,)]
    assert client.calls == 2  # failed once, retried once, succeeded


def test_run_query_fast_fails_on_syntax_error(monkeypatch):
    # The real driver raises a BARE DatabaseError (code 62) for malformed SQL; it must
    # fail on the FIRST attempt, not retry MAX_ATTEMPTS times.
    monkeypatch.setattr("flake_test_fail_autorevert.client.time.sleep", lambda s: None)
    client = _AlwaysRaise(SYNTAX_ERR)
    with pytest.raises(DatabaseError):
        run_query(client, "SELECT bad FROMM t")
    assert client.calls == 1  # fast fail, no retries


def test_run_query_fast_fails_on_unknown_table(monkeypatch):
    monkeypatch.setattr("flake_test_fail_autorevert.client.time.sleep", lambda s: None)
    client = _AlwaysRaise(UNKNOWN_TABLE_ERR)
    with pytest.raises(DatabaseError):
        run_query(client, "SELECT * FROM nope")
    assert client.calls == 1


def test_run_query_fast_fails_on_programming_error(monkeypatch):
    monkeypatch.setattr("flake_test_fail_autorevert.client.time.sleep", lambda s: None)
    client = _AlwaysRaise(ProgrammingError("concurrent session"))
    with pytest.raises(ProgrammingError):
        run_query(client, "SELECT 1")
    assert client.calls == 1


def test_run_query_fast_fails_on_data_error(monkeypatch):
    monkeypatch.setattr("flake_test_fail_autorevert.client.time.sleep", lambda s: None)
    client = _AlwaysRaise(DataError("bad parameter value"))
    with pytest.raises(DataError):
        run_query(client, "SELECT 1")
    assert client.calls == 1


def test_run_query_exhausts_retries_then_raises(monkeypatch):
    monkeypatch.setattr("flake_test_fail_autorevert.client.time.sleep", lambda s: None)
    client = _AlwaysRaise(MEMORY_LIMIT_ERR)
    with pytest.raises(DatabaseError):
        run_query(client, "SELECT 1")
    assert client.calls == MAX_ATTEMPTS


def test_database_error_is_retryable_and_subclasses_excluded():
    assert DatabaseError in RETRYABLE
    assert ProgrammingError in NON_RETRYABLE
    assert DataError in NON_RETRYABLE
    assert 62 in NON_RETRYABLE_CH_ERROR_CODES  # SYNTAX_ERROR
    assert 241 not in NON_RETRYABLE_CH_ERROR_CODES  # MEMORY_LIMIT_EXCEEDED
