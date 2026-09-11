"""Pre-merge trunk-gate classification for a merged commit's test signal.

`premerge_status` vocabulary (all sourced from premerge_status.py):
  RUN_SUCCEEDED         test ran on the validated pre-merge head and passed
  RUN_FAILED            test ran and at least one shard failed ("merged despite red")
  NOT_RUN:force_merge   real force merge (skip_mandatory_checks) AND the test did not run
  NOT_RUN:skipped       test ran but every run was skipped
  NOT_RUN:td_excluded   no pre-merge result AND the file was TD-excluded from a config where
                        it later FAILED on main (per-config), or from the flat artifact
  NOT_RUN:test_absent   no pre-merge result, but a failing config actually RAN in the pull
                        matrix with the file kept (drift: renamed/removed/param), NOT TD
  NOT_RUN:not_in_matrix no pre-merge result AND no failing config ran in the pull matrix
                        (trunk/CUDA/ROCm/mps-only), or no gate jobs ran on the head
  NOT_RUN:td_unknown    no pre-merge result and attribution unresolvable — no non-empty pull
                        artifact, no failing config on main, or the pull matrix is unknown
  NOT_RUN:no_merge_record  no default.merges row resolved a pre-merge head (ghstack non-tip,
                        revert, direct push, or data predating the table)
  ERROR                 a query failed after retries, or the merge timestamp is missing/epoch

RUN_SUCCEEDED requires a POSITIVE success-row observation; a real RUN_*/skipped verdict
always wins over force_merge. TD is PER-CONFIG: the same file can be excluded from one
(build_env, test_config) and kept in another, so a no-result test is td_excluded only when
excluded from a config where it FAILED on main. Matrix membership (test_absent vs
not_in_matrix) is read from the pull run's ACTUAL jobs (pull_configs), never the exclusion
artifact — which omits any config that excluded no files. Older runs emit a single flat
exclusion list (NoBuildEnv sentinel) with no config attribution; a file listed there is
td_excluded, and a mixed artifact's flat list is unioned into that check (see
premerge_classify._classify_no_result).
"""

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Callable, List, NamedTuple, Optional, Set, Tuple

from clickhouse_connect.driver import Client  # type: ignore[import-not-found]

from .client import run_query
from .premerge_classify import _classify_no_result, classify_counts
from .premerge_sql import (
    COMMIT_MSG_ONE_SQL,
    MERGE_HEAD_BY_PR_SQL,
    MERGE_HEAD_SQL,
    MERGE_TS_SQL,
    PREMERGE_JOBS_SQL,
    PREMERGE_TEST_SQL,
)
from .premerge_status import (
    PREMERGE_STATUS_ERROR,
    PREMERGE_STATUS_FORCE_MERGE,
    PREMERGE_STATUS_NO_MERGE_RECORD,
    PREMERGE_STATUS_NOT_IN_MATRIX,
)
from .queries import (
    fetch_failing_configs,
    FailingConfigs,
    fetch_pull_configs,
    fetch_pull_runs,
)
from .td_exclusions import ExclusionMap, fetch_exclusions


logger = logging.getLogger(__name__)

# Signature of the S3 per-config TD-exclusion fetcher, injected so tests stay offline.
ExclusionsFetcher = Callable[[int, int], Optional[ExclusionMap]]

LOOKBACK_DAYS = 30  # job created_at bound around the merge window
PARTITION_MARGIN_DAYS = 2  # extra skew buffer for tests.all_test_runs partition prune

_PR_RE = re.compile(r"\(#(\d+)\)")


def parse_pr_from_message(message: str) -> Optional[int]:
    """Parse the PR number from a squash-merge commit's TITLE (first line only).
    pytorchbot appends '(#NNNNN)' to the squashed commit title. The body may contain
    other '(#N)' refs (e.g. 'unblocked by (#176580)'), so ONLY the first line is parsed,
    taking the LAST '(#N)' on that line."""
    if not message:
        return None
    first_line = message.splitlines()[0]
    matches = _PR_RE.findall(first_line)
    if not matches:
        return None
    return int(matches[-1])


