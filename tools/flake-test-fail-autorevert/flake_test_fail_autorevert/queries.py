from datetime import datetime
from typing import Dict, List, NamedTuple, Optional, Set, Tuple

from clickhouse_connect.driver import Client  # type: ignore[import-not-found]

from .client import run_query
from .logic import is_test_signal


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
