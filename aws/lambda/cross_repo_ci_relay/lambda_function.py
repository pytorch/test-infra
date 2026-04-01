from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
from typing import Callable

import pr_handler
from config import RelayConfig
from utils import HTTPException


logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger(__name__)

_cached_config: RelayConfig | None = None


def _verify_signature(secret: str, body: bytes, signature: str) -> None:
    if not signature:
        raise HTTPException(status_code=400, detail="No signature")
    mac = hmac.new(secret.encode(), body, hashlib.sha256)
    expected = "sha256=" + mac.hexdigest()
    if not hmac.compare_digest(expected, signature):
        logger.warning("webhook signature mismatch")
        raise HTTPException(status_code=401, detail="Bad signature")


_JSON_HEADERS = {"content-type": "application/json"}

_EVENT_HANDLERS: dict[str, Callable[[RelayConfig, dict], dict]] = {
    "pull_request": pr_handler.handle,
}


def _get_config() -> RelayConfig:
    global _cached_config
    if _cached_config is None:
        _cached_config = RelayConfig.from_env()
    return _cached_config


def lambda_handler(event, context):
    http = event.get("requestContext", {}).get("http", {})
    method = http.get("method", "").upper()
    path = http.get("path", "")

    raw_body = event.get("body") or ""
    body_bytes = (
        base64.b64decode(raw_body)
        if event.get("isBase64Encoded")
        else raw_body.encode("utf-8")
    )
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}

    logger.info("request method=%s path=%s", method, path)
    if method != "POST" or path != "/github/webhook":
        if path == "/github/webhook":
            return {
                "statusCode": 405,
                "headers": _JSON_HEADERS,
                "body": json.dumps({"detail": "Method not allowed"}),
            }
        return {
            "statusCode": 404,
            "headers": _JSON_HEADERS,
            "body": json.dumps({"detail": "Not found"}),
        }

    try:
        config = _get_config()

        _verify_signature(
            config.github_app_secret, body_bytes, headers.get("x-hub-signature-256", "")
        )

        payload = json.loads(body_bytes) if body_bytes else {}
        repo = (payload.get("repository") or {}).get("full_name", "")

        if repo.lower() != config.upstream_repo.lower():
            logger.info("repo=%s not upstream, ignored", repo)
            return {
                "statusCode": 200,
                "headers": _JSON_HEADERS,
                "body": json.dumps({"ignored": True}),
            }

        event_type = headers.get("x-github-event", "")
        handler = _EVENT_HANDLERS.get(event_type)
        if handler is None:
            logger.info("event=%s ignored", event_type)
            return {
                "statusCode": 200,
                "headers": _JSON_HEADERS,
                "body": json.dumps({"ignored": True}),
            }

        result = handler(config, payload)
        return {"statusCode": 200, "headers": _JSON_HEADERS, "body": json.dumps(result)}

    except json.JSONDecodeError:
        return {
            "statusCode": 400,
            "headers": _JSON_HEADERS,
            "body": json.dumps({"detail": "Invalid JSON body"}),
        }
    except HTTPException as exc:
        return {
            "statusCode": exc.status_code,
            "headers": _JSON_HEADERS,
            "body": json.dumps({"detail": exc.detail}),
        }
    except Exception as exc:
        logger.exception("unhandled error: %s", exc)
        return {
            "statusCode": 500,
            "headers": _JSON_HEADERS,
            "body": json.dumps({"detail": "Internal server error"}),
        }
