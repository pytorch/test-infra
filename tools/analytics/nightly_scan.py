#!/usr/bin/env python3
"""
Check the CI signals before the branch cut of the releases in flight, and record them in
misc.release_event. Two release portal checks are read here:

- `nightly_binaries`: whether the wheel, libtorch and docker builds of the latest nightly of
  pytorch/pytorch are green (https://hud.pytorch.org/hud/pytorch/pytorch/nightly/1).
- `viable_strict_lag`: how many hours viable/strict is behind main. A branch that stops
  advancing means trunk CI is red, and a release branch cut from it would not be green.
- `rc_binaries`: the same wheel, libtorch and docker builds for the newest release candidate
  of the release (the runs of its v<version>-rc<N> tag, which is a commit of the release
  branch, as https://hud.pytorch.org/hud/pytorch/pytorch/release%2F2.15/1 shows them).

The nightly and viable/strict are one branch for every release, so each is read once and
written for every release in flight that is before its branch cut (release/X.Y does not exist yet). Each run records the
newest nightly commit whose workflow runs have all finished, and the newest row of a step is
what the board shows, so a result replaces all the earlier ones. A nightly that is not green,
or a viable/strict that is too far behind, is written as `blocked` with the blocking flag, which
the board shows in red. Once the release branch is cut the steps are not written any more and
the last result stands (the board stops flagging them, see `blocks_until_branch_cut`). The
release candidate builds are the other way round: they exist after the cut, and are written
for every release in flight that has a release candidate tag, until the release tag exists.

A job counts for the category it belongs to: the jobs of the Build Official Docker Images
workflow are docker, the jobs named libtorch-* are libtorch, and every other job of the
nightly workflows is a wheel build.

Only the standard library and PyYAML (through the portal config) are needed, and no checkout
of pytorch: the releases in flight are the open milestones of pytorch/pytorch whose
v<version> tag does not exist yet.
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import quote


sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dev_discuss_scan import github_get, releases_in_flight  # noqa: E402
from github_analyze import (  # noqa: E402
    insert_clickhouse_rows,
    workflow_run_info,
    write_step_summary,
)


CHECK_TYPE = "nightly_binaries"
VIABLE_STRICT_CHECK_TYPE = "viable_strict_lag"
RC_CHECK_TYPE = "rc_binaries"
WORKFLOW_RUN_CHECK_TYPE = "github_workflow_run"
DOCKER_WORKFLOW = ".github/workflows/docker-release.yml"
# The workflows that build the binaries, on the nightly branch and on a release candidate tag
# (a tag also starts others, like the builds of the manywheel docker images, which are not
# binaries).
BINARY_WORKFLOW = re.compile(r"^\.github/workflows/generated-.*binary.*\.yml$")
CATEGORIES = ("wheel", "libtorch", "docker")
# A job that ended in one of these is not a failure.
GREEN = ("success", "skipped", "neutral")
WORKFLOW_GREEN = ("success", "neutral")
WORKFLOW_IGNORED = ("cancelled", "skipped")
RUNS_PER_PAGE = 100
# GitHub answers 502 after ~10s for a page of 100 jobs of a run with many attempts (the
# linux-binary-manywheel nightly: 112 jobs, 228 with the earlier attempts), every time;
# pages of 30 take 5-7s each and always work.
JOBS_PER_PAGE = 30
MAX_FAILED_LISTED = 20


def hud_url(repo: str, branch: str) -> str:
    return f"https://hud.pytorch.org/hud/{repo}/{branch}/1?per_page=50"


def job_category(workflow_path: str, job_name: str) -> str:
    """The category a job of a nightly workflow counts for."""
    if workflow_path == DOCKER_WORKFLOW:
        return "docker"
    if "libtorch" in job_name.lower():
        return "libtorch"
    return "wheel"


def latest_finished_commit(
    runs: List[Dict[str, Any]],
) -> Tuple[Optional[str], List[Dict[str, Any]], Optional[str]]:
    """
    The newest commit whose workflow runs have all completed, its runs, and the newest commit
    when it is still running (so it was passed over), else None. A commit is as new as the
    latest run created for it.
    """
    by_sha: Dict[str, List[Dict[str, Any]]] = {}
    for run in runs:
        by_sha.setdefault(run["head_sha"], []).append(run)
    shas = sorted(
        by_sha, key=lambda s: max(r["created_at"] for r in by_sha[s]), reverse=True
    )
    for index, sha in enumerate(shas):
        if all(r["status"] == "completed" for r in by_sha[sha]):
            return sha, by_sha[sha], shas[0] if index > 0 else None
    return None, [], shas[0] if shas else None


def summarize(
    runs: List[Dict[str, Any]],
    jobs_of: Callable[[Dict[str, Any]], List[Dict[str, Any]]],
) -> Dict[str, Dict[str, Any]]:
    """
    Per category: the jobs that ran, and the ones that did not end green. A job that has not
    finished (the runs of a commit that is still going) is neither.
    """
    summary: Dict[str, Dict[str, Any]] = {
        c: {"jobs": 0, "failed": []} for c in CATEGORIES
    }
    for run in runs:
        for job in jobs_of(run):
            conclusion = job.get("conclusion")
            if conclusion == "skipped" or (
                conclusion is None and job.get("status") != "completed"
            ):
                continue
            entry = summary[job_category(run.get("path", ""), job["name"])]
            entry["jobs"] += 1
            if conclusion not in GREEN:
                entry["failed"].append(
                    {
                        "workflow": run["name"],
                        "job": job["name"],
                        "conclusion": conclusion or job.get("status", "unknown"),
                        "url": job.get("html_url", ""),
                    }
                )
    return summary


def nightly_result(
    repo: str,
    branch: str,
    runs: List[Dict[str, Any]],
    jobs_of: Callable[[Dict[str, Any]], List[Dict[str, Any]]],
    url: Optional[str] = None,
) -> Tuple[str, str, str, Dict[str, Any]]:
    """
    The status, evidence text, evidence URL and details of the nightly_binaries step (and,
    with a tag as `branch` and the HUD page of the release branch as `url`, of the
    rc_binaries step): done
    when green, blocked when a build failed or a category has no jobs, in_progress while the
    newest runs are going and nothing has failed yet.

    The newest commit is what counts. When all its runs have finished it is read as it is.
    While some are still running, a job of it that has failed already makes the step not
    green (waiting for the rest would hide the failure, and a run that is re-run stays open
    for hours); if nothing has failed yet, the result of the latest finished commit stands.
    """
    url = url or hud_url(repo, branch)
    details: Dict[str, Any] = {"repo": repo, "branch": branch}
    sha, finished, newest = latest_finished_commit(runs)

    def report(
        commit: str,
        commit_runs: List[Dict[str, Any]],
        summary: Dict[str, Dict[str, Any]],
        running: bool,
    ) -> Tuple[str, str, str, Dict[str, Any]]:
        date = max(r["created_at"] for r in commit_runs)[:10]
        details.update(
            sha=commit,
            date=date,
            runs=len(commit_runs),
            run_ids=sorted(r["id"] for r in commit_runs),
            jobs={c: s["jobs"] for c, s in summary.items()},
            failed=[f for c in CATEGORIES for f in summary[c]["failed"]][
                :MAX_FAILED_LISTED
            ],
            still_running=running,
        )
        where = f"{branch} {date} ({commit[:10]})"
        failed = [
            f"{c} {len(summary[c]['failed'])} failed"
            for c in CATEGORIES
            if summary[c]["failed"]
        ]
        missing = [c for c in CATEGORIES if summary[c]["jobs"] == 0]
        if failed:
            text = f"not green on {where}: {', '.join(failed)}"
            if running:
                text += " (other runs are still going)"
            elif missing:
                text += f"; no {', '.join(missing)} jobs"
            return "blocked", text, url, details
        if missing:
            return (
                "blocked",
                f"no {', '.join(missing)} jobs on {where}",
                url,
                details,
            )
        jobs = sum(s["jobs"] for s in summary.values())
        text = (
            f"wheel, libtorch and docker builds are green on {where}: "
            f"{len(commit_runs)} workflows, {jobs} jobs"
        )
        return "done", text, url, details

    if newest is not None:
        going = [r for r in runs if r["head_sha"] == newest]
        summary = summarize(going, jobs_of)
        if any(s["failed"] for s in summary.values()):
            return report(newest, going, summary, True)
    if sha is None:
        if newest is None:
            return "todo", f"no workflow runs on {repo} {branch}", url, details
        details["sha"] = newest
        text = f"the runs of the newest {branch} commit {newest[:10]} are still running"
        return "in_progress", text, url, details
    if newest is not None:
        details["newer_commit_running"] = newest
    return report(sha, finished, summarize(finished, jobs_of), False)


def step_row(
    release: str,
    step_id: str,
    check_type: str,
    result: Tuple[str, str, str, Dict[str, Any]],
    config_sha: str,
    run_id: str,
    run_url: str,
    observed_at: datetime,
    rc: str = "",
) -> Dict[str, Any]:
    """A misc.release_event row; a blocked step is the one the board flags in red."""
    status, evidence, url, details = result
    return {
        "release": release,
        "step_id": step_id,
        "rc": rc,
        "status": status,
        "blocking": int(status == "blocked"),
        "evidence_text": evidence,
        "evidence_url": url,
        "check_type": check_type,
        "source": "collector",
        "run_id": run_id,
        "run_url": run_url,
        "config_sha": config_sha,
        "details": json.dumps(details),
        "observed_at": observed_at.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
    }


def nightly_step_rows(
    release: str,
    config: Dict[str, Any],
    result_for: Callable[[str, str], Tuple[str, str, str, Dict[str, Any]]],
    config_sha: str,
    run_id: str,
    run_url: str,
    observed_at: datetime,
) -> List[Dict[str, Any]]:
    """
    The misc.release_event rows of one scan of a release: one per nightly_binaries step, done
    when the wheel, libtorch and docker builds of the latest finished nightly are green and
    blocked when they are not.
    """
    return [
        step_row(
            release,
            step["id"],
            CHECK_TYPE,
            result_for(step["check"]["repo"], step["check"]["branch"]),
            config_sha,
            run_id,
            run_url,
            observed_at,
        )
        for step in config["steps"]
        if step["check"]["type"] == CHECK_TYPE
    ]


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def viable_strict_result(
    repo: str,
    branch: str,
    base: str,
    max_hours: float,
    head_of: Callable[[str], Dict[str, Any]],
) -> Tuple[str, str, str, Dict[str, Any]]:
    """
    The status, evidence text, evidence URL and details of the viable_strict_lag step: how many
    hours the head commit of `branch` is behind the head commit of `base` (by commit time).
    Done below `max_hours`, blocked at `max_hours` or more.
    """
    base_head = head_of(base)
    head = head_of(branch)
    hours = (parse_time(base_head["date"]) - parse_time(head["date"])).total_seconds()
    hours = max(hours, 0) / 3600
    details = {
        "repo": repo,
        "branch": branch,
        "base": base,
        "hours_behind": round(hours, 1),
        "max_hours": max_hours,
        "sha": head["sha"],
        "date": head["date"],
        "base_sha": base_head["sha"],
        "base_date": base_head["date"],
    }
    url = f"https://github.com/{repo}/compare/{head['sha']}...{base_head['sha']}"
    text = (
        f"{branch} is {hours:.1f} hours behind {base} ({head['sha'][:10]} of "
        f"{head['date'][:16].replace('T', ' ')} UTC; {base} is at {base_head['sha'][:10]})"
    )
    if hours >= max_hours:
        return "blocked", f"{text}, {max_hours:g} or more", url, details
    return "done", text, url, details


def viable_strict_step_rows(
    release: str,
    config: Dict[str, Any],
    result_for: Callable[[Dict[str, Any]], Tuple[str, str, str, Dict[str, Any]]],
    config_sha: str,
    run_id: str,
    run_url: str,
    observed_at: datetime,
) -> List[Dict[str, Any]]:
    """The rows of one scan of a release: one per viable_strict_lag step."""
    return [
        step_row(
            release,
            step["id"],
            VIABLE_STRICT_CHECK_TYPE,
            result_for(step["check"]),
            config_sha,
            run_id,
            run_url,
            observed_at,
        )
        for step in config["steps"]
        if step["check"]["type"] == VIABLE_STRICT_CHECK_TYPE
    ]


def nightly_runs(repo: str, branch: str) -> List[Dict[str, Any]]:
    """The newest push runs on the nightly branch (about two weeks of them)."""
    found = github_get(
        f"repos/{repo}/actions/runs?branch={quote(branch, safe='')}"
        f"&event=push&per_page={RUNS_PER_PAGE}"
    )
    return found["workflow_runs"]


def run_jobs(repo: str, run: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The jobs of the latest attempt of a run."""
    jobs: List[Dict[str, Any]] = []
    page = 1
    while True:
        found = github_get(
            f"repos/{repo}/actions/runs/{run['id']}/jobs"
            f"?filter=latest&per_page={JOBS_PER_PAGE}&page={page}"
        )["jobs"]
        jobs.extend(found)
        if len(found) < JOBS_PER_PAGE:
            return jobs
        page += 1


