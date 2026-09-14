import re
from datetime import datetime
from typing import Dict, List, NamedTuple, Optional, Set, Tuple

from clickhouse_connect.driver import Client  # type: ignore[import-not-found]

from .client import run_query
from .logic import is_test_signal
from .premerge_sql import MAIN_FAILING_TESTS_SQL, MAIN_JOBS_SQL, PULL_CONFIGS_SQL


# Failing configs for a landed commit, keyed by (file, name) -> {(build_env, test_config)}.
FailingConfigs = Dict[Tuple[str, str], Set[Tuple[str, str]]]

# workflow_job.name is "<build_env> / test (<test_config>, <shard>, <total>, <runner>...)".
# build_env is everything before " / test (", test_config is the first parenthesized token
# (delimited by ',' or ')'). Mirrors pytorch test-infra's get_reverts_caused_by_td.py so the
# parsed keys line up with the TD artifact's (build_env, test_config) keys.
_JOB_NAME_RE = re.compile(r"^(?P<build_env>.+?) / test \((?P<test_config>[^,)]+)")


def parse_build_env_test_config(job_name: str) -> Optional[Tuple[str, str]]:
    """(build_env, test_config) parsed from a workflow_job.name, or None if it is not a
    shaped test job (e.g. a build job or an unparseable name)."""
    match = _JOB_NAME_RE.match(job_name)
    if match is None:
        return None
    return match.group("build_env").strip(), match.group("test_config").strip()


REVERTS_SQL = """
SELECT
    toString(commit_sha) AS commit_sha,
    arrayJoin(arrayDistinct(source_signal_keys)) AS signal_key,
    arrayDistinct(groupArrayArray(workflows)) AS workflows
FROM misc.autorevert_events_v2
WHERE action = 'revert'
  AND repo = {repo:String}
  AND dry_run = 0
  AND ts >= {ev_start:DateTime}
  AND ts <  {ev_end:DateTime}
GROUP BY commit_sha, signal_key
"""

# Scan every snapshot in the window (not just the latest per stream): commits age out of
# autorevert's sliding state window mid-window, so a later snapshot would miss flaky states
# seen earlier; flaky status is monotonic, so the union is exhaustive. The caller sub-day-
# chunks the window and max_threads is capped to bound peak memory on the shared cluster.
FLAKY_SQL = """
WITH sigs AS (
  SELECT arrayJoin(JSONExtractArrayRaw(state,'columns')) AS sig
  FROM misc.autorevert_state
  WHERE ts >= {day_start:DateTime} AND ts < {day_end:DateTime}
    AND dry_run = 0 AND repo = {repo:String}
)
SELECT DISTINCT
  JSONExtractString(sig,'workflow') AS workflow,
  JSONExtractString(sig,'key')      AS signal_key,
  kv.1                              AS commit_sha
FROM sigs
ARRAY JOIN JSONExtractKeysAndValuesRaw(sig,'cells') AS kv
WHERE arrayExists(e -> JSONExtractString(e,'status')='failure', JSONExtractArrayRaw(kv.2))
  AND arrayExists(e -> JSONExtractString(e,'status')='success', JSONExtractArrayRaw(kv.2))
SETTINGS max_threads = 4
"""

PUSH_SQL = """
SELECT commit.id AS sha, min(commit.timestamp) AS ts
FROM default.push ARRAY JOIN commits AS commit
WHERE ref = 'refs/heads/main'
  AND commit.id IN {shas:Array(String)}
GROUP BY sha
"""

COMMIT_MSG_SQL = """
SELECT commit.id AS sha, any(commit.message) AS message
FROM default.push ARRAY JOIN commits AS commit
WHERE ref = 'refs/heads/main'
  AND commit.id IN {shas:Array(String)}
GROUP BY sha
"""

ADVISOR_SQL = """
SELECT toString(suspect_commit) AS commit_sha, signal_key,
       argMax(tuple(verdict, confidence, workflow_name), timestamp) AS vcw
FROM misc.autorevert_advisor_verdicts
WHERE repo = {repo:String}
  AND signal_source = 'test'
  AND toString(suspect_commit) IN {shas:Array(String)}
GROUP BY commit_sha, signal_key
"""

# The `pull` workflow runs on a validated pre-merge head, oldest first. A head normally has
# two: the PR's original run (which carries the real TD exclusions) and the merge-triggered
# rerun (whose exclusions are empty). GROUP BY dedupes unmerged ReplacingMergeTree rows.
PULL_RUNS_SQL = """
SELECT id, run_attempt
FROM default.workflow_run
WHERE head_sha = {head_sha:String}
  AND name = 'pull'
GROUP BY id, run_attempt
ORDER BY min(run_started_at) ASC
"""

PUSH_CHUNK_SIZE = 500


class Regressions(NamedTuple):
    by_commit: Dict[str, Set[str]]
    single_workflow: Dict[Tuple[str, str], Optional[str]]


def fetch_regressions(
    client: Client, repo: str, ev_start: datetime, ev_end: datetime
) -> Regressions:
    rows = run_query(
        client,
        REVERTS_SQL,
        {"repo": repo, "ev_start": ev_start, "ev_end": ev_end},
    )
    by_commit: Dict[str, Set[str]] = {}
    single_workflow: Dict[Tuple[str, str], Optional[str]] = {}
    for commit_sha, signal_key, workflows in rows:
        if not is_test_signal(signal_key):
            continue
        by_commit.setdefault(commit_sha, set()).add(signal_key)
        wfs = set(workflows)
        single_workflow[(commit_sha, signal_key)] = (
            next(iter(wfs)) if len(wfs) == 1 else None
        )
    return Regressions(by_commit, single_workflow)


