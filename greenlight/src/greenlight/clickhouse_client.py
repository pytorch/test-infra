"""ClickHouse connection helper for the greenlight service.

Connection settings come from the standard ``CLICKHOUSE_*`` environment variables. The
returned client is used for the service's read (SELECT) queries, run through ``query``; verdict
writes go through the S3 -> replicator path (see ``verdict``), not a direct INSERT from here.
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable

    from clickhouse_connect.driver.client import Client

logger = logging.getLogger(__name__)

_DEFAULT_PORT = 8443
# clickhouse_connect waits 300 s for a response by default, the scan Lambda's whole function timeout.
_CONNECT_TIMEOUT_SECONDS = 10
_SEND_RECEIVE_TIMEOUT_SECONDS = 60
_CLICKHOUSE_CLOUD_DOMAIN = ".clickhouse.cloud"
_ENV_HELP = (
    "Set CLICKHOUSE_HOST (or its alias CLICKHOUSE_ENDPOINT), CLICKHOUSE_USERNAME, "
    "CLICKHOUSE_PASSWORD (and optionally CLICKHOUSE_PORT, default 8443)."
)


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise ValueError(f"{name} is required to connect to ClickHouse. {_ENV_HELP}")
    return value


def _host_from_env() -> str:
    raw = os.environ.get("CLICKHOUSE_HOST") or os.environ.get("CLICKHOUSE_ENDPOINT")
    if not raw:
        raise ValueError(f"CLICKHOUSE_HOST is required to connect to ClickHouse. {_ENV_HELP}")
    return raw.removeprefix("https://").removesuffix(":8443")


def _port_from_env() -> int:
    raw = os.environ.get("CLICKHOUSE_PORT")
    if not raw:
        return _DEFAULT_PORT
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"CLICKHOUSE_PORT must be an integer, got {raw!r}") from exc


def _ensure_clickhouse_cloud_no_proxy() -> None:
    # clickhouse_connect's TLS to *.clickhouse.cloud fails through a corporate proxy;
    # excluding the domain from NO_PROXY/no_proxy routes it directly.
    for var in ("NO_PROXY", "no_proxy"):
        entries = [e.strip() for e in os.environ.get(var, "").split(",") if e.strip()]
        if _CLICKHOUSE_CLOUD_DOMAIN not in entries:
            os.environ[var] = ",".join([*entries, _CLICKHOUSE_CLOUD_DOMAIN])


def connect(*, send_receive_timeout: int = _SEND_RECEIVE_TIMEOUT_SECONDS) -> Client:
    host = _host_from_env()
    username = _require_env("CLICKHOUSE_USERNAME")
    password = _require_env("CLICKHOUSE_PASSWORD")
    port = _port_from_env()
    _ensure_clickhouse_cloud_no_proxy()
    import clickhouse_connect  # lazy: keeps this module importable without the dep

    client: Client = clickhouse_connect.get_client(
        host=host,
        username=username,
        password=password,
        port=port,
        secure=True,
        interface="https",
        connect_timeout=_CONNECT_TIMEOUT_SECONDS,
        send_receive_timeout=send_receive_timeout,
    )
    return client


def query(
    sql: str,
    params: dict[str, object],
    *,
    connect: Callable[[], Client] = connect,
    settings: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Run ``sql`` with ``params`` on a client from ``connect`` and return its rows by column name.

    ``settings`` are ClickHouse settings for this query alone. Query and connection errors propagate;
    the connection is always closed.
    """
    client = connect()
    try:
        return list(client.query(sql, parameters=params, settings=settings).named_results())
    finally:
        client.close()
