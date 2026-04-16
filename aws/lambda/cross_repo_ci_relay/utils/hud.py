import json
import logging
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

    Error handling splits by responsibility:

    - HUD 4xx (schema/validation errors, i.e. the caller's fault) is propagated
      back to the downstream workflow so the workflow author sees a red CI
      step and can fix their payload.
    - HUD 5xx and network-level failures (HUD's own problem or infra) are
      logged loudly but swallowed.  The callback channel is observational —
      letting HUD outages turn every downstream L2 CI red would blame the
      wrong team.  CloudWatch logs and alarms on ``HUD forward failed`` are
      the intended operator signal here.
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
            "Authorization": config.hud_bot_key,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            logger.info("HUD forward succeeded status=%d", resp.status)
    except urllib.error.HTTPError as exc:
        if 400 <= exc.code < 500:
            detail = f"HUD rejected callback: HTTP {exc.code}: {exc.reason}"
            logger.warning("HUD forward failed (client error): %s", detail)
            raise HTTPException(exc.code, detail) from exc
        # 5xx — HUD's own problem, don't propagate.
        logger.exception(
            "HUD forward failed (server error), swallowing: HTTP %d %s",
            exc.code,
            exc.reason,
        )
    except urllib.error.URLError as exc:
        # Network-level failure (DNS, timeout, connection refused).  Treated
        # as infrastructure rather than caller error — same as 5xx.
        logger.exception("HUD forward failed (unreachable), swallowing: %s", exc.reason)
