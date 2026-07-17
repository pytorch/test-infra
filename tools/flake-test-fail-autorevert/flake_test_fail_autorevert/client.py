import logging
import os
import socket
import time
from typing import Any, Dict, List, Optional, Tuple

import clickhouse_connect
from clickhouse_connect.driver import Client
from clickhouse_connect.driver.exceptions import InterfaceError, OperationalError

from .logic import endpoint_from_env

logger = logging.getLogger(__name__)

RETRYABLE = (OperationalError, InterfaceError, socket.gaierror, OSError)

MAX_ATTEMPTS = 5
BASE_DELAY_SECONDS = 1.0


def _require_env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        raise SystemExit(
            f"Missing required environment variable {name}. "
            f"Set CLICKHOUSE_HOST, CLICKHOUSE_USERNAME, CLICKHOUSE_PASSWORD "
            f"(and optionally CLICKHOUSE_PORT, default 8443), or put them in a .env file."
        )
    return val


def _port_from_env() -> int:
    raw = os.environ.get("CLICKHOUSE_PORT") or "8443"
    try:
        return int(raw)
    except ValueError:
        raise SystemExit(
            f"Invalid CLICKHOUSE_PORT '{raw}': must be an integer (default 8443)."
        ) from None


def get_clickhouse_client() -> Client:
    host = endpoint_from_env(_require_env("CLICKHOUSE_HOST"))
    return clickhouse_connect.get_client(
        host=host,
        user=_require_env("CLICKHOUSE_USERNAME"),
        password=_require_env("CLICKHOUSE_PASSWORD"),
        secure=True,
        interface="https",
        port=_port_from_env(),
    )


def run_query(
    client: Client,
    query: str,
    parameters: Optional[Dict[str, Any]] = None,
) -> List[Tuple[Any, ...]]:
    last_exc: Optional[Exception] = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return client.query(query, parameters=parameters or {}).result_rows
        except RETRYABLE as exc:
            last_exc = exc
            if attempt == MAX_ATTEMPTS:
                break
            delay = BASE_DELAY_SECONDS * (2 ** (attempt - 1))
            logger.warning(
                "ClickHouse query failed (attempt %d/%d), retrying in %.0fs: %s: %s",
                attempt,
                MAX_ATTEMPTS,
                delay,
                type(exc).__name__,
                exc,
            )
            time.sleep(delay)
    raise last_exc  # type: ignore[misc]
