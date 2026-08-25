"""Ask Dr. CI to rebuild one pull request's comment so a fresh greenlight state shows up promptly.

On the repositories that delegate their status comment to Dr. CI
(``constants.delegates_status_comment_to_drci``) greenlight posts no status comment of its own;
Dr. CI renders the recorded state inside its comment instead. That comment is otherwise only
rebuilt by a scheduled 15-minute sweep, and the probot handler blanks its results section on every
push, so without this poke a just-pushed or just-reviewed PR shows nothing for up to a quarter of
an hour.

Dr. CI reads the state from ClickHouse, which is fed by the S3 -> replicator path the caller has
only just written to, hence the configurable pre-POST delay: poking before the row is ingested
re-renders the comment from the state the poke was meant to replace.

The poke never raises. By the time it runs the merge gate has already fired and the state row is
uploaded, so a failure has nothing left to protect: raising would only turn the job that gates
auto-landing red over a cosmetic refresh, and the scheduled sweep still backstops a lost poke.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING
from urllib.parse import urlencode

from greenlight.constants import DRCI_ENDPOINT

if TYPE_CHECKING:
    from collections.abc import Callable

    from greenlight.config import Config

__all__ = ["poke"]

logger = logging.getLogger(__name__)

_FORM_CONTENT_TYPE = "application/x-www-form-urlencoded"
# Dr. CI authenticates on a raw token, not a bearer credential: prefixing "Bearer " fails auth.
_AUTHORIZATION_HEADER = "Authorization"
# Not an endpoint credential -- Dr. CI authenticates on Authorization alone. This rides along to
# clear HUD's bot challenge, the same pairing update-drci-comments.yml's curl already sends.
_INTERNAL_BOT_HEADER = "x-hud-internal-bot"

# A single-PR rebuild is a few seconds of work; these bound the worst case to well under a minute
# so a hung endpoint cannot eat a meaningful share of the 15-minute job this runs inside.
_CONNECT_TIMEOUT_SECONDS = 10.0
_READ_TIMEOUT_SECONDS = 30.0

_SUCCESS_STATUSES: frozenset[int] = frozenset(range(200, 300))


def _default_post(url: str, body: bytes, headers: dict[str, str]) -> int:
    import urllib3

    # No retries: the worst case has to stay a small predictable slice of the calling job's budget,
    # and Dr. CI's scheduled sweep already rebuilds the comment when a single attempt is lost.
    timeout = urllib3.Timeout(connect=_CONNECT_TIMEOUT_SECONDS, read=_READ_TIMEOUT_SECONDS)
    with urllib3.PoolManager(timeout=timeout, retries=False) as http:
        return http.request("POST", url, body=body, headers=headers).status


def poke(
    repo: str,
    pr_number: int,
    config: Config,
    *,
    sleep: Callable[[float], None] = time.sleep,
    post: Callable[[str, bytes, dict[str, str]], int] = _default_post,
) -> None:
    """Wait out the ingestion delay, then POST one refresh request for ``repo``#``pr_number``.

    Logs and swallows every failure, including a non-2xx response.
    """
    org, _, name = repo.partition("/")
    if not org or not name:
        logger.error("cannot poke Dr. CI: repo %r is not in owner/name form", repo)
        return
    token = config.drci_token
    if not token:
        logger.warning("no Dr. CI token configured; skipping Dr. CI poke for %s#%d", repo, pr_number)
        return
    # prNumber MUST travel in the query string. Sent in the body it is invisible to the endpoint,
    # which then falls back to sweeping every open PR in the repo -- a ~900s job.
    url = f"{DRCI_ENDPOINT}?{urlencode({'prNumber': pr_number})}"
    # The endpoint wants the bare repo name and its org as separate fields, never "owner/name".
    body = urlencode({"repo": name, "org": org}).encode("utf-8")
    headers = {"Content-Type": _FORM_CONTENT_TYPE, _AUTHORIZATION_HEADER: token}
    if config.drci_internal_token:
        headers[_INTERNAL_BOT_HEADER] = config.drci_internal_token
    delay = config.drci_poke_delay_seconds
    try:
        if delay > 0:
            logger.info("waiting %ss for state ingestion before poking Dr. CI for %s#%d", delay, repo, pr_number)
            sleep(delay)
        status = post(url, body, headers)
    except Exception as exc:
        logger.error("Dr. CI poke for %s#%d failed: %s", repo, pr_number, exc, exc_info=True)
        return
    if status in _SUCCESS_STATUSES:
        logger.info("poked Dr. CI for %s#%d (HTTP %d)", repo, pr_number, status)
    else:
        # An auth failure answers 500, not 403 -- the endpoint's auth branch sits outside its
        # try/catch -- so the status code cannot classify the failure. Log it and move on.
        logger.error("Dr. CI poke for %s#%d returned HTTP %d", repo, pr_number, status)
