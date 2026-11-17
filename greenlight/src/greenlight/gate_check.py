"""``greenlight gate-check``: the merge gate's check, run by ``.github/workflows/greenlight-gate.yml``.

It holds while a live GreenLight approval stands on a commit other than the PR's head (``approvals.gate_decision``)
and passes as soon as none does. It polls with backoff until the deadline; any failed check counts as a hold, so
it never passes on an error. A PR still closed when re-read ``GATE_SUPERSEDED_RECHECK`` seconds later is
superseded. One open on another head holds, polling as before, and is superseded once every read for
``GATE_SUPERSEDED_AFTER`` seconds has found it there, since a read can lag the push that started this run; a read
on the given head ends the wait. A superseded run fails: the run of the PR's current head gates it.
"""

from __future__ import annotations

import itertools
import logging
import re
import sys
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

from greenlight import github_client, repo_config
from greenlight.approvals import GateDecision, PullFacts, ReviewReader, gate_decision
from greenlight.config import Config
from greenlight.constants import (
    GATE_POLL_DELAYS,
    GATE_SUPERSEDED_AFTER,
    GATE_SUPERSEDED_RECHECK,
    GATE_TIMEOUT_MINUTES_DEFAULT,
    GATE_TIMEOUT_MINUTES_MAX,
    validate_head_sha,
)
from greenlight.exit_codes import EXIT_FAILURE, EXIT_OK
from greenlight.log import configure_logging

if TYPE_CHECKING:
    import argparse
    from collections.abc import Callable, Iterator, Mapping

    from github import Github

logger = logging.getLogger(__name__)

_DIGITS = re.compile(r"[0-9]+")


@dataclass(frozen=True)
class GateTarget:
    repo: str
    pr: int
    head_sha: str
    timeout_minutes: int


@dataclass(frozen=True)
class _Off:
    """A read that found the PR closed, after its recheck, or open on a head other than the target's."""

    facts: PullFacts


@dataclass(frozen=True)
class _Failed:
    """A check that failed; ``on_head`` when its read of the PR found it open on the target head first."""

    on_head: bool


def _positive(value: str, what: str, maximum: int | None = None) -> int:
    if not _DIGITS.fullmatch(value) or int(value) < 1:
        raise ValueError(f"{what} must be a positive integer, got {value!r}")
    number = int(value)
    if maximum is not None and number > maximum:
        raise ValueError(f"{what} must be at most {maximum}, got {number}")
    return number


def parse_target(repo: str, pr: str, head_sha: str, timeout_minutes: str) -> GateTarget:
    """The validated inputs; ``ValueError`` when any is not acceptable."""
    if not repo_config.REPO_NAME.fullmatch(repo) or repo.partition("/")[2] in (".", ".."):
        raise ValueError(f"repo must name a pytorch/<name> repository, got {repo!r}")
    validate_head_sha(head_sha)
    return GateTarget(
        repo=repo,
        pr=_positive(pr, "pr"),
        head_sha=head_sha,
        timeout_minutes=_positive(timeout_minutes, "timeout-minutes", GATE_TIMEOUT_MINUTES_MAX),
    )


def _delays() -> Iterator[int]:
    return itertools.chain(GATE_POLL_DELAYS, itertools.repeat(GATE_POLL_DELAYS[-1]))


def _check(reader: ReviewReader, target: GateTarget, recheck: Callable[[], None]) -> GateDecision | _Off | _Failed:
    on_head = False
    try:
        facts = reader.pull(target.repo, target.pr)
        if not facts.is_open:
            logger.info("%s#%d reads %s; re-reading it", target.repo, target.pr, facts.state)
            recheck()
            facts = reader.pull(target.repo, target.pr)
        if not facts.is_open or facts.head_sha.lower() != target.head_sha.lower():
            return _Off(facts)
        on_head = True
        return gate_decision(reader.reviews(target.repo, target.pr), target.head_sha)
    except Exception:
        logger.error("gate check of %s#%d failed; holding", target.repo, target.pr, exc_info=True)
        return _Failed(on_head)


