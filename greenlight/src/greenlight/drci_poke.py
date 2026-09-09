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

The poke swallows every failure. By the time it runs the merge gate has already fired and the state
row is uploaded, so a failure has nothing left to protect: raising would only turn the job that
gates auto-landing red over a cosmetic refresh, and the scheduled sweep still backstops a lost poke.
``IterationTimeout`` is carved out of that anyway, so the swallow stays a policy about poke failures
rather than about anything a caller might raise through it: it is a per-iteration watchdog signal,
and only its own caller can decide whether to abort on one. No current caller can deliver it here --
the scan pokes from a pool worker, which SIGALRM never reaches, and the ``drci-poke`` subcommand
runs outside the iteration guards entirely -- so the carve-out costs nothing and holds if either
moves back onto a guarded main thread.

A caller that cannot afford to wait on any of that pokes through ``poke_submitter`` instead: a seam
that hands each poke to a thread pool and returns immediately. The pool stays the caller's -- so does
the drain that makes ``POKE_WORKERS`` bound the worst case -- and the submitter only wraps it.
"""

from __future__ import annotations

import functools
import logging
import time
from typing import TYPE_CHECKING
from urllib.parse import urlencode

from greenlight.constants import DRCI_ENDPOINT
from greenlight.guards import IterationTimeout

if TYPE_CHECKING:
    from collections.abc import Callable
    from concurrent.futures import Future, ThreadPoolExecutor

    from greenlight.config import Config

__all__ = ["POKE_WORKERS", "poke", "poke_submitter"]

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

# Width, not a rate limit, and it does not need to be one: the scan submits at most one poke per
# dispatch and a dispatch costs 3-8s of serial main-thread work, so steady-state concurrency against
# the shared Dr. CI endpoint is about one. All 8 slots fill only when the endpoint is already
# answering slower than the scan dispatches -- exactly when width earns its keep, because the pool is
# drained before the scan returns and its width is what bounds that drain: a hung endpoint holds the
# scan open for ceil(queued / workers) rounds of the timeouts above.
POKE_WORKERS = 8


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

    Logs and swallows every failure, including a non-2xx response. ``IterationTimeout`` is excluded
    from that: it belongs to the caller's watchdog, not to the poke. Neither current call path can
    raise one here (see the module docstring).
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
    except IterationTimeout:
        raise
    except Exception as exc:
        logger.error("Dr. CI poke for %s#%d failed: %s", repo, pr_number, exc, exc_info=True)
        return
    if status in _SUCCESS_STATUSES:
        logger.info("poked Dr. CI for %s#%d (HTTP %d)", repo, pr_number, status)
    else:
        # An auth failure answers 500, not 403 -- the endpoint's auth branch sits outside its
        # try/catch -- so the status code cannot classify the failure. Log it and move on.
        logger.error("Dr. CI poke for %s#%d returned HTTP %d", repo, pr_number, status)


def _log_poke_outcome(pr_number: int, future: Future[None]) -> None:
    # Unlike asyncio, concurrent.futures never reports an unretrieved exception; a poke that fails
    # somewhere poke does not already log would otherwise leave no trace at all.
    error = future.exception()
    if error is not None:
        logger.error("Dr. CI poke for PR #%d failed: %s", pr_number, error, exc_info=error)


def poke_submitter(
    pool: ThreadPoolExecutor, repo: str, poke_drci: Callable[[str, int, Config], None], config: Config
) -> Callable[[int], None]:
    """Build the scan's poke seam: hand each poke to ``pool`` and return without waiting for it.

    Off the main thread a poke is out of ``guards.iteration_timeout``'s reach -- SIGALRM is delivered
    to the main thread only -- and the pool is drained on the way out, so an unresponsive endpoint
    overruns the deadline by however long the whole queue takes to clear: ceil(queued / workers)
    rounds of the connect plus read timeout, not one poke's. Every local path pays that;
    ``runner._bounded_iteration`` arms both guards for ``execute_once`` as well as ``run_forever``.
    Only the Lambda escapes it, by setting the max runtime to zero.
    """

    def submit(pr_number: int) -> None:
        try:
            future = pool.submit(poke_drci, repo, pr_number, config)
        except IterationTimeout:
            # submit runs on the main thread, so the scan's own deadline can fire inside it, and
            # IterationTimeout subclasses TimeoutError -> OSError -> Exception. Absorbed below as a
            # scheduling failure it would leave the iteration running with its one-shot SIGALRM
            # already spent -- no soft deadline left, and nothing to show the watchdog signal fired.
            raise
        except Exception as exc:
            # Both callers invoke this seam outside their own try blocks, which is safe only because
            # poke swallows everything. submit does not -- a shut-down pool, or a worker thread that
            # will not start, raises -- and an escape here would halt the scan mid-loop over a
            # cosmetic refresh.
            logger.error("failed to schedule Dr. CI poke for PR #%d: %s", pr_number, exc, exc_info=True)
            return
        future.add_done_callback(functools.partial(_log_poke_outcome, pr_number))

    return submit
