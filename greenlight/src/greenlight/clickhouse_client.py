"""ClickHouse access for the greenlight service: connection and verdict-row insert.

Connection settings come from the standard ``CLICKHOUSE_*`` environment variables.
Verdict rows are written to ``misc.greenlight_pr_state``; its ``_inserted_at`` column is
MATERIALIZED server-side and is therefore never part of an insert.
"""

from __future__ import annotations

import logging
import os
from dataclasses import astuple, dataclass, fields
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from collections.abc import Sequence
    from datetime import datetime

logger = logging.getLogger(__name__)

TABLE = "misc.greenlight_pr_state"

_DEFAULT_PORT = 8443
_CLICKHOUSE_CLOUD_DOMAIN = ".clickhouse.cloud"
_ENV_HELP = (
    "Set CLICKHOUSE_HOST (or its alias CLICKHOUSE_ENDPOINT), CLICKHOUSE_USERNAME, "
    "CLICKHOUSE_PASSWORD (and optionally CLICKHOUSE_PORT, default 8443)."
)


class ClickHouseClient(Protocol):
    def insert(
        self,
        table: str,
        data: Sequence[Sequence[object]],
        *,
        column_names: Sequence[str],
    ) -> object: ...


@dataclass(frozen=True, slots=True)
class VerdictRow:
    repo: str
    pr_number: int
    head_sha: str
    status: str
    reason: str
    eval_hash: str
    message: str
    eval_job: str
    agent_job: str
    version: datetime


INSERT_COLUMNS: tuple[str, ...] = tuple(f.name for f in fields(VerdictRow))


def insert_verdict_row(client: ClickHouseClient, row: VerdictRow) -> None:
    client.insert(TABLE, [list(astuple(row))], column_names=list(INSERT_COLUMNS))


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


def connect() -> ClickHouseClient:
    host = _host_from_env()
    username = _require_env("CLICKHOUSE_USERNAME")
    password = _require_env("CLICKHOUSE_PASSWORD")
    port = _port_from_env()
    _ensure_clickhouse_cloud_no_proxy()
    import clickhouse_connect  # lazy: keeps this module importable without the dep

    client: ClickHouseClient = clickhouse_connect.get_client(
        host=host,
        username=username,
        password=password,
        port=port,
        secure=True,
        interface="https",
    )
    return client