def _to_utc(value: datetime) -> datetime:
    """clickhouse_connect localizes NAIVE datetime params to the client's local zone,
    which shifts the server-side comparison (observed 7h). Always pass tz-aware UTC."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _is_force(value: object) -> bool:
    """default.merges.skip_mandatory_checks is Bool (the driver returns a Python bool),
    but treat int/string encodings as force too so a driver or schema change can't
    silently turn every merge non-force. A truthy value marks a `-f` force merge that
    bypassed the mandatory trunk-gate checks; note bool('false') is True, so the string
    branch must run before the generic bool() cast."""
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "t", "yes")
    return bool(value)


class PremergeContext(NamedTuple):
    """Per-commit pre-merge resolution shared across all of a commit's test signals.
    head_sha/merge_ts/job_ids/td_excluded/failing_configs/pull_configs depend only on the
    commit, so they are resolved once. A non-None terminal_reason short-circuits
    classification to that value for every signal of the commit without any further query.
    td_excluded is the pre-merge `pull` per-config TD-excluded map (None = unresolvable);
    failing_configs maps (file, name) to the (build_env, test_config) set where it failed on
    main; pull_configs is the (build_env, test_config) set that actually RAN in that pull run
    (empty = unknown), the sole source of pre-merge matrix membership."""

    head_sha: Optional[str]
    merge_ts: Optional[datetime]
    tlow: Optional[datetime]
    job_ids: List[int]
    force_merge: bool
    terminal_reason: Optional[str]
    td_excluded: Optional[ExclusionMap]
    failing_configs: FailingConfigs
    pull_configs: Set[Tuple[str, str]]


def _resolve_head_by_pr(
    client: Client,
    commit_sha: str,
    owner: str,
    project: str,
) -> Optional[Tuple[str, bool]]:
    """By-sha miss fallback: resolve the pre-merge head via the squashed title's (#PR).
    Returns (head_sha, force_merge) only when a SINGLE unambiguous head is found; None
    otherwise (no message, unparseable PR, a revert, or 0/>1 distinct heads).
    Reverts are excluded because a revert title's (#N) is the ORIGINAL reverted PR, so
    resolving by it would fetch the wrong PR's head and check the wrong test."""
    msg_rows = run_query(client, COMMIT_MSG_ONE_SQL, {"commit": commit_sha})
    message = msg_rows[0][0] if msg_rows and msg_rows[0][0] else ""
    if not message:
        return None
    first_line = message.splitlines()[0]
    if first_line.startswith("Revert ") or first_line.startswith("Back out "):
        return None
    pr = parse_pr_from_message(message)
    if pr is None:
        return None

    pr_rows = run_query(
        client,
        MERGE_HEAD_BY_PR_SQL,
        {"pr": pr, "owner": owner, "project": project},
    )
    heads = sorted({row[0] for row in pr_rows if row[0]})
    # Only recover a head when it is unambiguous: 0 or >1 distinct heads stay
    # no_merge_record — safer to under-attribute than to pick a wrong head.
    if len(heads) != 1:
        return None
    head_sha = heads[0]
    force_merge = any(_is_force(row[1]) for row in pr_rows if row[0] == head_sha)
    return head_sha, force_merge


def _resolve_td_excluded(
    client: Client,
    head_sha: str,
    fetch_exclusions_fn: ExclusionsFetcher,
) -> Tuple[Optional[ExclusionMap], Optional[Tuple[int, int]]]:
    """The pre-merge per-config TD-excluded map for head_sha's `pull` runs, plus the
    (run_id, run_attempt) it came from. Tries each pull run oldest-first and returns the
    FIRST non-empty artifact (the PR's original run holds the real exclusions; the
    merge-triggered rerun is empty), so matrix membership can be read from the SAME run.
    Returns (None, None) when no run yields a non-empty artifact — TD's decision is then
    unknown."""
    for run_id, run_attempt in fetch_pull_runs(client, head_sha):
        excluded = fetch_exclusions_fn(run_id, run_attempt)
        if excluded:
            return excluded, (run_id, run_attempt)
    return None, None