def release_candidates(repo: str, version: str) -> List[Tuple[str, str, str]]:
    """The release candidate tags of a release, in candidate-number order."""
    pattern = re.compile(rf"refs/tags/v{re.escape(version)}-rc(\d+)")
    found = []
    for ref in github_get(f"repos/{repo}/git/matching-refs/tags/v{version}-rc"):
        match = pattern.fullmatch(ref["ref"])
        if match:
            found.append((int(match[1]), ref))
    candidates = []
    for number, ref in sorted(found):
        sha = ref["object"]["sha"]
        if ref["object"]["type"] == "tag":  # an annotated tag points at the commit
            sha = github_get(f"repos/{repo}/git/tags/{sha}")["object"]["sha"]
        candidates.append((f"rc{number}", f"v{version}-rc{number}", sha))
    return candidates


def latest_rc(repo: str, version: str) -> Optional[Tuple[str, str, str]]:
    """The newest release candidate tag of a release: (rc1, v2.15.0-rc1, commit sha)."""
    candidates = release_candidates(repo, version)
    return candidates[-1] if candidates else None


def tag_push_runs(repo: str, tag: str, sha: str) -> List[Dict[str, Any]]:
    """The workflow runs the push of a release candidate tag started."""
    found = github_get(
        f"repos/{repo}/actions/runs?head_sha={sha}&per_page={RUNS_PER_PAGE}"
    )
    return [
        r
        for r in found["workflow_runs"]
        if r["event"] == "push" and r["head_branch"] == tag
    ]


