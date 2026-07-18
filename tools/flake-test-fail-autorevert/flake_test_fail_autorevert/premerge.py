"""Pre-merge trunk-gate classification for a merged commit's test signal.

`premerge_status` vocabulary (one of):
  RUN_SUCCEEDED         test ran on the validated pre-merge head and passed
  RUN_FAILED            test ran and at least one shard failed ("merged despite red")
  NOT_RUN:force_merge   REAL force merge (skip_mandatory_checks) AND the test did not
                        run at all — the gate was bypassed
  NOT_RUN:skipped       test ran but every run was skipped
  NOT_RUN:td_deselected test's file ran but the test was deselected (test dependency)
  NOT_RUN:not_in_matrix the test's file never ran on the head (job not in the matrix)
  NOT_RUN:no_merge_record  no default.merges row resolved a pre-merge head for this
                        commit — ghstack non-tip commit, revert, direct push, or data
                        predating the merges table. We cannot resolve a head, so this is
                        the honest label (NOT an inference of force merge).
  ERROR                 a query failed after retries, or the merge timestamp is missing/
                        epoch. RUN_SUCCEEDED is NEVER emitted from an empty/partial read.

RUN_SUCCEEDED requires a POSITIVE success-row observation. A force merge does NOT mask a
real pre-merge outcome: if the test actually ran under a force merge, its real verdict
(RUN_FAILED/RUN_SUCCEEDED/skipped) is reported; force_merge is attributed only when the
test did not run at all.
"""

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import List, NamedTuple, Optional

from clickhouse_connect.driver import Client

from .client import run_query

logger = logging.getLogger(__name__)

LOOKBACK_DAYS = 30          # job created_at lower bound around merge window
PARTITION_MARGIN_DAYS = 2   # extra skew buffer below the job window floor for tests.all_test_runs partition prune

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
    passing retry. Returns None when there are no pass/fail/skip rows (caller does the
    file probe to distinguish td_deselected vs not_in_matrix)."""
    if fails > 0:
        return "RUN_FAILED"
    if successes > 0:
        return "RUN_SUCCEEDED"
    if skips > 0:
        return "NOT_RUN:skipped"
    return None


MERGE_HEAD_SQL = """
SELECT last_commit_sha, skip_mandatory_checks
FROM default.merges FINAL
WHERE merge_commit_sha = {merge_commit:String}
  AND project = {project:String}
  AND owner = {owner:String}
  AND last_commit_sha != ''
ORDER BY comment_id DESC
LIMIT 1
"""

MERGE_TS_SQL = """
SELECT min(commit.timestamp) AS ts
FROM default.push ARRAY JOIN commits AS commit
WHERE ref = 'refs/heads/main' AND commit.id = {merge_commit:String}
"""

# Step A: pre-merge gate jobs on the validated head. created_at <= merge_ts EXCLUDES
# post-merge reruns on the reused PR/ghstack branch (those would wrongly show failures).
PREMERGE_JOBS_SQL = """
SELECT id
FROM default.workflow_job FINAL
WHERE head_sha = {head_sha:String}
  AND created_at >= {lower:DateTime}
  AND created_at <= {merge_ts:DateTime}
  AND name NOT LIKE '%mem_leak_check%'
  AND name NOT LIKE '%rerun_disabled_tests%'
  AND name NOT LIKE '%unstable%'
"""

# Step B: aggregate the target test across those jobs. Partition-pruned on time_inserted.
PREMERGE_TEST_SQL = """
SELECT
    sum(failure_count + error_count) AS fails,
    sum(if(failure_count = 0 AND error_count = 0 AND skipped_count = 0, 1, 0)) AS successes,
    sum(if(skipped_count > 0 AND failure_count = 0 AND error_count = 0, 1, 0)) AS skips,
    count() AS rows
FROM tests.all_test_runs
WHERE job_id IN {job_ids:Array(Int64)}
  AND toDate(time_inserted) >= toDate({tlow:DateTime})
  AND file = {file:String}
  AND name = {name:String}
