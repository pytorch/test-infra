"""Lambda entrypoint for cross_repo_ci_result — handles POST /ci/result."""

from __future__ import annotations

import base64
import json
import logging
import os

import result_handler
from config import RelayConfig
from utils import RelayHTTPException

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

_config = RelayConfig.from_env(route="result")

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

    if method != "POST" or path != "/ci/result":
        if path == "/ci/result":
            return {"statusCode": 405, "headers": _JSON_HEADERS, "body": json.dumps({"detail": "Method not allowed"})}
        return {"statusCode": 404, "headers": _JSON_HEADERS, "body": json.dumps({"detail": "Not found"})}

    try:
        authorization = headers.get("authorization", "")
        data = json.loads(body_bytes) if body_bytes else {}
        result = result_handler.handle_ci_result(_config, data, authorization)
        return {"statusCode": 200, "headers": _JSON_HEADERS, "body": json.dumps(result)}
    except RelayHTTPException as exc:
        return {"statusCode": exc.status_code, "headers": _JSON_HEADERS, "body": json.dumps({"detail": exc.detail})}
