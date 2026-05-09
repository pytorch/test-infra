import json
import logging
import time
import urllib.error
import urllib.request

from .config import RelayConfig
from .misc import HTTPException


logger = logging.getLogger(__name__)


def forward_to_hud(config: RelayConfig, trusted: dict, untrusted: dict) -> None:
    """POST a callback record to HUD.

    This function splits inputs into two explicit namespaces:

    - ``trusted``: a dict supplied by this relay and therefore considered
      authoritative.
    - ``untrusted``: a dict forwarded from the downstream workflow and treated as
      untrusted user-supplied data.

    Retry Behavior:
        On server errors (HTTP 5xx) or network failures (URLError), the request
        is retried up to ``config.hud_max_retries`` times with exponential backoff
        (1s, 2s, 4s, ...). Client errors (HTTP 4xx) are not retried and raise
        HTTPException immediately.
    """
    if not config.hud_api_url:
        # No HUD configured (e.g. local dev before HUD endpoint exists) —
        # log and no-op rather than 500.  Remove this branch once HUD is
        # mandatory in every environment.
        logger.info("HUD_API_URL not configured, skipping HUD write")
        return

    hud_payload = json.dumps(
        {
            "trusted": trusted,
            "untrusted": untrusted,
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        config.hud_api_url,
        data=hud_payload,
        headers={
            "Content-Type": "application/json",
            "X-OOT-Relay-Token": config.hud_bot_key,
        },
        method="POST",
    )

    last_exception = None
    for attempt in range(config.hud_max_retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                logger.info("HUD forward succeeded status=%d", resp.status)
                return
        except urllib.error.HTTPError as exc:
            if 400 <= exc.code < 500:
                detail = f"HUD rejected callback: HTTP {exc.code}: {exc.reason}"
                logger.warning("HUD forward failed (client error): %s", detail)
                raise HTTPException(exc.code, detail) from exc
            last_exception = exc
            logger.warning(
                "HUD forward failed (server error, attempt %d/%d): HTTP %d %s",
                attempt + 1,
                config.hud_max_retries + 1,
                exc.code,
                exc.reason,
            )
        except urllib.error.URLError as exc:
            last_exception = exc
            logger.warning(
                "HUD forward failed (unreachable, attempt %d/%d): %s",
                attempt + 1,
                config.hud_max_retries + 1,
                exc.reason,
            )

        # If we have more retries remaining, wait with exponential backoff
        if attempt < config.hud_max_retries:
            delay = 2**attempt
            logger.info("Retrying HUD forward in %d seconds...", delay)
            time.sleep(delay)

    # All retries exhausted, raise the last exception
    if isinstance(last_exception, urllib.error.HTTPError):
        logger.exception(
            "HUD forward failed after %d attempts: HTTP %d %s",
            config.hud_max_retries + 1,
            last_exception.code,
            last_exception.reason,
        )
        raise HTTPException(
            500,
            "An internal failure occurred. "
            "Your update was not saved, but the CI run is still valid. "
            "You can attempt progressive retries after "
            f"{60 // config.rate_limit_per_min} seconds or ignore this failure.",
        ) from last_exception
    else:
        logger.exception(
            "HUD forward failed after %d attempts: %s",
            config.hud_max_retries + 1,
            last_exception.reason,
        )
        raise last_exception