def resolve_premerge_context(
    client: Client,
    commit_sha: str,
    repo: str = "pytorch/pytorch",
    fetch_exclusions_fn: ExclusionsFetcher = fetch_exclusions,
) -> PremergeContext:
    """Resolve the per-commit pre-merge context (head, merge ts, gate jobs, force flag,
    per-config TD-excluded map, failing configs on main). All ClickHouse IO goes through
    run_query (retry wrapper). On any query exception after retries, returns a context with
    terminal_reason 'ERROR' — NEVER guesses RUN_SUCCEEDED. terminal_reason is set when
    classification can be decided from the commit alone:
      no_merge_record  neither the by-sha nor the by-pr fallback resolved a head
      ERROR            merge timestamp missing/epoch
      not_in_matrix    no gate jobs on the head (normal merge)
      force_merge      no gate jobs on the head AND this was a force merge
    The TD map and failing configs are resolved only on the non-terminal, non-force path,
    where a no-result test needs them to tell a real per-config TD deselection from a
    coverage gap or drift."""
    try:
        # default.merges is keyed by merge_commit_sha; owner/project split from repo.
        owner_name, _, project_name = repo.partition("/")

        head_rows = run_query(
            client,
            MERGE_HEAD_SQL,
            {"merge_commit": commit_sha, "project": project_name, "owner": owner_name},
        )
        if head_rows:
            head_sha = head_rows[0][0]
            force_merge = _is_force(head_rows[0][1])
        else:
            # By-sha is the most precise key and is tried first; only on a miss do we fall
            # back to the squashed title's (#PR), which stays robust to the merge-time
            # rebase that leaves merge_commit_sha != the sha landed on main.
            fallback = _resolve_head_by_pr(client, commit_sha, owner_name, project_name)
            if fallback is None:
                return PremergeContext(
                    None, None, None, [], False,
                    PREMERGE_STATUS_NO_MERGE_RECORD, None, {}, set(),
                )
            head_sha, force_merge = fallback

        # merge_ts stays keyed to the on-main commit (its landed timestamp is the pre/post
        # boundary), NOT the fallback head, in both the by-sha and by-pr paths.
        ts_rows = run_query(client, MERGE_TS_SQL, {"merge_commit": commit_sha})
        ts = ts_rows[0][0] if ts_rows else None
        if ts is None or ts.year <= 1970:
            return PremergeContext(
                head_sha, None, None, [], force_merge,
                PREMERGE_STATUS_ERROR, None, {}, set(),
            )
        merge_ts = _to_utc(ts)

        lower = _to_utc(merge_ts - timedelta(days=LOOKBACK_DAYS))
        # tlow must sit at/below the earliest job in the LOOKBACK window: a test row's
        # time_inserted is always >= its job's created_at, so pruning tighter than the
        # job window would drop real pre-merge rows for stale-head merges.
        tlow = _to_utc(merge_ts - timedelta(days=LOOKBACK_DAYS + PARTITION_MARGIN_DAYS))

        job_rows = run_query(
            client,
            PREMERGE_JOBS_SQL,
            {"head_sha": head_sha, "lower": lower, "merge_ts": merge_ts},
        )
        job_ids = [int(r[0]) for r in job_rows]
        if not job_ids:
            # No gate jobs => the test could not have run. A force merge attributes to
            # force_merge (gate bypassed AND test didn't run); otherwise not_in_matrix.
            reason = (
                PREMERGE_STATUS_FORCE_MERGE
                if force_merge
                else PREMERGE_STATUS_NOT_IN_MATRIX
            )
            return PremergeContext(
                head_sha, merge_ts, tlow, [], force_merge, reason, None, {}, set()
            )

        # A force merge short-circuits to force_merge before the per-config branch is
        # reached, so neither the exclusions nor the failing configs are ever consulted —
        # skip both fetches entirely.
        if force_merge:
            td_excluded: Optional[ExclusionMap] = None
            failing_configs: FailingConfigs = {}
            pull_configs: Set[Tuple[str, str]] = set()
        else:
            td_excluded, pull_run = _resolve_td_excluded(
                client, head_sha, fetch_exclusions_fn
            )
            # Matrix membership is read from the SAME pull run's real jobs (the exclusion
            # artifact omits configs that excluded no files), bounded to the gate window the
            # run's jobs fall in. Only needed when a map resolved: without one a no-result
            # test is td_unknown regardless, so the extra query is skipped.
            pull_configs = (
                fetch_pull_configs(client, pull_run[0], pull_run[1], lower, merge_ts)
                if pull_run is not None
                else set()
            )
            # Failing configs come from the LANDED commit's post-merge jobs (head_sha =
            # commit_sha on main), so the window opens at the merge and runs forward.
            fc_low = _to_utc(merge_ts - timedelta(days=PARTITION_MARGIN_DAYS))
            fc_high = _to_utc(merge_ts + timedelta(days=LOOKBACK_DAYS))
            failing_configs = fetch_failing_configs(
                client, commit_sha, fc_low, fc_high, fc_low
            )
        return PremergeContext(
            head_sha, merge_ts, tlow, job_ids, force_merge, None, td_excluded,
            failing_configs, pull_configs,
        )
    except Exception as exc:
        logger.warning(
            "premerge context resolve failed for %s: %s",
            commit_sha,
            exc,
            exc_info=True,
        )
        return PremergeContext(
            None, None, None, [], False, PREMERGE_STATUS_ERROR, None, {}, set()
        )


