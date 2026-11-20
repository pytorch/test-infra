"""Counted trunk breaks: main landings TD let through, from the saved `td_trunk_breakages`.

A landing counts when the mergebot command that landed it (the `default.merges` row whose
`merge_commit_sha` is the landing: for a ghstack stack, the top PR's) skipped no mandatory
checks (`-f`), and at least one of its (config, test file) pairs has outcome `td_skipped`,
its file passed on none of the PR's heads, and its config is not a check that command
waived: flaky, broken trunk, not related, or, for an `-i` merge, ignored. Each pair's
features come from the TD log of its PR's last head, found as td_trunk_breakages finds it:
the `last_commit_sha` of the PR's latest merges row for one of the push's commits, else the
head of the PR's latest completed `pull` run created before the landing (a stack member has
no merges row of its own).
"""

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable, Mapping, Optional

from torchci.td.llm.events import fetch_e1
from torchci.td.llm.events_sql import TD_WORKFLOW_PREFIXES, TD_WORKFLOWS
from torchci.td.scorer.logs import fetch_td_log, map_threaded, TDLog
from torchci.td.scorer.rows_sql import SETTINGS, TD_JOB_FILTER, TD_JOB_SUCCESS
from torchci.td.scorer.shards import query, td_platform


COUNTED_OUTCOME = "td_skipped"
PASSED_OUTCOME = "passed_on_pr"
WAIVED_ALWAYS = ("flaky_checks", "broken_trunk_checks", "ai_not_related_checks")
CHECK_CONFIG = re.compile(r"^(.*) / test(?:-osdc)? \(([^,)]*)")

PUSH_SQL = f"""
SELECT head_commit.id AS landing_sha, commits.id AS shas
FROM default.push
WHERE tupleElement(head_commit, 'timestamp') >= {{start: DateTime64(3)}}
    AND tupleElement(head_commit, 'timestamp') < {{stop: DateTime64(3)}}
    AND head_commit.id IN {{landings: Array(String)}}
    AND ref = 'refs/heads/main' AND repository.full_name = 'pytorch/pytorch'
LIMIT 1 BY landing_sha
{SETTINGS}
"""

MERGES_SQL = f"""
SELECT pr_num, merge_commit_sha, last_commit_sha, comment_id, skip_mandatory_checks,
    ignore_current, ignore_current_checks, flaky_checks, broken_trunk_checks, ai_not_related_checks
FROM default.merges
WHERE owner = 'pytorch' AND project = 'pytorch' AND pr_num IN {{prs: Array(Int64)}}
    AND merge_commit_sha IN {{shas: Array(String)}} AND NOT is_failed AND NOT dry_run
ORDER BY comment_id DESC, last_commit_sha DESC
LIMIT 1 BY pr_num, merge_commit_sha
{SETTINGS}
"""

RUN_HEADS_SQL = f"""
SELECT tupleElement(pull_requests[1], 'number') AS pr, head_sha, created_at
FROM default.workflow_run
WHERE id IN (
        SELECT id FROM materialized_views.workflow_run_by_pr_num
        WHERE pr_number IN {{prs: Array(Int64)}}
    )
    AND startsWith(dynamoKey, 'pytorch/pytorch/') AND name = 'pull' AND status = 'completed'
{SETTINGS}
"""

TD_JOBS_SQL = f"""
SELECT head_sha, max(id) AS td_job_id
FROM (
    SELECT id, head_sha, workflow_name AS workflow, status, conclusion
    FROM default.workflow_job
    PREWHERE id IN (
        SELECT id FROM materialized_views.workflow_job_by_head_sha
        WHERE head_sha IN {{shas: Array(String)}}
    )
    WHERE {TD_JOB_FILTER}
    ORDER BY _inserted_at DESC
    LIMIT 1 BY id
)
WHERE {TD_JOB_SUCCESS}
GROUP BY head_sha
{SETTINGS}
"""


@dataclass(frozen=True)
class TrunkPair:
    pr: int
    head_sha: str
    build_env: str
    test_config: str
    test_file: str


@dataclass(frozen=True)
class TrunkLanding:
    landing_sha: str
    day: str
    pairs: tuple[TrunkPair, ...]


def split_config(config: str) -> Optional[tuple[str, str]]:
    """(build env, test config) of a TD-scope `workflow / job base name / test config`."""
    parts = config.split(" / ")
    if len(parts) < 3:
        return None
    workflow, env = parts[0], " / ".join(parts[1:-1])
    in_scope = workflow in TD_WORKFLOWS or workflow.startswith(TD_WORKFLOW_PREFIXES)
    return (env, parts[-1]) if in_scope and td_platform(env) else None


