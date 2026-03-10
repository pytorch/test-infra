"""Lambda entrypoint for cross_repo_ci_webhook — handles POST /github/webhook."""

from __future__ import annotations

import base64
import json
import logging
import os

import webhook_handler
from config import RelayConfig
from utils import RelayHTTPException

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

_config = RelayConfig.from_env(route="webhook")

_JSON_HEADERS = {"content-type": "application/json"}


def lambda_handler(event, context):
    http = event.get("requestContext", {}).get("http", {})
    method = http.get("method", "").upper()
    path = http.get("path", "")

    raw_body = event.get("body") or ""
    if event.get("isBase64Encoded"):
        body_bytes = base64.b64decode(raw_body)
    else:
        body_bytes = raw_body.encode("utf-8")

    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}

    if method != "POST" or path != "/github/webhook":
        if path == "/github/webhook":
            return {"statusCode": 405, "headers": _JSON_HEADERS, "body": json.dumps({"detail": "Method not allowed"})}
        return {"statusCode": 404, "headers": _JSON_HEADERS, "body": json.dumps({"detail": "Not found"})}

    logger.info("request method=%s path=%s", method, path)
    try:
        payload = json.loads(body_bytes) if body_bytes else {}
        result = webhook_handler.handle_github_webhook(
            _config,
            body_bytes,
            payload,
            headers.get("x-hub-signature-256", ""),
            headers.get("x-github-event", ""),
        )
        return {"statusCode": 200, "headers": _JSON_HEADERS, "body": json.dumps(result)}
    except RelayHTTPException as exc:
        return {"statusCode": exc.status_code, "headers": _JSON_HEADERS, "body": json.dumps({"detail": exc.detail})}
