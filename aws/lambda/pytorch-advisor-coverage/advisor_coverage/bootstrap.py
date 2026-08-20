"""Runtime logging, client, and secret setup.

Fetches the GitHub App PEM and ClickHouse password from the same AWS Secrets
Manager secret autorevert uses, mints a MINIMALLY-scoped GitHub installation
token, and configures the shared CH (read-only) + GitHub client singletons.

`_get_secret_from_aws` / `configure_logging` are inlined copies of
`pytorch_auto_revert.__main__.get_secret_from_aws` / `setup_logging` — kept
in-package so the deployment only vendors the self-contained utils / clickhouse /
github helper modules rather than the whole autorevert CLI. Keep them in sync
with that sibling if its secret-decode block changes.
"""

from __future__ import annotations

import base64
import json
import logging
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

import boto3
import github
from pytorch_auto_revert.clickhouse_client_helper import CHCliFactory
from pytorch_auto_revert.github_client_helper import GHClientFactory
from pytorch_auto_revert.utils import RetryWithBackoff

from .config import CoverageConfig


# Libraries that log request/response bodies at DEBUG — including the minted
# GitHub token and Secrets Manager responses (PEM / CH password). Pinned to
# WARNING so that even LOG_LEVEL=DEBUG never dumps a secret to CloudWatch.
_SECRET_LEAKING_LOGGERS = (
    "github",
    "github.Requester",
    "botocore",
    "boto3",
    "urllib3",
)

# Minimum installation-token scope needed to POST workflow_dispatch. Crucially
# excludes contents:write, so a leaked coverage token cannot push/revert.
_DISPATCH_TOKEN_PERMISSIONS = {"actions": "write"}

# GitHub installation tokens expire 60 minutes after minting, and the token is a
# plain string handed to GHClientFactory — nothing refreshes it. A backfill
# dispatches for hours off one startup mint, so the dispatch path re-mints ahead
# of expiry. Freshness is judged against GitHub's own `expires_at` rather than
# elapsed local time: a laptop suspended mid-backfill wakes with the token
# already dead while a monotonic counter still reads it as fresh.
_TOKEN_REFRESH_MARGIN = timedelta(minutes=10)


@dataclass
class _DispatchAuth:
    """App credentials retained so the dispatch token can be re-minted."""

    app_id: str
    pem: str
    installation_id: int
    expires_at: datetime


_dispatch_auth: Optional[_DispatchAuth] = None


def configure_logging(log_level: str) -> None:
    """Configure logging and pin secret-leaking third-party loggers to WARNING."""
    numeric_level = getattr(logging, log_level.upper(), None)
    if not isinstance(numeric_level, int):
        raise ValueError(f"Invalid log level: {log_level}")

    root_logger = logging.getLogger()
    root_logger.setLevel(numeric_level)
    if not root_logger.handlers:
        handler = logging.StreamHandler()
        handler.setLevel(numeric_level)
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")
        )
        root_logger.addHandler(handler)

    for name in _SECRET_LEAKING_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)


@dataclass
class _AWSSecrets:
    github_app_secret: str
    clickhouse_password: str


def _get_secret_from_aws(secret_store_name: str) -> _AWSSecrets:
    try:
        for attempt in RetryWithBackoff():
            with attempt:
                session = boto3.session.Session()
                client = session.client(
                    service_name="secretsmanager", region_name="us-east-1"
                )
                resp = client.get_secret_value(SecretId=secret_store_name)
                data = json.loads(resp["SecretString"])
                return _AWSSecrets(
                    github_app_secret=base64.b64decode(
                        data["GITHUB_APP_SECRET"]
                    ).decode("utf-8"),
                    clickhouse_password=data["CLICKHOUSE_PASSWORD"],
                )
    except Exception:
        logging.exception("Failed to retrieve secrets from AWS Secrets Manager")
        sys.exit(1)


