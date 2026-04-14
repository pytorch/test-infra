from __future__ import annotations

import json
import logging

from utils import jwt_helper
from utils.config import get_config
from utils.misc import HTTPException, JSON_HEADERS, parse_lambda_event

from . import result_handler

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger(__name__)


def lambda_handler(event, context):
    method, path, body_bytes, headers = parse_lambda_event(event)

    logger.info("request method=%s path=%s", method, path)

    if method != "POST" or path != "/github/result":
        if path == "/github/result":
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

        # OIDC is the only identity check Relay performs.  The callback body is
        # passed through to HUD untouched — HUD owns schema/business validation.
        # Relay reports the OIDC-verified repo to HUD separately as
        # `authenticated_repo` so HUD has a trusted source of truth for the
        # caller's identity.
        oidc_claims = jwt_helper.verify_oidc_token(
            config, headers.get("authorization", "")
        )
        verified_repo = oidc_claims["repository"]

        result = result_handler.handle(config, body, verified_repo)
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
