"""AWS Lambda entry point for the greenlight scan: one function, two roles chosen by the event.

- The EventBridge schedule (``"source": "aws.events"``, ``"detail-type": "Scheduled Event"``) runs the
  planner (``fanout.Planner``): pytorch/pytorch's run, and one asynchronous worker invocation of this same
  function per other repo with work.
- A worker event (``worker.parse_payload``) runs that repo's worker (``worker.Worker``).

Any other event is refused before anything is read. Both roles fetch the GitHub App private key and the
ClickHouse password from AWS Secrets Manager, mint least-privilege installation tokens per job and repo
(``app_tokens.AppTokens``), resolve the App's own ``<slug>[bot]`` login, and keep their shared state in the
DynamoDB table ``PYTORCH_GREENLIGHT_STATE_TABLE`` (``state_dynamo.DynamoStore``). The Lambda function
timeout is the runtime backstop: neither role arms the CLI's in-process hang guards.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import time
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from greenlight.config import Config
from greenlight.constants import (
    AWS_REGION,
    BOT_LOGIN_SUFFIX,
    DEFAULT_DISPATCH_REF,
    DEFAULT_TIMEOUT_MINUTES,
    is_app_login,
)
from greenlight.log import configure_logging
from greenlight.worker import WORKER_KEY, parse_payload

if TYPE_CHECKING:
    from collections.abc import Mapping

    from github import GithubIntegration

    from greenlight.worker import WorkerPayload

logger = logging.getLogger(__name__)

# A dispatch costs 3-8s of serial main-thread work, and the Lambda function times out at 300s: an
# uncapped scan against the full evaluation cohort would run out of clock mid-pass. Deferring is
# free -- no state row is written for a deferred PR, so the next tick that lists it re-evaluates
# and dispatches it -- while overrunning the timeout kills the scan after arbitrary partial work.
_DEFAULT_MAX_DISPATCHES_PER_SCAN = 30
_MAX_DISPATCHES_ENV = "PYTORCH_GREENLIGHT_MAX_DISPATCHES_PER_SCAN"
_SCHEDULE = {"source": "aws.events", "detail-type": "Scheduled Event"}


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise ValueError(f"{name} is required for the greenlight Lambda handler")
    return value


def _max_dispatches_from_env() -> int:
    raw = os.environ.get(_MAX_DISPATCHES_ENV, "").strip()
    if not raw:
        return _DEFAULT_MAX_DISPATCHES_PER_SCAN
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{_MAX_DISPATCHES_ENV} must be an integer, got {raw!r}") from exc
    # Zero is a deliberate pause switch: the scan still lists, still revokes its approval on a
    # reverted or ineligible PR and still writes GL/* labels, it just fingerprints and dispatches
    # nothing. A negative magnitude means the same thing once the scan clamps it, so it can only be
    # a typo -- and one whose symptom is a silent stall. "-0" is not that typo and is accepted: it
    # parses to zero because it is zero.
    if value < 0:
        raise ValueError(f"{_MAX_DISPATCHES_ENV} must not be negative, got {value}")
    return value


def _require_clickhouse_host() -> None:
    if not (os.environ.get("CLICKHOUSE_HOST") or os.environ.get("CLICKHOUSE_ENDPOINT")):
        raise ValueError("CLICKHOUSE_HOST or CLICKHOUSE_ENDPOINT is required for the greenlight Lambda handler")


def _load_secret(secret_store_name: str) -> dict[str, str]:
    import boto3  # lazy: keeps this module importable without the AWS SDK

    client = boto3.client("secretsmanager", region_name=AWS_REGION)
    response = client.get_secret_value(SecretId=secret_store_name)
    secret: dict[str, str] = json.loads(response["SecretString"])
    return secret


def _github_integration(app_id: str, pem: str) -> GithubIntegration:
    import github  # lazy: keeps this module importable without PyGithub

    return github.GithubIntegration(auth=github.Auth.AppAuth(app_id, pem))


def _resolve_bot_login(integration: GithubIntegration) -> str:
    """Return the App's own ``<slug>[bot]`` account login, read from ``GET /app``.

    The scan matches greenlight's own approving reviews by this login before revoking them on a
    reverted PR, so a wrong or empty one would dismiss nothing while reporting success. Anything
    that is not ``<slug>[bot]`` raises here rather than reaching the scan.
    """
    slug = integration.get_app().slug
    # PyGithub annotates GithubApp.slug as str but returns None when the response omits it (the
    # unset attribute's .value), and interpolating that yields the App-shaped literal "None[bot]".
    login = f"{slug}{BOT_LOGIN_SUFFIX}" if slug else ""
    if not is_app_login(login):
        raise ValueError(f"GET /app returned an unusable app slug {slug!r} for the greenlight bot login")
    return login


def _role(event: Mapping[str, object]) -> WorkerPayload | None:
    """The worker payload ``event`` carries, None for the schedule; ``ValueError`` for any other event."""
    if all(event.get(key) == value for key, value in _SCHEDULE.items()):
        return None
    if WORKER_KEY in event:
        return parse_payload(event)
    raise ValueError(f"refusing an event that is neither the scan schedule nor a worker event (keys {sorted(event)})")


def _tick(event: Mapping[str, object], started: float) -> str:
    """The planner's tick id: the schedule's own time, the same on a retried delivery, else the start."""
    scheduled = event.get("time")
    if isinstance(scheduled, str) and scheduled:
        return scheduled
    return datetime.fromtimestamp(started, UTC).isoformat(timespec="seconds")


def handler(event: dict[str, object], context: object) -> dict[str, str]:  # noqa: ARG001
    from greenlight.app_tokens import AppTokens, require_key  # lazy: keeps this module importable without PyGithub
    from greenlight.fanout import Planner, lambda_invoker
    from greenlight.state_dynamo import DynamoStore
    from greenlight.worker import Worker

    started = time.time()
    payload = _role(event)
    secret_store_name = _require_env("SECRET_STORE_NAME")
    app_id = _require_env("GITHUB_APP_ID")
    installation_id = int(_require_env("GITHUB_INSTALLATION_ID"))
    _require_env("CLICKHOUSE_USERNAME")
    _require_clickhouse_host()
    max_dispatches = _max_dispatches_from_env()
    function_name = _require_env("AWS_LAMBDA_FUNCTION_NAME") if payload is None else ""
    config = Config.from_env()
    configure_logging(config.log_level)
    if config.state_table is None:
        raise ValueError("PYTORCH_GREENLIGHT_STATE_TABLE is required for the greenlight Lambda handler")

    secret = _load_secret(secret_store_name)
    secret_source = f"secret {secret_store_name!r}"
    pem_b64 = require_key(secret, "GITHUB_APP_SECRET", secret_source)
    pem = base64.b64decode(pem_b64).decode("utf-8")
    os.environ["CLICKHOUSE_PASSWORD"] = require_key(secret, "CLICKHOUSE_PASSWORD", secret_source)
    integration = _github_integration(app_id, pem)
    store = DynamoStore(config.state_table)
    tokens = AppTokens(integration, installation_id)

    if payload is not None:
        status = Worker(
            config,
            payload,
            store,
            tokens,
            resolve_bot_login=lambda: _resolve_bot_login(integration),
            ref=DEFAULT_DISPATCH_REF,
            timeout_minutes=DEFAULT_TIMEOUT_MINUTES,
            started=started,
            max_dispatches=max_dispatches,
        ).run()
        return {"status": status}
    Planner(
        config,
        tick=_tick(event, started),
        store=store,
        tokens=tokens,
        invoke=lambda_invoker(function_name),
        bot_login=_resolve_bot_login(integration),
        max_dispatches=max_dispatches,
        ref=DEFAULT_DISPATCH_REF,
        timeout_minutes=DEFAULT_TIMEOUT_MINUTES,
        started=started,
    ).run()
    return {"status": "ok"}
