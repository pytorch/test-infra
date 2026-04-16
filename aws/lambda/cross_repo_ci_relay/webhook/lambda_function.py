from __future__ import annotations

import hashlib
import hmac
import json
import logging

from utils.config import get_config
from utils.misc import HTTPException, JSON_HEADERS, parse_lambda_event

from . import event_handler


logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger(__name__)


def _verify_signature(secret: str, body: bytes, signature: str) -> None:
    if not signature:
        raise HTTPException(status_code=400, detail="No signature")
    mac = hmac.new(secret.encode(), body, hashlib.sha256)
    expected = "sha256=" + mac.hexdigest()
    if not hmac.compare_digest(expected, signature):
        logger.warning("webhook signature mismatch")
        raise HTTPException(status_code=401, detail="Bad signature")


_SUPPORTED_EVENTS = frozenset({"pull_request", "push"})


def lambda_handler(event, context):
    method, path, body_bytes, headers = parse_lambda_event(event)

    delivery = headers.get("x-github-delivery", "")
    logger.info("request method=%s path=%s delivery=%s", method, path, delivery)

    if method != "POST" or path != "/github/webhook":
        if path == "/github/webhook":
            return {
                "statusCode": 405,
                "headers": JSON_HEADERS,
                "body": json.dumps({"detail": "Method not allowed"}),
            }
        return {
            "statusCode": 404,
            "headers": JSON_HEADERS,
            "body": json.dumps({"detail": "Not found"}),
        }

    event_type = headers.get("x-github-event", "")
    if event_type not in _SUPPORTED_EVENTS:
        logger.info("event=%s ignored before verification", event_type)
        return {
            "statusCode": 200,
            "headers": JSON_HEADERS,
            "body": json.dumps({"ignored": True}),
        }

    try:
        config = get_config()

        _verify_signature(
            config.github_app_secret, body_bytes, headers.get("x-hub-signature-256", "")
        )

        payload = json.loads(body_bytes) if body_bytes else {}
        repo = (payload.get("repository") or {}).get("full_name", "")

        if repo.lower() != config.upstream_repo.lower():
            logger.info("repo=%s not upstream, ignored", repo)
            return {
                "statusCode": 200,
                "headers": JSON_HEADERS,
                "body": json.dumps({"ignored": True}),
            }

        result = event_handler.handle(
            config,
            payload,
            event_type=event_type,
            delivery_id=delivery,
        )
        return {"statusCode": 200, "headers": JSON_HEADERS, "body": json.dumps(result)}

    except json.JSONDecodeError:
        logger.warning("invalid JSON body in webhook request")
        return {
            "statusCode": 400,
            "headers": JSON_HEADERS,
            "body": json.dumps({"detail": "Invalid JSON body"}),
        }
    except HTTPException as exc:
        logger.warning(
            "http exception status=%d detail=%s", exc.status_code, exc.detail
        )
        return {
            "statusCode": exc.status_code,
            "headers": JSON_HEADERS,
            "body": json.dumps({"detail": exc.detail}),
        }
    except Exception:
        logger.exception("unhandled error")
        return {
            "statusCode": 500,
            "headers": JSON_HEADERS,
            "body": json.dumps({"detail": "Internal server error"}),
        }
