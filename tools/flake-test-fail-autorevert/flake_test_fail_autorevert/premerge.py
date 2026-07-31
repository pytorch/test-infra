"""Pre-merge trunk-gate classification for a merged commit's test signal.

`premerge_status` vocabulary (one of), all sourced from premerge_status.py:
  RUN_SUCCEEDED         test ran on the validated pre-merge head and passed
  RUN_FAILED            test ran and at least one shard failed ("merged despite red")
  NOT_RUN:force_merge   REAL force merge (skip_mandatory_checks) AND the test did not
                        run at all — the gate was bypassed
  NOT_RUN:skipped       test ran but every run was skipped
  NOT_RUN:td_excluded   no pre-merge result AND the file was in the pre-merge `pull`
                        TD-excluded set FOR A (build_env, test_config) where the test later
                        FAILED on main — real per-config target determination removed the
                        failing config's coverage
  NOT_RUN:test_absent   no pre-merge result, but a failing (build_env, test_config)'s
                        build_env WAS in the pull matrix with the file kept — the config ran
                        pre-merge and TD did not exclude the file (renamed/removed/param
                        drift), NOT TD
  NOT_RUN:not_in_matrix no pre-merge result AND no failing config's build_env was in the
                        pre-merge pull matrix (e.g. a trunk/CUDA/ROCm/mps-only signal), or
                        no pre-merge gate jobs ran on the head at all
  NOT_RUN:td_unknown    no pre-merge result and TD's per-config decision is unresolvable —
                        no non-empty pull TD artifact, or no failing config resolved on main
  NOT_RUN:no_merge_record  no default.merges row resolved a pre-merge head (ghstack
                        non-tip commit, revert, direct push, or data predating the table);
                        the honest label, NOT an inference of force merge.
  ERROR                 a query failed after retries, or the merge timestamp is missing/
                        epoch. RUN_SUCCEEDED is NEVER emitted from an empty/partial read.

RUN_SUCCEEDED requires a POSITIVE success-row observation; a force merge never masks a real
pre-merge verdict (a real RUN_*/skipped outcome always wins over force_merge).

PyTorch TD is PER-CONFIG: the same file can be excluded from one (build_env, test_config)
and kept in another. A no-result test is td_excluded ONLY when its file was excluded from a
(build_env, test_config) where it FAILED on main; if that config kept the file it is
test_absent, and if the failing config's build_env was never in the pull matrix it is
not_in_matrix.
"""

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Callable, List, NamedTuple, Optional, Set, Tuple

from clickhouse_connect.driver import Client  # type: ignore[import-not-found]

from .client import run_query
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
    PREMERGE_STATUS_RUN_FAILED,
    PREMERGE_STATUS_RUN_SUCCEEDED,
    PREMERGE_STATUS_SKIPPED,
    PREMERGE_STATUS_TD_EXCLUDED,
    PREMERGE_STATUS_TD_UNKNOWN,
    PREMERGE_STATUS_TEST_ABSENT,
)
from .queries import fetch_failing_configs, FailingConfigs, fetch_pull_runs
from .td_exclusions import ExclusionMap, fetch_exclusions, normalize_test_file


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


def classify_counts(fails: int, successes: int, skips: int) -> Optional[str]:
    """Classify a test's pre-merge outcome from aggregated run counts.
    Failure is checked BEFORE success so a mixed shard set where any shard failed is
    reported as RUN_FAILED (the 'merged despite red' signal) rather than masked by a
    passing retry. Returns None when there are no pass/fail/skip rows (caller resolves the
    no-result attribution: td_excluded / test_absent / not_in_matrix / td_unknown)."""
    if fails > 0:
        return PREMERGE_STATUS_RUN_FAILED
    if successes > 0:
        return PREMERGE_STATUS_RUN_SUCCEEDED
    if skips > 0:
        return PREMERGE_STATUS_SKIPPED
    return None