def rc_runs(repo: str, tag: str, sha: str) -> List[Dict[str, Any]]:
    """The binary build runs the push of a release candidate tag started."""
    return [
        run
        for run in tag_push_runs(repo, tag, sha)
        if run["path"] == DOCKER_WORKFLOW or BINARY_WORKFLOW.match(run["path"])
    ]


def workflow_runs(repo: str, workflow: str, branch: str) -> List[Dict[str, Any]]:
    """The completed runs of one workflow on a branch, newest first."""
    runs: List[Dict[str, Any]] = []
    page = 1
    while True:
        found = github_get(
            f"repos/{repo}/actions/workflows/{quote(workflow, safe='')}/runs?branch="
            f"{quote(branch, safe='')}&status=completed&per_page={RUNS_PER_PAGE}"
            f"&page={page}"
        )["workflow_runs"]
        runs.extend(found)
        if len(found) < RUNS_PER_PAGE:
            return runs
        page += 1


def resolved_workflow_check(check: Dict[str, Any], branch: str) -> Dict[str, Any]:
    """Fill the release-branch reference used by a workflow collector check."""
    return {**check, "ref": check["ref"].replace("{branch}", branch)}


def run_started_at(run: Dict[str, Any]) -> datetime:
    return parse_time(run.get("run_started_at") or run["created_at"])


