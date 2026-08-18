from __future__ import annotations

import json
import logging

from utils import jwt_helper
from utils.config import get_config
from utils.misc import HTTPException, JSON_HEADERS, parse_lambda_event

from . import callback_handler, cleanup_handler


logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger(__name__)


def lambda_handler(event, context):
    # EventBridge scheduled events trigger zombie-job cleanup.
    if event.get("source") == "crcr.sweeper":
        config = get_config()
        result = cleanup_handler.handle(config)
        return {
            "statusCode": 200,
            "headers": JSON_HEADERS,
            "body": json.dumps(result),
        }

    method, path, body_bytes, headers = parse_lambda_event(event)

    logger.info("request method=%s path=%s", method, path)

    if method != "POST" or path != "/github/callback":
        if path == "/github/callback":
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

    try:
        config = get_config()
        body = json.loads(body_bytes) if body_bytes else {}

        # Load external CI provider repo mappings (Buildkite, etc.) so
        # verify_oidc_token can resolve non-GitHub OIDC tokens.  Cached
        # in Redis; no-op when CI_PROVIDERS_URL is not configured.
        jwt_helper.load_ci_providers(config)

        oidc_claims = jwt_helper.verify_oidc_token(headers.get("authorization", ""))
        verified_repo = oidc_claims["repository"]

        result = callback_handler.handle(config, body, verified_repo)
        return {"statusCode": 200, "headers": JSON_HEADERS, "body": json.dumps(result)}

    except json.JSONDecodeError:
        logger.exception("Invalid JSON body")
        return {
            "statusCode": 400,
            "headers": JSON_HEADERS,
            "body": json.dumps({"detail": "Invalid JSON body"}),
        }
    except HTTPException as exc:
        logger.exception(exc.detail)
        return {
            "statusCode": exc.status_code,
            "headers": JSON_HEADERS,
            "body": json.dumps({"detail": exc.detail}),
        }
    except Exception:
        logger.exception("Internal server error")
        return {
            "statusCode": 500,
            "headers": JSON_HEADERS,
            "body": json.dumps({"detail": "Internal server error"}),
        }
