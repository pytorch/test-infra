import os
import sys

import pytest

from greenlight import clickhouse_client


@pytest.fixture(autouse=True)
def _clean_clickhouse_env(monkeypatch):
    """Isolate connect() from any real CLICKHOUSE_*/NO_PROXY in the environment."""
    for key in list(os.environ):
        if key.startswith("CLICKHOUSE_") or key in ("NO_PROXY", "no_proxy"):
            monkeypatch.delenv(key, raising=False)


class _FakeCHClient:
    """Stand-in for the clickhouse_connect client returned by get_client (read path)."""


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
        }
    ]


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
