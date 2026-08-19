"""Coverage dispatch core — targets /flaky_trunk UNCLASSIFIED reds.

Enumerates currently-unclassified trunk reds (isolated non-persistent reds with
no attaching advisor verdict) for a time window, and dispatches the AI advisor
workflow keyed to the OBSERVED trunk commit, with a `coverage_`-prefixed
signal_key. The prefix keeps these verdicts out of autorevert's exact-match
read-back, so they populate /flaky_trunk without ever driving a revert/veto.

Writes NOTHING to ClickHouse or S3 — it only READS ClickHouse (enumeration +
windowless dedup), HEAD-checks S3 logs, and POSTs workflow_dispatch.
"""

from __future__ import annotations

import dataclasses
import logging
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, List, Optional, Set, Tuple

from pytorch_auto_revert.clickhouse_client_helper import CHCliFactory
from pytorch_auto_revert.github_client_helper import GHClientFactory
from pytorch_auto_revert.utils import proper_workflow_create_dispatch, RetryWithBackoff

from .config import ADVISOR_WORKFLOW_FILE, COVERAGE_SIGNAL_KEY_PREFIX, CoverageConfig
from .enumeration import _naive_utc, RedSignal, UnclassifiedRedEnumerator
from .logfilter import has_readable_log
from .payload import build_isolated_red_payload, coverage_signal_key


log = logging.getLogger(__name__)


def _in_emit_window(ts: Optional[datetime], start: datetime, stop: datetime) -> bool:
    """True if `ts` is in [start, stop). Missing timestamps are kept."""
    if ts is None:
        return True
    return _naive_utc(start) <= _naive_utc(ts) < _naive_utc(stop)


@dataclass
class DispatchStats:
    """Per-window accounting, aggregated across a run."""

    window_start: Optional[str] = None
    window_stop: Optional[str] = None
    eligible: int = 0
    skipped_existing: int = 0
    skipped_duplicate: int = 0
    skipped_no_log: int = 0
    dispatched: int = 0  # successful real dispatches only (never counts dry-run)
    would_dispatch: int = 0  # dry-run: reds that WOULD have been POSTed, not real
    errors: int = 0
    capped: bool = False

    def as_dict(self) -> dict:
        return dataclasses.asdict(self)


