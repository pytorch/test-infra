from __future__ import annotations

import os
import sys
from typing import TYPE_CHECKING, cast

import pytest

from greenlight import clickhouse_client

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from clickhouse_connect.driver.client import Client


@pytest.fixture(autouse=True)
def _clean_clickhouse_env(monkeypatch):
    """Isolate connect() from any real CLICKHOUSE_*/NO_PROXY in the environment."""
    for key in list(os.environ):
        if key.startswith("CLICKHOUSE_") or key in ("NO_PROXY", "no_proxy"):
            monkeypatch.delenv(key, raising=False)


class _FakeResult:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self._rows = rows

    def named_results(self) -> Iterator[dict[str, object]]:
        return iter(self._rows)


class _FakeCHClient:
    """Stand-in for the clickhouse_connect client returned by get_client (read path)."""

    def __init__(self, rows: list[dict[str, object]] | None = None, error: Exception | None = None) -> None:
        self.rows = rows or []
        self.error = error
        self.queries: list[tuple[str, dict[str, object] | None, dict[str, object] | None]] = []
        self.closed = 0

    def query(
        self, sql: str, parameters: dict[str, object] | None = None, settings: dict[str, object] | None = None
    ) -> _FakeResult:
        self.queries.append((sql, parameters, settings))
        if self.error is not None:
            raise self.error
        return _FakeResult(self.rows)

    def close(self) -> None:
        self.closed += 1


class _FakeCHModule:
    """Stand-in for the lazily imported clickhouse_connect module."""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []
        self.client = _FakeCHClient()

    def get_client(self, **kwargs):
        self.calls.append(kwargs)
        return self.client


@pytest.fixture
def fake_clickhouse(monkeypatch):
    fake = _FakeCHModule()
    monkeypatch.setitem(sys.modules, "clickhouse_connect", fake)
    return fake


def test_connect_passes_expected_client_kwargs(fake_clickhouse, monkeypatch):
    monkeypatch.setenv("CLICKHOUSE_HOST", "host.clickhouse.cloud")
    monkeypatch.setenv("CLICKHOUSE_USERNAME", "user")
    monkeypatch.setenv("CLICKHOUSE_PASSWORD", "pass")

    result = clickhouse_client.connect()

    assert result is fake_clickhouse.client
    assert fake_clickhouse.calls == [
        {
            "host": "host.clickhouse.cloud",
            "username": "user",
            "password": "pass",
            "port": 8443,
            "secure": True,
            "interface": "https",
            "connect_timeout": 10,
            "send_receive_timeout": 60,
        }
    ]


def test_connect_takes_a_send_receive_timeout(fake_clickhouse, monkeypatch):
    monkeypatch.setenv("CLICKHOUSE_HOST", "host.clickhouse.cloud")
    monkeypatch.setenv("CLICKHOUSE_USERNAME", "user")
    monkeypatch.setenv("CLICKHOUSE_PASSWORD", "pass")

    clickhouse_client.connect(send_receive_timeout=15)

    assert fake_clickhouse.calls[0]["send_receive_timeout"] == 15
    assert fake_clickhouse.calls[0]["connect_timeout"] == 10


def test_connect_strips_scheme_and_default_port_suffix(fake_clickhouse, monkeypatch):
    monkeypatch.setenv("CLICKHOUSE_HOST", "https://host.clickhouse.cloud:8443")
    monkeypatch.setenv("CLICKHOUSE_USERNAME", "user")
    monkeypatch.setenv("CLICKHOUSE_PASSWORD", "pass")

    clickhouse_client.connect()

    assert fake_clickhouse.calls[0]["host"] == "host.clickhouse.cloud"


def test_connect_uses_endpoint_alias_when_host_absent(fake_clickhouse, monkeypatch):
    monkeypatch.setenv("CLICKHOUSE_ENDPOINT", "alias.clickhouse.cloud")
    monkeypatch.setenv("CLICKHOUSE_USERNAME", "user")
    monkeypatch.setenv("CLICKHOUSE_PASSWORD", "pass")

    clickhouse_client.connect()

    assert fake_clickhouse.calls[0]["host"] == "alias.clickhouse.cloud"


def test_connect_honours_custom_port(fake_clickhouse, monkeypatch):
    monkeypatch.setenv("CLICKHOUSE_HOST", "host.clickhouse.cloud")
    monkeypatch.setenv("CLICKHOUSE_USERNAME", "user")
    monkeypatch.setenv("CLICKHOUSE_PASSWORD", "pass")
    monkeypatch.setenv("CLICKHOUSE_PORT", "9440")

    clickhouse_client.connect()

    assert fake_clickhouse.calls[0]["port"] == 9440


