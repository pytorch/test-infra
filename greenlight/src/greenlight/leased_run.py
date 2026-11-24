"""The steps a scan Lambda invocation takes around one repo's ``tick.RepoRun`` under that repo's lease.

The planner (``fanout``) runs pytorch/pytorch's and each worker (``worker``) its repo's through them:

- ``mint`` the repo token (None, recorded as the repo's error, when it cannot be had; the installation's
  quota is read with it from then on) and the dispatch token (None, recorded, when it cannot be had: the
  run then does its safety work only);
- ``repo_run`` builds the run on those tokens;
- ``keep_memory`` saves the run's memory under the lease with the tick (``scan_memory.save_memory``, which
  the CLI's scan calls with no lease and no tick);
- ``release`` gives the lease back;
- ``record_latch`` extends the store's shared latch by any rate limit the invocation met.

A store failure in any of them is logged with its traceback and recorded: as the repo's error, or the
invocation's for the latch; ``release`` returns it for its caller to record.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

from greenlight.scan_memory import save_memory
from greenlight.state_store import StoreError
from greenlight.tick import RepoRun, run_config

if TYPE_CHECKING:
    from greenlight.app_tokens import AppTokens
    from greenlight.config import Config
    from greenlight.repo_config import RepoEntry
    from greenlight.scan_memory import ScanMemory
    from greenlight.state_store import StateStore
    from greenlight.tick import Invocation

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Minted:
    """A repo's token, and the dispatch token (None when it could not be had)."""

    repo: str
    dispatch: str | None


@dataclass(frozen=True)
class RunOptions:
    """What every run of an invocation is built with."""

    config: Config
    store: StateStore
    bot_login: str
    ref: str
    timeout_minutes: int


def mint(invocation: Invocation, tokens: AppTokens, repo: str) -> Minted | None:
    """``repo``'s token and the dispatch token; None when ``repo``'s token cannot be had."""
    token = invocation.outcomes.result(repo, "its token", lambda: tokens.repo_token(repo))
    if token is None:
        return None
    invocation.watch_quota(token)
    return Minted(token, invocation.outcomes.result(repo, "the dispatch token", tokens.dispatch_token))


def repo_run(
    invocation: Invocation,
    options: RunOptions,
    minted: Minted,
    entry: RepoEntry,
    *,
    served: bool,
    memory: ScanMemory,
    max_dispatches: int | None,
) -> RepoRun:
    """``entry``'s run on ``minted``'s tokens."""
    return RepoRun(
        invocation,
        run_config(options.config, minted.repo, minted.dispatch),
        entry,
        served,
        memory,
        options.store,
        options.bot_login,
        max_dispatches,
        options.ref,
        options.timeout_minutes,
    )


def keep_memory(
    invocation: Invocation, store: StateStore, repo: str, memory: ScanMemory, *, owner: str, tick: str
) -> None:
    """Save ``repo``'s memory under ``owner``'s lease with ``tick`` completed; a failure is the repo's error."""
    try:
        save_memory(store, repo, memory, owner=owner, now=invocation.seams.clock(), tick=tick)
    except StoreError as exc:
        logger.error("%s: cannot save its memory", repo, exc_info=True)
        invocation.outcomes.error(repo, f"its memory could not be saved: {exc}")


def release(store: StateStore, repo: str, owner: str) -> str | None:
    """Give ``owner``'s lease of ``repo`` back; the problem, logged, when the store failed."""
    try:
        if not store.release_lease(repo, owner):
            logger.warning("%s: its lease was no longer held at release", repo)
    except StoreError as exc:
        logger.error("%s: cannot release its lease", repo, exc_info=True)
        return f"its lease could not be released: {exc}"
    return None


def record_latch(invocation: Invocation, store: StateStore) -> None:
    """Extend the shared latch by the invocation's own; a failure is the invocation's error."""
    until = invocation.meter.latch.until
    if until is None:
        return
    try:
        store.extend_latch(until, invocation.seams.clock())
    except StoreError as exc:
        logger.error("cannot record the shared rate-limit latch", exc_info=True)
        invocation.outcomes.problem(f"the state store failed recording the rate-limit latch: {exc}")
