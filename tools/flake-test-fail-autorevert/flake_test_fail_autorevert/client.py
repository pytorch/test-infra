import logging
import os
import re
import socket
import time
from typing import Any, Dict, List, Optional, Tuple

import clickhouse_connect
from clickhouse_connect.driver import Client
from clickhouse_connect.driver.exceptions import (
    DatabaseError,
    DataError,
    InterfaceError,
    ProgrammingError,
)

from .logic import endpoint_from_env

logger = logging.getLogger(__name__)

# DatabaseError is the parent clickhouse_connect raises for the first server-side
# error, including transient MEMORY_LIMIT_EXCEEDED on the shared cluster; it subsumes
# OperationalError. InterfaceError (connection/transport layer) is a sibling of
# DatabaseError, not a subclass, so it is listed explicitly.
RETRYABLE = (DatabaseError, InterfaceError, socket.gaierror, OSError)

# ProgrammingError and DataError are DatabaseError subclasses clickhouse_connect raises
# for CLIENT-side bugs (concurrent session misuse, data serialization). They are caught
# by RETRYABLE above but signal a bug, not a transient fault, so they fail fast.
NON_RETRYABLE = (ProgrammingError, DataError)

# The HTTP driver raises a BARE DatabaseError for every SERVER-side query error (a
# malformed SQL surfaces as DatabaseError, not ProgrammingError), embedding the
# ClickHouse numeric code in the message as "Code: NN.". These codes are deterministic
# query bugs (or auth failures) that will never succeed on retry, so a DatabaseError
# carrying one fails fast. Any unrecognized code defaults to RETRYABLE (safe for
# transient faults like MEMORY_LIMIT_EXCEEDED=241 / TIMEOUT_EXCEEDED=159). Ints are from
# ClickHouse src/Common/ErrorCodes.cpp.
NON_RETRYABLE_CH_ERROR_CODES = frozenset(
    {
        1,    # UNSUPPORTED_METHOD
        8,    # THERE_IS_NO_COLUMN
        10,   # NOT_FOUND_COLUMN_IN_BLOCK
        16,   # NO_SUCH_COLUMN_IN_TABLE
        36,   # BAD_ARGUMENTS
        42,   # NUMBER_OF_ARGUMENTS_DOESNT_MATCH
        43,   # ILLEGAL_TYPE_OF_ARGUMENT
        44,   # ILLEGAL_COLUMN
        46,   # UNKNOWN_FUNCTION
        47,   # UNKNOWN_IDENTIFIER
        50,   # UNKNOWN_TYPE
        53,   # TYPE_MISMATCH
        59,   # ILLEGAL_TYPE_OF_COLUMN_FOR_FILTER
        60,   # UNKNOWN_TABLE
        62,   # SYNTAX_ERROR
        63,   # UNKNOWN_AGGREGATE_FUNCTION
        70,   # CANNOT_CONVERT_TYPE
        81,   # UNKNOWN_DATABASE
        115,  # UNKNOWN_SETTING
        162,  # TOO_DEEP_SUBQUERIES
        184,  # ILLEGAL_AGGREGATION
        215,  # NOT_AN_AGGREGATE
        386,  # NO_COMMON_TYPE
        497,  # ACCESS_DENIED
        516,  # AUTHENTICATION_FAILED
    }
)

_CH_CODE_RE = re.compile(r"Code:\s*(\d+)")

MAX_ATTEMPTS = 5
BASE_DELAY_SECONDS = 1.0


def _clickhouse_error_code(exc: BaseException) -> Optional[int]:
    """Parse the ClickHouse numeric error code from a driver exception message.
    The HTTP driver formats server errors as '... Code: NN. DB::Exception: ...' (the
    code also appears as 'received ClickHouse error code NN'). Returns None when no code
    is present (e.g. show_clickhouse_errors disabled, or a transport error)."""
    m = _CH_CODE_RE.search(str(exc))
    if m:
        return int(m.group(1))
    m = re.search(r"error code\s+(\d+)", str(exc))
    return int(m.group(1)) if m else None


def _should_fast_fail(exc: BaseException) -> bool:
    """A caught RETRYABLE exception that is actually a deterministic bug — a client-side
    ProgrammingError/DataError, or a server DatabaseError carrying a known query-bug/auth
    code — must not be retried. Unknown/absent codes default to retryable."""
    if isinstance(exc, NON_RETRYABLE):
        return True
    code = _clickhouse_error_code(exc)
    return code is not None and code in NON_RETRYABLE_CH_ERROR_CODES


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


def _ensure_no_proxy_for_clickhouse() -> None:
    """clickhouse_connect's TLS to *.clickhouse.cloud fails through the corporate x2p
    proxy; excluding the domain from NO_PROXY/no_proxy routes it directly. Idempotent,
    and a no-op-safe augmentation when no proxy is configured."""
    domain = ".clickhouse.cloud"
    for var in ("NO_PROXY", "no_proxy"):
        current = os.environ.get(var, "")
        entries = [e.strip() for e in current.split(",") if e.strip()]
        if domain not in entries:
            entries.append(domain)
            os.environ[var] = ",".join(entries)


def get_clickhouse_client() -> Client:
    _ensure_no_proxy_for_clickhouse()
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
            if _should_fast_fail(exc):
                raise
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