def binary_runs_finished_at(
    runs: List[Dict[str, Any]], result: Tuple[str, str, str, Dict[str, Any]]
) -> Optional[datetime]:
    """When a candidate's green binary builds finished, if they have."""
    if result[0] != "done" or not runs:
        return None
    completed: List[str] = []
    for run in runs:
        updated_at = run.get("updated_at")
        if not isinstance(updated_at, str):
            return None
        completed.append(updated_at)
    return max(parse_time(value) for value in completed)


def workflow_run_result(
    check: Dict[str, Any],
    runs: List[Dict[str, Any]],
    after: Optional[datetime] = None,
    before: Optional[datetime] = None,
) -> Tuple[str, str, str, Dict[str, Any]]:
    """The latest completed, non-cancelled workflow run in an optional time range."""
    qualifying = []
    for run in runs:
        if run.get("status") != "completed":
            continue
        started = run_started_at(run)
        if (after is not None and started <= after) or (
            before is not None and started >= before
        ):
            continue
        if run.get("conclusion") in WORKFLOW_IGNORED:
            continue
        qualifying.append((started, run))

    details: Dict[str, Any] = {
        "repo": check["repo"],
        "workflow": check["workflow"],
        "ref": check["ref"],
    }
    if after is not None:
        details["after"] = after.isoformat()
    if before is not None:
        details["before"] = before.isoformat()
    if not qualifying:
        requirement = ""
        if after is not None:
            requirement = f" after {after.isoformat()}"
        return (
            "todo",
            f"no qualifying {check['workflow']} run on {check['ref']}{requirement}",
            "",
            details,
        )

    _, run = max(qualifying, key=lambda item: item[0])
    conclusion = run.get("conclusion") or "unknown"
    details.update(
        run_id=run["id"],
        conclusion=conclusion,
        started_at=(run.get("run_started_at") or run["created_at"]),
        head_sha=run.get("head_sha", ""),
        event=run.get("event", ""),
    )
    evidence = f"{check['workflow']} run {run['id']} on {check['ref']} {conclusion}"
    return (
        "done" if conclusion in WORKFLOW_GREEN else "blocked",
        evidence,
        run.get("html_url", ""),
        details,
    )