def fetch_flaky_for_day(
    client: Client, repo: str, day_start: datetime, day_end: datetime
) -> Set[Tuple[str, str, str]]:
    rows = run_query(
        client,
        FLAKY_SQL,
        {"repo": repo, "day_start": day_start, "day_end": day_end},
    )
    found: Set[Tuple[str, str, str]] = set()
    for workflow, signal_key, commit_sha in rows:
        if not is_test_signal(signal_key):
            continue
        found.add((workflow, signal_key, commit_sha))
    return found


def fetch_commit_times(client: Client, shas: List[str]) -> Dict[str, datetime]:
    commit_times: Dict[str, datetime] = {}
    for i in range(0, len(shas), PUSH_CHUNK_SIZE):
        chunk = shas[i : i + PUSH_CHUNK_SIZE]
        rows = run_query(client, PUSH_SQL, {"shas": chunk})
        for sha, ts in rows:
            if not sha or not isinstance(ts, datetime):
                continue
            if ts.year <= 1970:
                continue
            commit_times[sha] = ts
    return commit_times


def fetch_commit_messages(client: Client, shas: List[str]) -> Dict[str, str]:
    messages: Dict[str, str] = {}
    for i in range(0, len(shas), PUSH_CHUNK_SIZE):
        chunk = shas[i : i + PUSH_CHUNK_SIZE]
        rows = run_query(client, COMMIT_MSG_SQL, {"shas": chunk})
        for sha, message in rows:
            if not sha:
                continue
            messages[sha] = message or ""
    return messages


def fetch_advisor_verdicts(
    client: Client, repo: str, shas: List[str]
) -> Dict[Tuple[str, str], Tuple[str, Optional[float], Optional[str]]]:
    verdicts: Dict[Tuple[str, str], Tuple[str, Optional[float], Optional[str]]] = {}
    for i in range(0, len(shas), PUSH_CHUNK_SIZE):
        chunk = shas[i : i + PUSH_CHUNK_SIZE]
        rows = run_query(client, ADVISOR_SQL, {"repo": repo, "shas": chunk})
        for commit_sha, signal_key, vcw in rows:
            verdict, confidence, workflow = vcw
            conf = float(confidence) if confidence is not None else None
            wf = workflow or None
            verdicts[(commit_sha, signal_key)] = (verdict, conf, wf)
    return verdicts


def fetch_pull_runs(client: Client, head_sha: str) -> List[Tuple[int, int]]:
    """(id, run_attempt) of every `pull` workflow run on head_sha, oldest first."""
    rows = run_query(client, PULL_RUNS_SQL, {"head_sha": head_sha})
    return [(int(r[0]), int(r[1])) for r in rows]


def fetch_pull_configs(
    client: Client,
    run_id: int,
    run_attempt: int,
    lower: datetime,
    upper: datetime,
) -> Set[Tuple[str, str]]:
    """The (build_env, test_config) set that actually RAN in one pre-merge `pull` workflow
    run — the SOLE source of pull-matrix membership. The TD-exclusion artifact omits any
    config that excluded no files, so it cannot answer 'did this config run'; the run's real
    test jobs can. Names that do not parse as a shaped test job are dropped. Bounded by
    (run_id, run_attempt) to the exact run whose exclusions were used, plus a created_at
    window for skip-index pruning."""
    rows = run_query(
        client,
        PULL_CONFIGS_SQL,
        {"run_id": run_id, "run_attempt": run_attempt, "lower": lower, "upper": upper},
    )
    configs: Set[Tuple[str, str]] = set()
    for (name,) in rows:
        parsed = parse_build_env_test_config(name)
        if parsed is not None:
            configs.add(parsed)
    return configs


def fetch_failing_configs(
    client: Client,
    commit_sha: str,
    lower: datetime,
    upper: datetime,
    tlow: datetime,
) -> FailingConfigs:
    """For a landed commit, the (build_env, test_config) set where each (file, name) FAILED
    on main. Batched per commit (two queries, not one per signal): resolve the commit's test
    jobs, then the tests that failed across them, joining job_id -> (build_env, test_config)
    in Python. A job whose name does not parse is dropped (it carries no config to key by)."""
    job_rows = run_query(
        client, MAIN_JOBS_SQL, {"commit": commit_sha, "lower": lower, "upper": upper}
    )
    job_config: Dict[int, Tuple[str, str]] = {}
    for job_id, name in job_rows:
        parsed = parse_build_env_test_config(name)
        if parsed is not None:
            job_config[int(job_id)] = parsed
    if not job_config:
        return {}

    fail_rows = run_query(
        client,
        MAIN_FAILING_TESTS_SQL,
        {"job_ids": list(job_config), "tlow": tlow},
    )
    failing: FailingConfigs = {}
    for job_id, file, name in fail_rows:
        config = job_config.get(int(job_id))
        if config is None:
            continue
        failing.setdefault((file, name), set()).add(config)
    return failing