def _superseded(target: GateTarget, facts: PullFacts) -> int:
    logger.error(
        "superseded: %s#%d is %s at head %s, not open at %s; the gate of its current head decides",
        target.repo,
        target.pr,
        facts.state,
        facts.head_sha,
        target.head_sha,
    )
    return EXIT_FAILURE


def wait_for_gate(
    reader: ReviewReader,
    target: GateTarget,
    *,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> int:
    """Check until the gate passes, the PR is superseded, or the deadline's final check still holds.

    No wait, the closed PR's recheck included, runs past the deadline.
    """
    deadline = monotonic() + target.timeout_minutes * 60
    delays = _delays()
    moved_since: float | None = None

    def recheck() -> None:
        sleep(min(GATE_SUPERSEDED_RECHECK, max(0.0, deadline - monotonic())))

    while True:
        outcome = _check(reader, target, recheck)
        held: str | None = None
        if isinstance(outcome, _Off):
            if not outcome.facts.is_open:
                return _superseded(target, outcome.facts)
            read_at = monotonic()
            moved_since = read_at if moved_since is None else moved_since
            if read_at - moved_since >= GATE_SUPERSEDED_AFTER:
                return _superseded(target, outcome.facts)
            held = f"it reads at head {outcome.facts.head_sha}, not {target.head_sha}"
        elif isinstance(outcome, _Failed):
            if outcome.on_head:
                moved_since = None
        else:
            moved_since = None
            if outcome.passes:
                logger.info("gate passes for %s#%d: %s", target.repo, target.pr, outcome.reason)
                return EXIT_OK
            held = outcome.reason
        if held is not None:
            logger.info("gate holds for %s#%d: %s", target.repo, target.pr, held)
        remaining = deadline - monotonic()
        if remaining <= 0:
            held = "the last check failed" if held is None else held
            logger.error(
                "gate still holds for %s#%d after %d minutes: %s",
                target.repo,
                target.pr,
                target.timeout_minutes,
                held,
            )
            return EXIT_FAILURE
        sleep(min(next(delays), remaining))


def add_parser(subparsers: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    parser = subparsers.add_parser(
        "gate-check",
        help="hold while a GreenLight approval stands on a commit other than the PR's head",
        description=(
            "The merge gate's check: poll the PR's reviews until no live GreenLight approval stands on a commit "
            "other than --head-sha (exit 0), the PR is closed or stays on another head (exit 1), or the timeout "
            "ends with the approval still standing (exit 1). Any failed check holds. Requires "
            "PYTORCH_GREENLIGHT_GITHUB_TOKEN with pull-request read access."
        ),
    )
    parser.add_argument("--repo", required=True, help="owner/name of the repository")
    parser.add_argument("--pr", required=True, help="pull-request number")
    parser.add_argument("--head-sha", required=True, help="the PR head commit the gate runs for")
    parser.add_argument(
        "--timeout-minutes",
        default=str(GATE_TIMEOUT_MINUTES_DEFAULT),
        help=f"minutes to hold before failing, 1 to {GATE_TIMEOUT_MINUTES_MAX}",
    )


def run(
    args: argparse.Namespace,
    *,
    env: Mapping[str, str] | None = None,
    build_github: Callable[[str], Github] = github_client.build_client,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> int:
    try:
        target = parse_target(args.repo, args.pr, args.head_sha, args.timeout_minutes)
        config = Config.from_env(env)
        configure_logging(config.log_level)
    except ValueError as exc:
        sys.stderr.write(f"greenlight gate-check: {exc}\n")
        return EXIT_FAILURE
    if config.github_token is None:
        sys.stderr.write("greenlight gate-check: PYTORCH_GREENLIGHT_GITHUB_TOKEN is required\n")
        return EXIT_FAILURE
    client = build_github(config.github_token)
    try:
        return wait_for_gate(ReviewReader(client.requester), target, sleep=sleep, monotonic=monotonic)
    finally:
        github_client.close_client(client)