def workflow_step_rows(
    release: str,
    config: Dict[str, Any],
    candidates: List[Dict[str, Any]],
    runs_for: Callable[[Dict[str, Any]], List[Dict[str, Any]]],
    branch_cut: bool,
    released: bool,
    config_sha: str,
    run_id: str,
    run_url: str,
    observed_at: datetime,
) -> List[Dict[str, Any]]:
    """Rows for the RC-scoped workflow checks in the release portal."""
    rows = []
    for step in config["steps"]:
        check = step["check"]
        if check["type"] != WORKFLOW_RUN_CHECK_TYPE:
            continue
        for index, candidate in enumerate(candidates):
            window = step.get("window", {})
            if window.get("opens") == "branch_cut" and not branch_cut:
                result = (
                    "todo",
                    "waiting for the release branch to be cut",
                    "",
                    {"window": "before"},
                )
            elif window.get("closes") == "ga" and released:
                result = (
                    "done",
                    f"window closed when v{release} was tagged",
                    "",
                    {"window": "after"},
                )
            else:
                after = None
                before = None
                if check["workflow"] == "validate-binaries.yml":
                    after = candidate["binaries_finished_at"]
                    if index + 1 < len(candidates):
                        # A run during the next candidate's binary build still belongs here.
                        before = candidates[index + 1]["binaries_finished_at"]
                    if after is None:
                        result = (
                            "todo",
                            f"waiting for green binaries of {candidate['tag']}",
                            "",
                            {"binaries": "not_ready"},
                        )
                    else:
                        result = workflow_run_result(
                            check, runs_for(check), after, before
                        )
                else:
                    result = workflow_run_result(check, runs_for(check))
            status, evidence, url, details = result
            details = dict(details)
            details["rc"] = candidate["rc"]
            if step.get("depends_on"):
                details["depends_on"] = step["depends_on"]
            rows.append(
                step_row(
                    release,
                    step["id"],
                    WORKFLOW_RUN_CHECK_TYPE,
                    (status, evidence, url, details),
                    config_sha,
                    run_id,
                    run_url,
                    observed_at,
                    candidate["rc"],
                )
            )
    return rows


def rc_step_rows(
    release: str,
    config: Dict[str, Any],
    result_for: Callable[[str, str], Optional[Tuple[str, Tuple[str, str, str, Dict]]]],
    config_sha: str,
    run_id: str,
    run_url: str,
    observed_at: datetime,
) -> List[Dict[str, Any]]:
    """
    The rows of one scan of a release: one per rc_binaries step, for the newest release
    candidate (the step is RC-scoped, so the row is that candidate's). Nothing before the
    first release candidate tag.
    """
    rows = []
    for step in config["steps"]:
        if step["check"]["type"] != RC_CHECK_TYPE:
            continue
        found = result_for(step["check"]["repo"], release)
        if found is not None:
            rc, result = found
            rows.append(
                step_row(
                    release,
                    step["id"],
                    RC_CHECK_TYPE,
                    result,
                    config_sha,
                    run_id,
                    run_url,
                    observed_at,
                    rc,
                )
            )
    return rows