def classify_with_context(
    client: Client,
    context: PremergeContext,
    file: str,
    name: str,
) -> str:
    """Classify test (file, name) against an already-resolved per-commit context.
    A terminal context short-circuits with no query. Otherwise aggregates the test's
    runs; RUN_SUCCEEDED requires a POSITIVE success-row observation, so an empty result
    maps to a NOT_RUN path, never SUCCEEDED. On query exception after retries: ERROR."""
    if context.terminal_reason is not None:
        return context.terminal_reason
    try:
        test_rows = run_query(
            client,
            PREMERGE_TEST_SQL,
            {
                "job_ids": context.job_ids,
                "tlow": context.tlow,
                "file": file,
                "name": name,
            },
        )
        if test_rows:
            r = test_rows[0]
            fails = int(r[0] or 0)
            successes = int(r[1] or 0)
            skips = int(r[2] or 0)
            verdict = classify_counts(fails, successes, skips)
            if verdict is not None:
                return verdict

        # The test produced no pass/fail/skip verdict. Under a force merge the gate was
        # bypassed and the test did not run, so attribute to force_merge (it never masks
        # a real outcome — a real verdict above always wins).
        if context.force_merge:
            return PREMERGE_STATUS_FORCE_MERGE

        # Per-config no-result attribution against the failing configs resolved on main and
        # the configs that actually ran in the pre-merge pull matrix.
        return _classify_no_result(
            context.td_excluded,
            context.failing_configs.get((file, name), set()),
            context.pull_configs,
            file,
        )
    except Exception as exc:
        logger.warning(
            "premerge classify failed for %s::%s: %s",
            file,
            name,
            exc,
            exc_info=True,
        )
        return PREMERGE_STATUS_ERROR


def classify_premerge(
    client: Client,
    commit_sha: str,
    file: str,
    name: str,
    repo: str = "pytorch/pytorch",
    fetch_exclusions_fn: ExclusionsFetcher = fetch_exclusions,
) -> str:
    """Classify the pre-merge trunk-gate status of test (file, name) for merged commit M.
    Convenience wrapper resolving the per-commit context and classifying one test; the
    collect loop resolves the context once per commit and calls classify_with_context."""
    context = resolve_premerge_context(client, commit_sha, repo, fetch_exclusions_fn)
    return classify_with_context(client, context, file, name)
