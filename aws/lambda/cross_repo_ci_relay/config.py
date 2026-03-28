import json
import os
from dataclasses import dataclass

import boto3
from botocore.config import Config
from dotenv import find_dotenv, load_dotenv


@dataclass(frozen=True)
class RelaySecrets:
    github_app_secret: str = ""
    github_app_private_key: str = ""

    @classmethod
    def from_aws(cls, secret_store_arn: str, client=None) -> "RelaySecrets":
        region = os.environ.get("AWS_REGION", "us-east-1")
        try:
            if client is None:
                client = boto3.session.Session().client(
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
    secret_store_arn: str
    allowlist_url: str
    upstream_repo: str
    redis_endpoint: str
    redis_login: str
    allowlist_ttl_seconds: int

    @classmethod
    def from_env(cls) -> "RelayConfig":
        load_dotenv(find_dotenv(usecwd=False), override=False)

        # Env vars take priority; Secrets Manager is the fallback
        github_app_secret = os.getenv("GITHUB_APP_SECRET", "")
        github_app_private_key = os.getenv("GITHUB_APP_PRIVATE_KEY", "")
        secret_store_arn = os.getenv("SECRET_STORE_ARN", "")

        if not github_app_secret or not github_app_private_key:
            if not secret_store_arn:
                missing = [
                    v
                    for v, val in [
                        ("GITHUB_APP_SECRET", github_app_secret),
                        ("GITHUB_APP_PRIVATE_KEY", github_app_private_key),
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
            missing_in_secret = [
                v
                for v, val in [
                    ("GITHUB_APP_SECRET", github_app_secret),
                    ("GITHUB_APP_PRIVATE_KEY", github_app_private_key),
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

        return cls(
            github_app_id=_require("GITHUB_APP_ID"),
            github_app_secret=github_app_secret,
            github_app_private_key=github_app_private_key,
            secret_store_arn=secret_store_arn,
            allowlist_url=_require("ALLOWLIST_URL"),
            upstream_repo=os.getenv("UPSTREAM_REPO", "pytorch/pytorch"),
            redis_endpoint=_require("REDIS_ENDPOINT"),
            redis_login=os.getenv("REDIS_LOGIN", ""),
            allowlist_ttl_seconds=allowlist_ttl_seconds,
        )