def branch_head(repo: str, branch: str) -> Dict[str, Any]:
    """The sha and commit time of the head of a branch."""
    commit = github_get(f"repos/{repo}/commits/{quote(branch, safe='/')}")
    return {"sha": commit["sha"], "date": commit["commit"]["committer"]["date"]}


def branch_exists(repo: str, branch: str) -> bool:
    return (
        github_get(
            f"repos/{repo}/git/ref/heads/{quote(branch, safe='/')}", allow_404=True
        )
        is not None
    )


def failed_job_lines(rows: List[Dict[str, Any]]) -> List[str]:
    """The failed jobs of the nightly and of the release candidates, for the job summary."""
    lines: List[str] = []
    for row in rows:
        if row["check_type"] not in (CHECK_TYPE, RC_CHECK_TYPE):
            continue
        details = json.loads(row["details"])
        failed = details.get("failed", [])
        if not failed:
            continue
        what = (
            f"nightly {details.get('date', '')}"
            if row["check_type"] == CHECK_TYPE
            else details["branch"]
        )
        if f"Failed jobs on {what}:" in lines:  # the same for every release in flight
            continue
        lines += ["", f"Failed jobs on {what}:", ""]
        for job in failed[:MAX_FAILED_LISTED]:
            name = f"{job['workflow']} / {job['job']}: {job['conclusion']}"
            lines.append(f"- [{name}]({job['url']})" if job["url"] else f"- {name}")
    return lines[1:]