def check_config(check: str) -> Optional[str]:
    match = CHECK_CONFIG.match(check)
    return f"{match.group(1)} / {match.group(2)}" if match else None


def waived_configs(rows: Iterable[dict[str, Any]], ignore_current: bool) -> set[str]:
    keys = WAIVED_ALWAYS + (("ignore_current_checks",) if ignore_current else ())
    out = set()
    for row in rows:
        for key in keys:
            for check in row.get(key) or []:
                config = check_config(check[0]) if check else None
                if config:
                    out.add(config)
    return out


def _timestamp(value: Any) -> str:
    return str(value).replace("T", " ")[:19]


def last_run_head(
    run_heads: list[dict[str, Any]], pr: int, before: str
) -> Optional[str]:
    """The head of the PR's latest `pull` run created before `before`."""
    found = max(
        (
            (_timestamp(r["created_at"]), r["head_sha"])
            for r in run_heads
            if int(r["pr"]) == pr and _timestamp(r["created_at"]) < before
        ),
        default=None,
    )
    return found[1] if found else None


def counted_landings(
    events: list[dict[str, Any]],
    members: dict[str, list[str]],
    merges: list[dict[str, Any]],
    run_heads: list[dict[str, Any]],
) -> list[TrunkLanding]:
    rows = {(int(m["pr_num"]), m["merge_commit_sha"]): m for m in merges}
    out = []
    for e in events:
        sha = e["landing_sha"]
        shas = set(members.get(sha, [])) | {sha}
        command = next((m for (_, s), m in rows.items() if s == sha), None)
        if command is None or command["skip_mandatory_checks"]:
            continue
        waived = waived_configs([command], bool(command["ignore_current"]))
        landed_at = _timestamp(e["landed_at"])
        pairs = list(
            zip(e["test_configs"], e["test_files"], e["test_prs"], e["test_outcomes"])
        )
        passed = {f for _, f, _, o in pairs if o == PASSED_OUTCOME}
        kept = []
        for config, test_file, pr, outcome in pairs:
            split = split_config(config)
            if (
                outcome != COUNTED_OUTCOME
                or test_file in passed
                or not split
                or config in waived
            ):
                continue
            own = [rows[(int(pr), s)] for s in sorted(shas) if (int(pr), s) in rows]
            head = (
                max(own, key=lambda m: (int(m["comment_id"]), m["last_commit_sha"]))[
                    "last_commit_sha"
                ]
                if own
                else last_run_head(run_heads, int(pr), landed_at)
            )
            if not head:
                continue
            pair = TrunkPair(int(pr), head, *split, test_file)
            if pair not in kept:
                kept.append(pair)
        if kept:
            out.append(TrunkLanding(sha, landed_at[:10], tuple(kept)))
    return sorted(out, key=lambda x: (x.day, x.landing_sha))


def fetch_landings(start: datetime, stop: datetime) -> list[TrunkLanding]:
    events = [r for r in fetch_e1(start, stop, query) if r.get("grain") == "event"]
    if not events:
        return []
    window = {
        "start": f"{start:%Y-%m-%d} 00:00:00.000",
        "stop": f"{stop:%Y-%m-%d} 23:59:59.000",
    }
    landings = sorted({e["landing_sha"] for e in events})
    pushes = query("td_scorer_pushes", PUSH_SQL, {**window, "landings": landings})
    members = {p["landing_sha"]: list(p["shas"]) for p in pushes}
    prs = sorted({int(p) for e in events for p in e["test_prs"]})
    shas = sorted({s for v in members.values() for s in v} | set(landings))
    merges = query("td_scorer_merges", MERGES_SQL, {"prs": prs, "shas": shas})
    run_heads = query("td_scorer_run_heads", RUN_HEADS_SQL, {"prs": prs})
    return counted_landings(events, members, merges, run_heads)


def counted_pairs(
    landing: TrunkLanding, logs: Mapping[str, TDLog], exclude_prs: set[int]
) -> list[TrunkPair]:
    """The landing's pairs that train: a TD log at their PR's last head, and their PR
    not left out."""
    return [p for p in landing.pairs if p.head_sha in logs and p.pr not in exclude_prs]


def fetch_head_logs(shas: Iterable[str]) -> dict[str, TDLog]:
    """The TD log of each head sha's latest successful TD job, where one exists."""
    shas = sorted(set(shas))
    if not shas:
        return {}
    jobs = query("td_scorer_head_td_jobs", TD_JOBS_SQL, {"shas": shas})
    logs = map_threaded(lambda j: fetch_td_log(int(j["td_job_id"])), jobs)
    return {j["head_sha"]: log for j, log in zip(jobs, logs) if log is not None}
