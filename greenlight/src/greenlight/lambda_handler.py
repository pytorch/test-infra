"""AWS Lambda entry point for the greenlight review scan.

Fetches the GitHub App private key and ClickHouse password from AWS Secrets Manager,
mints a least-privilege App installation token, resolves the App's own ``<slug>[bot]`` login,
and runs one ``review`` scan through the same CLI used on the command line. The Lambda function
timeout is the runtime backstop, so the in-process guards are disabled here (their hard watchdog
force-exits via ``os._exit``, which is wrong under the Lambda runtime).
"""

from __future__ import annotations

import base64
import json
import logging
import os
from typing import TYPE_CHECKING

from greenlight import cli
from greenlight.constants import BOT_LOGIN_SUFFIX, is_app_login
from greenlight.exit_codes import EXIT_ALREADY_RUNNING, EXIT_OK

if TYPE_CHECKING:
    from github import GithubIntegration

logger = logging.getLogger(__name__)

_AWS_REGION = "us-east-1"

# Least-privilege scope for the installation token: only the repos and permissions the scan
# needs, even though the App itself holds broader org-level grants. pull_requests is write, not
# read: the scan revokes greenlight's own approval on a reverted PR.
# Keep in sync with the actions/create-github-app-token scope in .github/workflows/greenlight-review.yml.
_TOKEN_PERMISSIONS = {
    "actions": "write",
    "pull_requests": "write",
    "contents": "read",
    "members": "read",
}
_TOKEN_REPOSITORIES = ["pytorch", "test-infra"]

# A dispatch costs 3-8s of serial main-thread work, and the Lambda function times out at 300s: an
# uncapped scan against the full evaluation cohort would run out of clock mid-pass. Deferring is
# free -- no state row is written for a deferred PR, so the next tick re-evaluates and dispatches
# it -- while overrunning the timeout kills the scan after arbitrary partial work.
_MAX_DISPATCHES_PER_SCAN = 30


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise ValueError(f"{name} is required for the greenlight Lambda handler")
    return value


def _require_key(mapping: dict[str, str], key: str, source: str) -> str:
    if key not in mapping:
        raise ValueError(f"{source} is missing required key {key!r}")
    return mapping[key]


def _require_clickhouse_host() -> None:
    if not (os.environ.get("CLICKHOUSE_HOST") or os.environ.get("CLICKHOUSE_ENDPOINT")):
        raise ValueError("CLICKHOUSE_HOST or CLICKHOUSE_ENDPOINT is required for the greenlight Lambda handler")


def _load_secret(secret_store_name: str) -> dict[str, str]:
    import boto3  # lazy: keeps this module importable without the AWS SDK

    client = boto3.client("secretsmanager", region_name=_AWS_REGION)
    response = client.get_secret_value(SecretId=secret_store_name)
    secret: dict[str, str] = json.loads(response["SecretString"])
    return secret


def _github_integration(app_id: str, pem: str) -> GithubIntegration:
    import github  # lazy: keeps this module importable without PyGithub

    return github.GithubIntegration(auth=github.Auth.AppAuth(app_id, pem))


def _mint_installation_token(integration: GithubIntegration, installation_id: int) -> str:
    # PyGithub 2.9.1's GithubIntegration.get_access_token sends only ``permissions`` and cannot
    # scope ``repositories``; the token is minted through the integration's public requester
    # (its documented escape hatch for endpoints PyGithub does not model) so both are applied.
    _, data = integration.requester.requestJsonAndCheck(
        "POST",
        f"/app/installations/{installation_id}/access_tokens",
        input={"permissions": _TOKEN_PERMISSIONS, "repositories": _TOKEN_REPOSITORIES},
    )
    return _require_key(data, "token", "installation token response")


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


def handler(event: dict[str, object], context: object) -> dict[str, str]:  # noqa: ARG001
    secret_store_name = _require_env("SECRET_STORE_NAME")
    app_id = _require_env("GITHUB_APP_ID")
    installation_id = int(_require_env("GITHUB_INSTALLATION_ID"))
    _require_env("CLICKHOUSE_USERNAME")
    _require_clickhouse_host()

    secret = _load_secret(secret_store_name)
    secret_source = f"secret {secret_store_name!r}"
    pem_b64 = _require_key(secret, "GITHUB_APP_SECRET", secret_source)
    pem = base64.b64decode(pem_b64).decode("utf-8")
    os.environ["CLICKHOUSE_PASSWORD"] = _require_key(secret, "CLICKHOUSE_PASSWORD", secret_source)
    integration = _github_integration(app_id, pem)
    os.environ["PYTORCH_GREENLIGHT_GITHUB_TOKEN"] = _mint_installation_token(integration, installation_id)
    os.environ["BOT_LOGIN"] = _resolve_bot_login(integration)

    # The Lambda function timeout is the runtime backstop; a zero max-runtime disables both the
    # SIGALRM soft timeout and the hard watchdog (whose os._exit would abort the runtime uncleanly).
    os.environ["PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS"] = "0"

    # No PYTORCH_GREENLIGHT_LOCK_PATH is set: Lambda's reserved_concurrent_executions = 1 already
    # guarantees single-flight, so the in-process fcntl lock is intentionally absent and the
    # EXIT_ALREADY_RUNNING branch below is only defensive/forward-compat.
    rc = cli.main(["review", "--ref", "main", "--max", str(_MAX_DISPATCHES_PER_SCAN)])
    if rc == EXIT_OK:
        return {"status": "ok"}
    if rc == EXIT_ALREADY_RUNNING:
        logger.warning("greenlight review skipped: another instance holds the lock")
        return {"status": "already_running"}
    raise RuntimeError(f"greenlight review failed with exit code {rc}")
