"""Checks of `td_exploration` metric rows. A row is uploaded by code the PR itself can
change, so it is checked against the job it names and parsed defensively: a row that
does not parse counts as malformed and never stops the build."""

import json
import logging
import re
from collections import Counter
from typing import Any, Optional

from torchci.td.llm import events
from torchci.td.llm.diff import SHA_RE


logger = logging.getLogger(__name__)

REPO = "pytorch/pytorch"
REPLICATES = 1000
MAX_DRAWN = 500
MAX_NAME = 512
MAX_FILES = 100_000
MAX_SECONDS = 1e9
PROPENSITY_TOLERANCE = 1e-9
CALL_RE = re.compile(r"^[0-9a-f]{12}$")
CIFLOW_RE = re.compile(r"^ciflow/[^/]+/(\d+)$")
FRAME_KEYS = ("frame", "out_of_frame")
SECONDS_KEYS = ("out_of_frame_seconds", "skipped_seconds")


def is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def number_in(value: Any, lo: float, hi: float) -> bool:
    """A real number in [lo, hi]; the comparisons reject NaN, infinities and huge
    integers without converting them."""
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and (lo <= value <= hi)
    )


def name_ok(value: Any) -> bool:
    return isinstance(value, str) and 0 < len(value) <= MAX_NAME


def drawn_reason(d: Any) -> str:
    """'' for a well-formed drawn test, else why not."""
    if not (
        isinstance(d, dict)
        and name_ok(d.get("test"))
        and name_ok(d.get("test_file"))
        and isinstance(d.get("top_part"), bool)
        and (d.get("score") is None or number_in(d.get("score"), -1e12, 1e12))
        and is_int(d.get("count"))
        and isinstance(d.get("propensity"), (int, float))
    ):
        return "malformed"
    if not 1 <= d["count"] <= REPLICATES or not number_in(d["propensity"], 0, 1):
        return "propensity"
    if abs(d["propensity"] - d["count"] / REPLICATES) > PROPENSITY_TOLERANCE:
        return "propensity"
    return ""


def parse_info(raw: Any) -> tuple[str, Optional[dict[str, Any]]]:
    info = json.loads(raw) if isinstance(raw, str) else None
    pr = info.get("pr_number") if isinstance(info, dict) else None
    if not (
        isinstance(info, dict)
        and isinstance(info.get("sha"), str)
        and SHA_RE.match(info["sha"])
        and isinstance(info.get("call"), str)
        and CALL_RE.match(info["call"])
        and (pr is None or (is_int(pr) and 0 <= pr < 1 << 31))
        and is_int(info.get("replicates"))
        and all(is_int(info.get(k)) and 0 <= info[k] <= MAX_FILES for k in FRAME_KEYS)
        and all(number_in(info.get(k), 0, MAX_SECONDS) for k in SECONDS_KEYS)
        and isinstance(info.get("explored"), list)
    ):
        return "malformed", None
    if info["replicates"] != REPLICATES:
        return "replicates", None
    if len(info["explored"]) > MAX_DRAWN:
        return "too_many_tests", None
    for d in info["explored"]:
        reason = drawn_reason(d)
        if reason:
            return reason, None
    return "", info


def pr_of(info: dict[str, Any], job: dict[str, Any]) -> tuple[int, str]:
    """The PR GitHub links to the run (a pull_request run's PRs, or the ciflow tag the
    run was pushed for); the row's own pr_number only has to agree."""
    match = CIFLOW_RE.match(job["head_branch"] or "")
    linked = {int(p) for p in job["run_prs"] or ()}
    if match:
        linked.add(int(match.group(1)))
    linked.discard(0)
    own = info.get("pr_number") or 0
    if own and own not in linked:
        return 0, "pr_mismatch"
    if own:
        return own, ""
    if len(linked) != 1:
        return 0, "no_pr" if not linked else "pr_ambiguous"
    return linked.pop(), ""


def test_job(name: str) -> tuple[str, str, int]:
    """(prefix, config, shard) of "<prefix> / test (<config>, <shard>, ...)", as
    queries.TEST_JOB_FIELDS parses it; the prefix is not always the build environment."""
    parts = name.replace(" / test-osdc (", " / test (", 1).split(" / test (")
    fields = [f.strip() for f in parts[1].split(",")] if len(parts) > 1 else [""]
    shard = fields[1] if len(fields) > 1 else ""
    return parts[0].strip(), fields[0], int(shard) if shard.isdigit() else 0


def check(
    row: dict[str, Any], jobs: dict[int, dict[str, Any]]
) -> tuple[str, Optional[dict[str, Any]]]:
    """('', the row's unit fields) for a usable td_exploration row, else (reason, None)."""
    if row.get("repo") != REPO:
        return "repo", None
    if int(row["oversized"]):
        return "too_large", None
    reason, info = parse_info(row.get("info"))
    if info is None:
        return reason, None
    job = jobs.get(int(row["job_id"]))
    env, cfg = str(row["build_environment"]), str(row["test_config"])
    if job is None:
        return "job_missing", None
    if job["repo"] != REPO:
        return "repo", None
    if int(job["run_id"]) != int(row["run_id"]):
        return "run_mismatch", None
    if job["head_sha"] != info["sha"]:
        return "sha_mismatch", None
    if not int(job["td_scope"]):
        return "workflow_scope", None
    prefix, job_cfg, shard = test_job(job["name"])
    if job_cfg != cfg:
        return "test_config", None
    if shard != 1:
        return "not_shard_1", None
    pr, reason = pr_of(info, job)
    if reason:
        return reason, None
    frame = {k: info[k] for k in FRAME_KEYS + SECONDS_KEYS}
    return "", {
        "group": (pr, info["sha"], job["workflow"], env, cfg),
        "call": info["call"],
        "job_id": int(job["job_id"]),
        "attempt": (int(job["run_id"]), int(job["run_attempt"])),
        "config": (prefix, cfg),
        "ts": events._ts(row["timestamp"]),
        "frame": Counter(frame),
        "drawn": info["explored"],
    }


def validate(
    row: dict[str, Any], jobs: dict[int, dict[str, Any]]
) -> tuple[str, Optional[dict[str, Any]]]:
    try:
        return check(row, jobs)
    except Exception as e:
        logger.warning(
            "td_exploration row of job %s malformed: %s",
            row.get("job_id"),
            type(e).__name__,
            exc_info=True,
        )
        return "malformed", None