class CoverageDispatcher:
    """Enumerate unclassified reds → filter → dispatch coverage advisors."""

    def __init__(
        self,
        config: CoverageConfig,
        *,
        sleep: Callable[[float], None] = time.sleep,
        log_check: Callable[[int], bool] = has_readable_log,
    ) -> None:
        self.config = config
        self._sleep = sleep
        self._log_check = log_check
        self._enumerator = UnclassifiedRedEnumerator(config)
        self._remaining: Optional[int] = None  # None = unlimited (local backfill)
        self._attempts_total = 0
        self._success_total = 0
        self._would_dispatch_total = 0
        self._dispatched_keys: Set[Tuple[str, str]] = set()
        self._workflow: Any = None

    # ------------------------------------------------------------------
    # Run-state management (spans all windows within one invocation)
    # ------------------------------------------------------------------
    @property
    def remaining(self) -> Optional[int]:
        return self._remaining

    @property
    def success_total(self) -> int:
        return self._success_total

    @property
    def would_dispatch_total(self) -> int:
        return self._would_dispatch_total

    @property
    def attempts_total(self) -> int:
        return self._attempts_total

    def begin_run(self, limit: Optional[int]) -> None:
        """Reset the shared dispatch budget + intra-run dedup for one invocation.

        `limit=None` means unlimited (local full backfill — only the gap throttle
        applies). The intra-run dedup set is reset here so a red seen in more than
        one window within one invocation is dispatched once.
        """
        self._remaining = limit
        self._attempts_total = 0
        self._success_total = 0
        self._would_dispatch_total = 0
        self._dispatched_keys = set()

    def _budget_exhausted(self) -> bool:
        return self._remaining is not None and self._remaining <= 0

    # ------------------------------------------------------------------
    # Core
    # ------------------------------------------------------------------
    def dispatch_for_window(
        self,
        enum_start: datetime,
        enum_stop: datetime,
        *,
        emit_start: Optional[datetime] = None,
        emit_stop: Optional[datetime] = None,
        deadline: Optional[float] = None,
    ) -> DispatchStats:
        """Enumerate reds in [enum_start, enum_stop); dispatch those in the emit
        window [emit_start, emit_stop).

        The enum window is widened past the emit window (persistence margin) so
        the SQL lag/lead check sees reds' neighbouring trunk commits; only reds
        inside the emit window are dispatched. `deadline` (a time.monotonic()
        value) bounds per-window work so slow log HEADs can't push the
        invocation past the Lambda timeout — hitting it caps the window (treated
        like a budget cap so a backfill chunk resumes without loss).
        """
        emit_start = emit_start if emit_start is not None else enum_start
        emit_stop = emit_stop if emit_stop is not None else enum_stop
        stats = DispatchStats(
            window_start=emit_start.isoformat(), window_stop=emit_stop.isoformat()
        )
        reds = [
            r
            for r in self._enumerator.enumerate(enum_start, enum_stop)
            if _in_emit_window(r.commit_time, emit_start, emit_stop)
        ]
        stats.eligible = len(reds)
        existing = self._existing_verdicts(reds)
        gap = self.config.effective_gap_seconds()
        log.info(
            "[coverage] emit=[%s,%s): %d unclassified reds, %d already covered "
            "(remaining budget=%s)",
            stats.window_start,
            stats.window_stop,
            len(reds),
            len(existing),
            "unlimited" if self._remaining is None else self._remaining,
        )

        for red in self._ordered(reds):
            if self._budget_exhausted():
                stats.capped = True
                break
            if deadline is not None and time.monotonic() >= deadline:
                stats.capped = True
                break

            prefixed_key = coverage_signal_key(red)
            # Never POST a verdict on a native key — the prefix is the only thing
            # isolating coverage from autorevert's revert path.
            if not (
                prefixed_key.startswith(COVERAGE_SIGNAL_KEY_PREFIX)
                and prefixed_key != red.job_name
            ):
                stats.errors += 1
                log.error(
                    "[coverage] refusing to dispatch: prefixed_key=%r not safely "
                    "prefixed vs native key=%r",
                    prefixed_key,
                    red.job_name,
                )
                continue

            # Symmetric with _existing_verdicts, which strips the CH side.
            cell = (red.observed_commit.strip(), prefixed_key)
            if cell in existing:
                stats.skipped_existing += 1
                continue
            if cell in self._dispatched_keys:
                stats.skipped_duplicate += 1
                continue

            if not self._log_check(red.suspect.job_id):
                # Stub/missing log — skip without consuming the dispatch budget.
                self._dispatched_keys.add(cell)
                stats.skipped_no_log += 1
                continue

            payload_json = build_isolated_red_payload(red, self.config.repo_full_name)

            if self._attempts_total > 0:
                self._sleep(gap)

            self._dispatched_keys.add(cell)
            try:
                self._dispatch_one(
                    observed_commit=red.observed_commit,
                    payload_json=payload_json,
                    red=red,
                    prefixed_key=prefixed_key,
                )
                if self.config.dry_run:
                    # _dispatch_one POSTed nothing -- not a real dispatch.
                    stats.would_dispatch += 1
                    self._would_dispatch_total += 1
                else:
                    stats.dispatched += 1
                    self._success_total += 1
            except Exception:
                stats.errors += 1
                log.exception(
                    "[coverage] dispatch failed: suspect=%s key=%s",
                    red.observed_commit[:8],
                    prefixed_key,
                )
            finally:
                if self._remaining is not None:
                    self._remaining -= 1
                self._attempts_total += 1

        return stats

    def _ordered(self, reds: List[RedSignal]) -> List[RedSignal]:
        """Deterministic order → capped runs make forward progress across runs."""
        return sorted(
            reds,
            key=lambda r: (r.workflow_name, r.job_name, r.observed_commit),
        )

    def _existing_verdicts(self, reds: List[RedSignal]) -> Set[Tuple[str, str]]:
        """Windowless batch dedup: one query for all (observed_commit, key) cells.

        No time filter — a coverage verdict from any prior run must dedup a
        re-enumeration at any later time (the verdict is written asynchronously by
        the advisor workflow and stays valid indefinitely).
        """
        if not reds:
            return set()
        shas = sorted({r.observed_commit for r in reds})
        keys = sorted({coverage_signal_key(r) for r in reds})
        query = (
            "SELECT toString(suspect_commit) AS suspect_commit, signal_key "
            "FROM misc.autorevert_advisor_verdicts "
            "WHERE repo = {repo:String} "
            "AND suspect_commit IN {shas:Array(String)} "
            "AND signal_key IN {keys:Array(String)}"
        )
        params = {"repo": self.config.repo_full_name, "shas": shas, "keys": keys}
        for attempt in RetryWithBackoff():
            with attempt:
                res = CHCliFactory().client.query(query, parameters=params)
                return {(str(row[0]).strip(), str(row[1])) for row in res.result_rows}

    def _dispatch_one(
        self,
        *,
        observed_commit: str,
        payload_json: str,
        red: RedSignal,
        prefixed_key: str,
    ) -> None:
        """POST the advisor workflow_dispatch, or log the intent in dry-run.

        pr_number is 0 — the advisor gets the diff from the workflow's own
        checkout of suspect_commit, so no PR-read scope is needed on our token.
        """
        if self.config.dry_run:
            log.info(
                "[coverage][dry-run] would dispatch advisor: wf=%s key=%s "
                "suspect=%s payload=%s",
                red.workflow_name,
                prefixed_key,
                observed_commit[:8],
                payload_json,
            )
            return

        workflow = self._advisor_workflow()
        factory = GHClientFactory()
        # /dispatches is non-idempotent — single attempt via the retry=0
        # dispatch client so a 5xx-after-accept does not spawn duplicate runs.
        proper_workflow_create_dispatch(
            workflow,
            ref="main",
            inputs={
                "suspect_commit": observed_commit,
                "pr_number": "0",
                "signal_pattern": payload_json,
            },
            requester=factory.dispatch_client.requester,
        )
        log.info(
            "[coverage] dispatched advisor: wf=%s key=%s suspect=%s",
            red.workflow_name,
            prefixed_key,
            observed_commit[:8],
        )

    def _advisor_workflow(self) -> Any:
        """Fetch the advisor workflow handle once per run (memoized)."""
        if self._workflow is None:
            repo = GHClientFactory().client.get_repo(self.config.repo_full_name)
            self._workflow = repo.get_workflow(ADVISOR_WORKFLOW_FILE)
        return self._workflow