GROUP BY file, name
"""

# File probe: did the test's FILE run at all on the head (whole-file/job in matrix)?
PREMERGE_FILE_SQL = """
SELECT count() AS rows
FROM tests.all_test_runs
WHERE job_id IN {job_ids:Array(Int64)}
  AND toDate(time_inserted) >= toDate({tlow:DateTime})
  AND file = {file:String}
"""


class PremergeContext(NamedTuple):
    """Per-commit pre-merge resolution shared across all of a commit's test signals.
    head_sha/merge_ts/job_ids depend only on the commit, so they are resolved once.
    A non-None terminal_reason short-circuits classification to that value for every
    signal of the commit without any further query."""

    head_sha: Optional[str]
    merge_ts: Optional[datetime]
    tlow: Optional[datetime]
    job_ids: List[int]
    force_merge: bool
    terminal_reason: Optional[str]


def resolve_premerge_context(
    client: Client,
    commit_sha: str,
    repo: str = "pytorch/pytorch",
) -> PremergeContext:
    """Resolve the per-commit pre-merge context (head, merge ts, gate jobs, force flag).
    All IO goes through run_query (retry wrapper). On any query exception after retries,
    returns a context with terminal_reason 'ERROR' — NEVER guesses RUN_SUCCEEDED.
    terminal_reason is set when classification can be decided from the commit alone:
      no_merge_record  no merges row resolved a head
      ERROR            merge timestamp missing/epoch
      not_in_matrix    no gate jobs on the head (normal merge)
      force_merge      no gate jobs on the head AND this was a force merge"""
    try:
        # default.merges is keyed by merge_commit_sha; owner/project split from repo.
        owner_name, _, project_name = repo.partition("/")

        head_rows = run_query(
            client,
            MERGE_HEAD_SQL,
            {"merge_commit": commit_sha, "project": project_name, "owner": owner_name},
        )
        if not head_rows:
            return PremergeContext(None, None, None, [], False, "NOT_RUN:no_merge_record")
        head_sha = head_rows[0][0]
        force_merge = _is_force(head_rows[0][1])

        ts_rows = run_query(client, MERGE_TS_SQL, {"merge_commit": commit_sha})
        ts = ts_rows[0][0] if ts_rows else None
        if ts is None or ts.year <= 1970:
            return PremergeContext(head_sha, None, None, [], force_merge, "ERROR")
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
            reason = "NOT_RUN:force_merge" if force_merge else "NOT_RUN:not_in_matrix"
            return PremergeContext(head_sha, merge_ts, tlow, [], force_merge, reason)

        return PremergeContext(head_sha, merge_ts, tlow, job_ids, force_merge, None)
    except Exception as exc:
        logger.warning(
            "premerge context resolve failed for %s: %s",
            commit_sha,
            exc,
            exc_info=True,
        )
        return PremergeContext(None, None, None, [], False, "ERROR")


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
        # a real outcome — a real verdict above always wins). Otherwise probe the file to
        # distinguish td_deselected (file ran) from not_in_matrix (file absent).
        if context.force_merge:
            return "NOT_RUN:force_merge"

        file_rows_res = run_query(
            client,
            PREMERGE_FILE_SQL,
            {"job_ids": context.job_ids, "tlow": context.tlow, "file": file},
        )
        file_rows = int(file_rows_res[0][0]) if file_rows_res else 0
        return "NOT_RUN:td_deselected" if file_rows > 0 else "NOT_RUN:not_in_matrix"
    except Exception as exc:
        logger.warning(
            "premerge classify failed for %s::%s: %s",
            file,
            name,
            exc,
            exc_info=True,
        )
        return "ERROR"


def classify_premerge(
    client: Client,
    commit_sha: str,
    file: str,
    name: str,
    repo: str = "pytorch/pytorch",
) -> str:
    """Classify the pre-merge trunk-gate status of test (file, name) for merged commit M.
    Convenience wrapper resolving the per-commit context and classifying one test; the
    collect loop resolves the context once per commit and calls classify_with_context."""
    context = resolve_premerge_context(client, commit_sha, repo)
    return classify_with_context(client, context, file, name)
