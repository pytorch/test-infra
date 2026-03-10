from dataclasses import dataclass
import os

from dotenv import find_dotenv, load_dotenv
from secrets_manager_helper import get_runtime_secrets


def _required_env(var_name: str, required: bool = True) -> str:
    value = os.getenv(var_name)
    if required and not value:
        raise RuntimeError(f"Missing required environment variable: {var_name}")
    return value


@dataclass(frozen=True)
class RelayConfig:
    github_app_id: str
    github_webhook_secret: str
    github_app_private_key: str
    secret_store_arn: str
    whitelist_url: str
    upstream_repo: str
    clickhouse_url: str
    clickhouse_user: str
    clickhouse_password: str
    clickhouse_database: str
    redis_url: str
    whitelist_ttl_seconds: int

    @property
    def github_webhook_secret_bytes(self) -> bytes:
        return (self.github_webhook_secret or "").encode()

    @classmethod
    def from_env(cls, route: str = "webhook") -> "RelayConfig":
        load_dotenv(find_dotenv(usecwd=False), override=False)
        secret_store_arn = os.getenv("SECRET_STORE_ARN", "")
        secrets = get_runtime_secrets(secret_store_arn) if secret_store_arn else None
        github_webhook_secret = (
            getattr(secrets, "github_webhook_secret", "")
            or _required_env("GITHUB_WEBHOOK_SECRET", required=(route == "webhook"))
        )
        github_app_private_key = (
            getattr(secrets, "github_app_private_key", "")
            or _required_env("GITHUB_APP_PRIVATE_KEY", required=(route == "webhook"))
        )
        clickhouse_password = (
            getattr(secrets, "clickhouse_password", "")
            or _required_env("CLICKHOUSE_PASSWORD", required=(route == "result"))
        )
        redis_url = getattr(secrets, "redis_url", "") or _required_env("REDIS_URL", required=True)
        return cls(
            github_app_id=_required_env("GITHUB_APP_ID", required=(route == "webhook")),
            github_webhook_secret=github_webhook_secret,
            github_app_private_key=github_app_private_key,
            secret_store_arn=secret_store_arn,
            whitelist_url=_required_env("WHITELIST_URL", required=True),
            upstream_repo=os.getenv("UPSTREAM_REPO", "pytorch/pytorch"),
            clickhouse_url=_required_env("CLICKHOUSE_URL", required=(route == "result")),
            clickhouse_user=_required_env("CLICKHOUSE_USER", required=(route == "result")),
            clickhouse_password=clickhouse_password,
            clickhouse_database=_required_env("CLICKHOUSE_DATABASE", required=(route == "result")),
            redis_url=redis_url,
            whitelist_ttl_seconds=int(os.getenv("WHITELIST_TTL_SECONDS", 1200)),
        )