def _mint_scoped_installation_auth(app_id: str, pem: str, installation_id: int):
    """Mint an installation authorization scoped to `actions:write` only.

    Returns the whole authorization, not just the token string, because its
    `expires_at` is the only trustworthy basis for deciding when to re-mint.

    Without explicit permissions the mint inherits the App's full permission set
    (incl. contents:write → revert-capable). Scoping to actions:write is the
    minimum for workflow_dispatch and removes revert capability entirely.

    Minted through GithubIntegration rather than Auth.AppInstallationAuth:
    PyGithub (2.6.1) only builds that auth object's internal integration inside
    `withRequester`, which nothing calls until the auth is handed to a
    `github.Github(...)`, so reading `.token` off a standalone instance always
    asserts.
    """
    integration = github.GithubIntegration(auth=github.Auth.AppAuth(app_id, pem))
    try:
        return integration.get_access_token(
            installation_id, permissions=_DISPATCH_TOKEN_PERMISSIONS
        )
    except github.GithubException as e:
        # GitHub answers a key that is validly formed but registered to a
        # different App with "A JSON web token could not be decoded" — naming the
        # identifiers is what distinguishes that from a genuine outage.
        raise RuntimeError(
            f"Failed to mint an installation token for GITHUB_APP_ID={app_id}, "
            f"GITHUB_INSTALLATION_ID={installation_id}: {e}"
        ) from e


def setup_clients(config: CoverageConfig) -> None:
    """Configure ClickHouse + GitHub singletons and verify the CH connection."""
    gh_app_secret = ""
    if config.github_app_secret:
        gh_app_secret = base64.b64decode(config.github_app_secret).decode("utf-8")
    ch_password = config.clickhouse_password

    if config.secret_store_name:
        secrets = _get_secret_from_aws(config.secret_store_name)
        gh_app_secret = secrets.github_app_secret
        ch_password = secrets.clickhouse_password

    CHCliFactory.setup_client(
        config.clickhouse_host,
        config.clickhouse_port,
        config.clickhouse_username,
        ch_password,
        config.clickhouse_database,
    )

    if config.github_app_id and config.github_installation_id and gh_app_secret:
        global _dispatch_auth
        scoped = _mint_scoped_installation_auth(
            config.github_app_id, gh_app_secret, config.github_installation_id
        )
        GHClientFactory.setup_client(token=scoped.token)
        _dispatch_auth = _DispatchAuth(
            app_id=config.github_app_id,
            pem=gh_app_secret,
            installation_id=config.github_installation_id,
            expires_at=scoped.expires_at,
        )
    elif config.github_access_token:
        GHClientFactory.setup_client(token=config.github_access_token)
    else:
        logging.warning(
            "[coverage] GitHub client not configured "
            "(no app credentials or token) — dispatch disabled. "
            "Expected only in local dry-run without GitHub access."
        )

    if not CHCliFactory().connection_test():
        raise RuntimeError(
            "ClickHouse connection test failed. Please check your configuration."
        )


def refresh_dispatch_token_if_stale() -> bool:
    """Re-mint the installation token when it is close to GitHub's stated expiry.

    Returns True when a new token was installed. A no-op when the client was
    configured from a raw GITHUB_TOKEN — there are no App credentials to re-mint
    from, and a PAT does not expire on this timescale.
    """
    if _dispatch_auth is None:
        return False
    if datetime.now(timezone.utc) + _TOKEN_REFRESH_MARGIN < _dispatch_auth.expires_at:
        return False

    scoped = _mint_scoped_installation_auth(
        _dispatch_auth.app_id, _dispatch_auth.pem, _dispatch_auth.installation_id
    )
    GHClientFactory.setup_client(token=scoped.token)
    _dispatch_auth.expires_at = scoped.expires_at
    logging.info(
        "[coverage] re-minted the installation token, now valid until %s",
        scoped.expires_at.isoformat(timespec="seconds"),
    )
    return True