def test_connect_adds_clickhouse_cloud_to_empty_no_proxy(fake_clickhouse, monkeypatch):
    monkeypatch.setenv("CLICKHOUSE_HOST", "host.clickhouse.cloud")
    monkeypatch.setenv("CLICKHOUSE_USERNAME", "user")
    monkeypatch.setenv("CLICKHOUSE_PASSWORD", "pass")

    clickhouse_client.connect()

    assert os.environ["NO_PROXY"] == ".clickhouse.cloud"
    assert os.environ["no_proxy"] == ".clickhouse.cloud"


def test_connect_appends_without_duplicating_no_proxy(fake_clickhouse, monkeypatch):
    monkeypatch.setenv("CLICKHOUSE_HOST", "host.clickhouse.cloud")
    monkeypatch.setenv("CLICKHOUSE_USERNAME", "user")
    monkeypatch.setenv("CLICKHOUSE_PASSWORD", "pass")
    monkeypatch.setenv("NO_PROXY", "example.com")
    monkeypatch.setenv("no_proxy", ".clickhouse.cloud,example.com")

    clickhouse_client.connect()

    assert os.environ["NO_PROXY"] == "example.com,.clickhouse.cloud"
    # Already present: not appended a second time.
    assert os.environ["no_proxy"] == ".clickhouse.cloud,example.com"


def test_connect_missing_host_raises(fake_clickhouse, monkeypatch):
    monkeypatch.setenv("CLICKHOUSE_USERNAME", "user")
    monkeypatch.setenv("CLICKHOUSE_PASSWORD", "pass")

    with pytest.raises(ValueError, match="CLICKHOUSE_HOST"):
        clickhouse_client.connect()


def test_connect_missing_username_raises(fake_clickhouse, monkeypatch):
    monkeypatch.setenv("CLICKHOUSE_HOST", "host.clickhouse.cloud")
    monkeypatch.setenv("CLICKHOUSE_PASSWORD", "pass")

    with pytest.raises(ValueError, match="CLICKHOUSE_USERNAME"):
        clickhouse_client.connect()


def test_connect_missing_password_raises(fake_clickhouse, monkeypatch):
    monkeypatch.setenv("CLICKHOUSE_HOST", "host.clickhouse.cloud")
    monkeypatch.setenv("CLICKHOUSE_USERNAME", "user")

    with pytest.raises(ValueError, match="CLICKHOUSE_PASSWORD"):
        clickhouse_client.connect()


def test_connect_bad_port_raises(fake_clickhouse, monkeypatch):
    monkeypatch.setenv("CLICKHOUSE_HOST", "host.clickhouse.cloud")
    monkeypatch.setenv("CLICKHOUSE_USERNAME", "user")
    monkeypatch.setenv("CLICKHOUSE_PASSWORD", "pass")
    monkeypatch.setenv("CLICKHOUSE_PORT", "not-an-int")

    with pytest.raises(ValueError, match="CLICKHOUSE_PORT"):
        clickhouse_client.connect()


def _connect_to(client: _FakeCHClient) -> Callable[[], Client]:
    return lambda: cast("Client", client)


def test_query_returns_the_rows_by_column_name_and_closes_the_connection():
    client = _FakeCHClient(rows=[{"a": 1}, {"a": 2}])

    rows = clickhouse_client.query("SELECT a FROM t WHERE b = %(b)s", {"b": 3}, connect=_connect_to(client))

    assert rows == [{"a": 1}, {"a": 2}]
    assert client.queries == [("SELECT a FROM t WHERE b = %(b)s", {"b": 3}, None)]
    assert client.closed == 1


def test_query_forwards_its_settings():
    client = _FakeCHClient()

    clickhouse_client.query("SELECT 1", {}, connect=_connect_to(client), settings={"max_execution_time": 10})

    assert client.queries == [("SELECT 1", {}, {"max_execution_time": 10})]


def test_query_error_propagates_and_closes_the_connection():
    client = _FakeCHClient(error=RuntimeError("query boom"))

    with pytest.raises(RuntimeError, match="query boom"):
        clickhouse_client.query("SELECT 1", {}, connect=_connect_to(client))

    assert client.closed == 1


def test_query_connects_with_connect_by_default(fake_clickhouse, monkeypatch):
    monkeypatch.setenv("CLICKHOUSE_HOST", "host.clickhouse.cloud")
    monkeypatch.setenv("CLICKHOUSE_USERNAME", "user")
    monkeypatch.setenv("CLICKHOUSE_PASSWORD", "pass")
    fake_clickhouse.client.rows = [{"a": 1}]

    assert clickhouse_client.query("SELECT 1 AS a", {}) == [{"a": 1}]
    assert fake_clickhouse.calls[0]["send_receive_timeout"] == 60
    assert fake_clickhouse.client.closed == 1