def scan_release(
    release: str,
    write: bool,
    results: Dict[Tuple[str, str], Tuple[str, str, str, Dict[str, Any]]],
    lag_results: Dict[Tuple[Any, ...], Tuple[str, str, str, Dict[str, Any]]],
    summary_rows: List[Dict[str, Any]],
) -> bool:
    """Scan and print one release; returns False when it has no release file."""
    from torchci.release_portal_config import load_resolved, RELEASES_DIR

    if not (RELEASES_DIR / f"{release}.yml").exists():
        print(
            f"::error::{release} is in flight but has no "
            f"release/portal/config/releases/{release}.yml"
        )
        return False
    config = load_resolved(release)
    types = {s["check"]["type"] for s in config["steps"]}
    before_cut = bool(types & {CHECK_TYPE, VIABLE_STRICT_CHECK_TYPE})
    workflow_steps = [
        {
            **step,
            "check": resolved_workflow_check(step["check"], config["branch"]),
        }
        for step in config["steps"]
        if step["check"]["type"] == WORKFLOW_RUN_CHECK_TYPE
    ]
    workflow_checks = bool(workflow_steps)
    workflow_needs_branch_cut = any(
        step.get("window", {}).get("opens") == "branch_cut" for step in workflow_steps
    )
    workflow_needs_ga = any(
        step.get("window", {}).get("closes") == "ga" for step in workflow_steps
    )
    if not (before_cut or RC_CHECK_TYPE in types or workflow_checks):
        print(
            f"{release} has no nightly, viable/strict, release candidate or workflow step"
        )
        return True
    branch_cut = (
        branch_exists("pytorch/pytorch", config["branch"])
        if before_cut or workflow_needs_branch_cut
        else False
    )
    if before_cut and branch_cut:
        print(f"{release}: {config['branch']} is cut, the last nightly result stands")
        before_cut = False
    released = workflow_needs_ga and (
        github_get(f"repos/pytorch/pytorch/git/ref/tags/v{release}", allow_404=True)
        is not None
    )

    def result_for(repo: str, branch: str) -> Tuple[str, str, str, Dict[str, Any]]:
        # the nightly is the same for every release: read it once
        if (repo, branch) not in results:
            results[(repo, branch)] = nightly_result(
                repo,
                branch,
                nightly_runs(repo, branch),
                lambda run: run_jobs(repo, run),
            )
        return results[(repo, branch)]

    def viable_strict_for(
        check: Dict[str, Any],
    ) -> Tuple[str, str, str, Dict[str, Any]]:
        key = (check["repo"], check["branch"], check["base"], check["max_hours"])
        if key not in lag_results:
            lag_results[key] = viable_strict_result(
                check["repo"],
                check["branch"],
                check["base"],
                check["max_hours"],
                lambda branch: branch_head(check["repo"], branch),
            )
        return lag_results[key]

    candidate_cache: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}

    def candidates_for(repo: str, version: str) -> List[Dict[str, Any]]:
        key = (repo, version)
        if key in candidate_cache:
            return candidate_cache[key]
        candidates = []
        for rc, tag, sha in release_candidates(repo, version):
            tag_runs = tag_push_runs(repo, tag, sha)
            binary_runs = [
                run
                for run in tag_runs
                if run["path"] == DOCKER_WORKFLOW or BINARY_WORKFLOW.match(run["path"])
            ]
            result = nightly_result(
                repo,
                tag,
                binary_runs,
                lambda run: run_jobs(repo, run),
                f"https://hud.pytorch.org/hud/{repo}/"
                f"{quote(config['branch'], safe='')}/1?per_page=50",
            )
            result[3]["rc"] = rc
            candidates.append(
                {
                    "rc": rc,
                    "tag": tag,
                    "result": result,
                    "binaries_finished_at": binary_runs_finished_at(
                        binary_runs, result
                    ),
                }
            )
        candidate_cache[key] = candidates
        return candidates

    def rc_for(
        repo: str, version: str
    ) -> Optional[Tuple[str, Tuple[str, str, str, Dict[str, Any]]]]:
        candidates = candidates_for(repo, version)
        if not candidates:
            print(f"{release}: no release candidate tag yet")
            return None
        latest = candidates[-1]
        return latest["rc"], latest["result"]

    workflow_cache: Dict[Tuple[str, str, str], List[Dict[str, Any]]] = {}

    def workflow_runs_for(check: Dict[str, Any]) -> List[Dict[str, Any]]:
        key = (check["repo"], check["workflow"], check["ref"])
        if key not in workflow_cache:
            workflow_cache[key] = workflow_runs(*key)
        return workflow_cache[key]

    run_id, run_url = workflow_run_info()
    common = (
        os.environ.get("GITHUB_SHA", "0" * 40),
        run_id,
        run_url,
        datetime.now(timezone.utc),
    )
    rows = []
    if before_cut:
        rows = nightly_step_rows(
            release, config, result_for, *common
        ) + viable_strict_step_rows(release, config, viable_strict_for, *common)
    rows += rc_step_rows(release, config, rc_for, *common)
    if workflow_checks:
        workflow_config = {**config, "steps": workflow_steps}
        rows += workflow_step_rows(
            release,
            workflow_config,
            candidates_for("pytorch/pytorch", release),
            workflow_runs_for,
            branch_cut,
            released,
            *common,
        )
    summary_rows.extend(rows)
    for row in rows:
        rc = f" {row['rc']}" if row["rc"] else ""
        print(f"step {row['step_id']}{rc}: {row['status']}: {row['evidence_text']}")
    if write and rows:
        insert_clickhouse_rows("misc.release_event", rows)
        print(f"Inserted {len(rows)} rows into misc.release_event")
    return True


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--release",
        action="append",
        help="a release to scan (X.Y.Z); repeatable. Default: the releases in flight",
    )
    parser.add_argument(
        "--write-to-clickhouse",
        action="store_true",
        help="record the steps in misc.release_event (CLICKHOUSE_ENDPOINT, "
        "CLICKHOUSE_USERNAME and CLICKHOUSE_PASSWORD)",
    )
    args = parser.parse_args(argv)

    releases = args.release or releases_in_flight()
    print(f"Releases in flight: {', '.join(releases) if releases else 'none'}")
    ok = True
    results: Dict[Tuple[str, str], Tuple[str, str, str, Dict[str, Any]]] = {}
    lag_results: Dict[Tuple[Any, ...], Tuple[str, str, str, Dict[str, Any]]] = {}
    summary_rows: List[Dict[str, Any]] = []
    for release in releases:
        print(f"::group::{release}")
        try:
            ok = (
                scan_release(
                    release,
                    args.write_to_clickhouse,
                    results,
                    lag_results,
                    summary_rows,
                )
                and ok
            )
        except Exception as err:
            print(f"::error::{release}: {err}")
            ok = False
        finally:
            print("::endgroup::")
    write_step_summary(
        "Nightly binaries, viable/strict, release candidate binaries and workflow runs",
        summary_rows,
        args.write_to_clickhouse,
        failed_job_lines(summary_rows),
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
