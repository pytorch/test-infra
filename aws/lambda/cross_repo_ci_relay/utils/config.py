import json
import os
from dataclasses import dataclass

import boto3
from botocore.config import Config


@dataclass(frozen=True)
class RelaySecrets:
    github_app_secret: str = ""
    github_app_private_key: str = ""
    redis_login: str = ""
    hud_bot_key: str = ""

    @classmethod
    def from_aws(cls, secret_store_arn: str, client=None) -> "RelaySecrets":
        region = os.environ.get("AWS_REGION", "us-east-1")
        try:
            if client is None:
                client = boto3.client(
                    "secretsmanager",
                    region_name=region,
                    config=Config(retries={"max_attempts": 3, "mode": "standard"}),
                )
            response = client.get_secret_value(SecretId=secret_store_arn)
            secret = json.loads(response["SecretString"])
        except json.JSONDecodeError as e:
            raise RuntimeError(
                f"Secret at {secret_store_arn!r} contains invalid JSON: {e}"
            ) from e
        except Exception as e:
            raise RuntimeError(
                f"Failed to load secrets from AWS Secrets Manager ({secret_store_arn!r}): {e}"
            ) from e
        return cls(
            github_app_secret=secret.get("GITHUB_APP_SECRET", ""),
            github_app_private_key=secret.get("GITHUB_APP_PRIVATE_KEY", ""),
            redis_login=secret.get("REDIS_LOGIN", ""),
            hud_bot_key=secret.get("HUD_BOT_KEY", ""),
        )


def _require(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


@dataclass(frozen=True)
class RelayConfig:
    github_app_id: str
    github_app_secret: str
    github_app_private_key: str
    allowlist_url: str
    upstream_repo: str
    redis_endpoint: str
    redis_login: str
    allowlist_ttl_seconds: int
    max_dispatch_workers: int
    hud_api_url: str
    hud_bot_key: str
    oot_status_ttl: int

    @classmethod
    def from_env(cls) -> "RelayConfig":
        # Env vars take priority; Secrets Manager is the fallback
        github_app_secret = os.getenv("GITHUB_APP_SECRET", "")
        github_app_private_key = os.getenv("GITHUB_APP_PRIVATE_KEY", "")
        redis_login = os.getenv("REDIS_LOGIN", "")
        secret_store_arn = os.getenv("SECRET_STORE_ARN", "")
        hud_bot_key = os.getenv("HUD_BOT_KEY", "")

        if not github_app_secret or not github_app_private_key or not redis_login:
            if not secret_store_arn:
                missing = [
                    v
                    for v, val in [
                        ("GITHUB_APP_SECRET", github_app_secret),
                        ("GITHUB_APP_PRIVATE_KEY", github_app_private_key),
                        ("REDIS_LOGIN", redis_login),
                    ]
                    if not val
                ]
                raise RuntimeError(
                    f"Missing required environment variables: {', '.join(missing)} "
                    "(set them directly or provide SECRET_STORE_ARN)"
                )
            secrets = RelaySecrets.from_aws(secret_store_arn)
            github_app_secret = github_app_secret or secrets.github_app_secret
            github_app_private_key = (
                github_app_private_key or secrets.github_app_private_key
            )
            redis_login = redis_login or secrets.redis_login
            hud_bot_key = hud_bot_key or secrets.hud_bot_key
            missing_in_secret = [
                v
                for v, val in [
                    ("GITHUB_APP_SECRET", github_app_secret),
                    ("GITHUB_APP_PRIVATE_KEY", github_app_private_key),
                    ("REDIS_LOGIN", redis_login),
                    ("HUD_BOT_KEY", hud_bot_key),
                ]
                if not val
            ]
            if missing_in_secret:
                raise RuntimeError(
                    f"Secret at {secret_store_arn!r} is missing keys: {', '.join(missing_in_secret)}"
                )

        try:
            allowlist_ttl_seconds = int(os.getenv("ALLOWLIST_TTL_SECONDS", "1200"))
        except ValueError:
            raise RuntimeError("ALLOWLIST_TTL_SECONDS must be a valid integer")

        # The allowlist is fetched from GitHub without authentication, so cache churn must
        # stay comfortably below GitHub's unauthenticated 60 requests/hour rate limit.
        # Enforce a 15-minute floor so an overly aggressive TTL change does not create
        # avoidable rate-limit risk in production.
        allowlist_ttl_seconds = max(allowlist_ttl_seconds, 900)

        # GitHub can keep a workflow job in `pending` state for up to 3 days before
        # auto-cancelling it, so OOT-status records must live at least that long.
        # Default to 3 days (259200 s).
        try:
            oot_status_ttl = int(os.getenv("OOT_STATUS_TTL", "259200"))
        except ValueError:
            raise RuntimeError("OOT_STATUS_TTL must be a valid integer")

        return cls(
            github_app_id=_require("GITHUB_APP_ID"),
            github_app_secret=github_app_secret,
            github_app_private_key=github_app_private_key,
            allowlist_url=_require("ALLOWLIST_URL"),
            upstream_repo=os.getenv("UPSTREAM_REPO", "pytorch/pytorch"),
            redis_endpoint=_require("REDIS_ENDPOINT"),
            redis_login=redis_login,
            allowlist_ttl_seconds=allowlist_ttl_seconds,
            max_dispatch_workers=int(os.getenv("MAX_DISPATCH_WORKERS", "32")),
            hud_api_url=os.getenv("HUD_API_URL", ""),
            hud_bot_key=hud_bot_key,
            oot_status_ttl=oot_status_ttl,
        )


_cached_config: RelayConfig | None = None


def get_config() -> RelayConfig:
    global _cached_config
    if _cached_config is None:
        _cached_config = RelayConfig.from_env()
    return _cached_config