def _classify_no_result(
    excl: Optional[ExclusionMap],
    failing_configs: Set[Tuple[str, str]],
    file: str,
) -> str:
    """Per-config attribution for a regression test with NO pre-merge result row.
    `excl` is the pre-merge pull per-(build_env, test_config) exclusion map (None when TD's
    decision is unresolvable); `failing_configs` is the (build_env, test_config) set where
    the test FAILED on main. Matches pytorch's get_reverts_caused_by_td.py: a build_env or
    config absent from the artifact is not a TD exclusion. Order matters — td_excluded (a
    real per-config coverage removal) is decided before the weaker build_env-level signals."""
    if excl is None or not failing_configs:
        return PREMERGE_STATUS_TD_UNKNOWN
    normalized = normalize_test_file(file)
    # A failing config that had the file excluded: TD removed the coverage that would have
    # caught this failure pre-merge.
    if any(normalized in excl.get(config, frozenset()) for config in failing_configs):
        return PREMERGE_STATUS_TD_EXCLUDED
    # The failing config's build_env ran in the pull matrix (TD kept the file there): the
    # config exercised the file pre-merge, so an absent result is drift, not TD.
    pull_build_envs = {build_env for build_env, _ in excl}
    if any(build_env in pull_build_envs for build_env, _ in failing_configs):
        return PREMERGE_STATUS_TEST_ABSENT
    # No failing config's build_env was in the pull matrix (trunk/CUDA/ROCm/mps-only, or a
    # legacy NoBuildEnv artifact): the failing config was never gated pre-merge.
    return PREMERGE_STATUS_NOT_IN_MATRIX


class PremergeContext(NamedTuple):
    """Per-commit pre-merge resolution shared across all of a commit's test signals.
    head_sha/merge_ts/job_ids/td_excluded/failing_configs depend only on the commit, so
    they are resolved once. A non-None terminal_reason short-circuits classification to that
    value for every signal of the commit without any further query. td_excluded is the
    pre-merge `pull` per-config TD-excluded map (None = unresolvable); failing_configs maps
    (file, name) to the (build_env, test_config) set where it failed on main."""

    head_sha: Optional[str]
    merge_ts: Optional[datetime]
    tlow: Optional[datetime]
    job_ids: List[int]
    force_merge: bool
    terminal_reason: Optional[str]
    td_excluded: Optional[ExclusionMap]
    failing_configs: FailingConfigs


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
) -> Optional[ExclusionMap]:
    """The pre-merge per-config TD-excluded map for head_sha's `pull` runs.
    Tries each pull run oldest-first and returns the FIRST non-empty artifact (the PR's
    original run holds the real exclusions; the merge-triggered rerun is empty). Returns
    None when no run yields a non-empty artifact — TD's decision is then unknown."""
    for run_id, run_attempt in fetch_pull_runs(client, head_sha):
        excluded = fetch_exclusions_fn(run_id, run_attempt)
        if excluded:
            return excluded
    return None


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
                    None, None, None, [], False, PREMERGE_STATUS_NO_MERGE_RECORD, None, {}
                )
            head_sha, force_merge = fallback

        # merge_ts stays keyed to the on-main commit (its landed timestamp is the pre/post
        # boundary), NOT the fallback head, in both the by-sha and by-pr paths.
        ts_rows = run_query(client, MERGE_TS_SQL, {"merge_commit": commit_sha})
        ts = ts_rows[0][0] if ts_rows else None
        if ts is None or ts.year <= 1970:
            return PremergeContext(
                head_sha, None, None, [], force_merge, PREMERGE_STATUS_ERROR, None, {}
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
                head_sha, merge_ts, tlow, [], force_merge, reason, None, {}
            )

        # A force merge short-circuits to force_merge before the per-config branch is
        # reached, so neither the exclusions nor the failing configs are ever consulted —
        # skip both fetches entirely.
        if force_merge:
            td_excluded: Optional[ExclusionMap] = None
            failing_configs: FailingConfigs = {}
        else:
            td_excluded = _resolve_td_excluded(client, head_sha, fetch_exclusions_fn)
            # Failing configs come from the LANDED commit's post-merge jobs (head_sha =
            # commit_sha on main), so the window opens at the merge and runs forward.
            fc_low = _to_utc(merge_ts - timedelta(days=PARTITION_MARGIN_DAYS))
            fc_high = _to_utc(merge_ts + timedelta(days=LOOKBACK_DAYS))
            failing_configs = fetch_failing_configs(
                client, commit_sha, fc_low, fc_high, fc_low
            )
        return PremergeContext(
            head_sha, merge_ts, tlow, job_ids, force_merge, None, td_excluded, failing_configs
        )
    except Exception as exc:
        logger.warning(
            "premerge context resolve failed for %s: %s",
            commit_sha,
            exc,
            exc_info=True,
        )
        return PremergeContext(None, None, None, [], False, PREMERGE_STATUS_ERROR, None, {})


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

        # Per-config no-result attribution against the failing configs resolved on main.
        return _classify_no_result(
            context.td_excluded,
            context.failing_configs.get((file, name), set()),
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
