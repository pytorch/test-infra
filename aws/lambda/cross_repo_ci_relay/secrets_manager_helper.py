import base64
import json
import logging
import time
from dataclasses import dataclass

import boto3

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RelaySecretsFromStore:
    github_webhook_secret: str = ""
    github_app_private_key: str = ""
    clickhouse_password: str = ""
    redis_url: str = ""


def _decode_private_key(value: str) -> str:
    if not value:
        return ""
    if "-----BEGIN" in value:
        return value
    try:
        decoded = base64.b64decode(value).decode("utf-8")
    except Exception:
        return value
    return decoded if "-----BEGIN" in decoded else value


def _region_from_secret_id(secret_store_arn: str) -> str | None:
    if secret_store_arn.startswith("arn:"):
        parts = secret_store_arn.split(":", 5)
        if len(parts) >= 4 and parts[3]:
            return parts[3]
    session = boto3.session.Session()
    return session.region_name


def get_secret_from_aws(secret_store_arn: str) -> RelaySecretsFromStore:
    last_error = None
    region_name = _region_from_secret_id(secret_store_arn)
    for attempt in range(3):
        try:
            session = boto3.session.Session()
            client = session.client(service_name="secretsmanager", region_name=region_name)
            response = client.get_secret_value(SecretId=secret_store_arn)
            secret_string = response.get("SecretString")
            if secret_string is None:
                secret_binary = response.get("SecretBinary")
                if not secret_binary:
                    raise RuntimeError(
                        "Secrets Manager response missing SecretString/SecretBinary"
                    )
                secret_string = base64.b64decode(secret_binary).decode("utf-8")

            secret_value = json.loads(secret_string)
            return RelaySecretsFromStore(
                github_webhook_secret=secret_value.get("GITHUB_WEBHOOK_SECRET", ""),
                github_app_private_key=_decode_private_key(
                    secret_value.get("GITHUB_APP_PRIVATE_KEY", "")
                ),
                clickhouse_password=secret_value.get("CLICKHOUSE_PASSWORD", ""),
                redis_url=secret_value.get("REDIS_URL", ""),
            )
        except Exception as exc:
            last_error = exc
            logger.warning(
                "Failed to retrieve secret %s from Secrets Manager in region %s on attempt %s: %s",
                secret_store_arn,
                region_name,
                attempt + 1,
                exc,
            )
            if attempt == 2:
                break
            time.sleep(2**attempt)

    raise RuntimeError(
        "Failed to retrieve secrets from AWS Secrets Manager: "
        f"{secret_store_arn} (region={region_name}) - "
        f"{type(last_error).__name__}: {last_error}"
    ) from last_error


def get_runtime_secrets(secret_store_arn: str) -> RelaySecretsFromStore:
    if not secret_store_arn:
        raise RuntimeError("SECRET_STORE_ARN is not configured")

    secrets = get_secret_from_aws(secret_store_arn)
    logger.info("Secrets loaded from secret store %s", secret_store_arn)
    return secrets
