#!/usr/bin/env python3
"""
Check the nightly binary builds before the branch cut of the releases in flight, and record
it in misc.release_event: for every release portal step whose check is `nightly_binaries`,
whether the wheel, libtorch and docker builds of the latest nightly of pytorch/pytorch are
green (https://hud.pytorch.org/hud/pytorch/pytorch/nightly/1).

The nightly is one branch, so it is read once and written for every release in flight that is
before its branch cut (release/X.Y does not exist yet). Each run records the newest nightly
commit whose workflow runs have all finished, and the newest row of a step is what the board
shows, so a result replaces all the earlier ones. Once the release branch is cut the step is
not written any more and the last result stands.

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
import sys
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import quote


sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dev_discuss_scan import github_get, releases_in_flight  # noqa: E402
from github_analyze import insert_clickhouse_rows, workflow_run_info  # noqa: E402


CHECK_TYPE = "nightly_binaries"
DOCKER_WORKFLOW = ".github/workflows/docker-release.yml"
CATEGORIES = ("wheel", "libtorch", "docker")
# A job that ended in one of these is not a failure.
GREEN = ("success", "skipped", "neutral")
RUNS_PER_PAGE = 100
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
    """Per category: the jobs that ran, and the ones that did not end green."""
    summary: Dict[str, Dict[str, Any]] = {
        c: {"jobs": 0, "failed": []} for c in CATEGORIES
    }
    for run in runs:
        for job in jobs_of(run):
            conclusion = job.get("conclusion")
            if conclusion == "skipped":
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
) -> Tuple[str, str, str, Dict[str, Any]]:
    """The status, evidence text, evidence URL and details of the nightly_binaries step."""
    url = hud_url(repo, branch)
    details: Dict[str, Any] = {"repo": repo, "branch": branch}
    sha, finished, newest = latest_finished_commit(runs)
    if sha is None:
        if newest is None:
            return "todo", f"no workflow runs on {repo} {branch}", url, details
        details["sha"] = newest
        text = f"the runs of the newest {branch} commit {newest[:10]} are still running"
        return "in_progress", text, url, details
    date = max(r["created_at"] for r in finished)[:10]
    summary = summarize(finished, jobs_of)
    details.update(
        sha=sha,
        date=date,
        runs=len(finished),
        run_ids=sorted(r["id"] for r in finished),
        jobs={c: s["jobs"] for c, s in summary.items()},
        failed=[f for c in CATEGORIES for f in summary[c]["failed"]][
            :MAX_FAILED_LISTED
        ],
    )
    if newest is not None:
        details["newer_commit_running"] = newest
    where = f"{branch} {date} ({sha[:10]})"
    failed = [
        f"{c} {len(summary[c]['failed'])} failed"
        for c in CATEGORIES
        if summary[c]["failed"]
    ]
    missing = [c for c in CATEGORIES if summary[c]["jobs"] == 0]
    if failed:
        text = f"not green on {where}: {', '.join(failed)}"
        if missing:
            text += f"; no {', '.join(missing)} jobs"
        return "in_progress", text, url, details
    if missing:
        return "in_progress", f"no {', '.join(missing)} jobs on {where}", url, details
    jobs = sum(s["jobs"] for s in summary.values())
    text = (
        f"wheel, libtorch and docker builds are green on {where}: "
        f"{len(finished)} workflows, {jobs} jobs"
    )
    return "done", text, url, details


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
    in_progress until then.
    """
    rows = []
    for step in config["steps"]:
        check = step["check"]
        if check["type"] != CHECK_TYPE:
            continue
        status, evidence, url, details = result_for(check["repo"], check["branch"])
        rows.append(
            {
                "release": release,
                "step_id": step["id"],
                "rc": "",
                "status": status,
                "blocking": 0,
                "evidence_text": evidence,
                "evidence_url": url,
                "check_type": CHECK_TYPE,
                "source": "collector",
                "run_id": run_id,
                "run_url": run_url,
                "config_sha": config_sha,
                "details": json.dumps(details),
                "observed_at": observed_at.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
            }
        )
    return rows


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
            f"?filter=latest&per_page=100&page={page}"
        )["jobs"]
        jobs.extend(found)
        if len(found) < 100:
            return jobs
        page += 1


def branch_exists(repo: str, branch: str) -> bool:
    return (
        github_get(
            f"repos/{repo}/git/ref/heads/{quote(branch, safe='/')}", allow_404=True
        )
        is not None
    )


def scan_release(
    release: str,
    write: bool,
    results: Dict[Tuple[str, str], Tuple[str, str, str, Dict[str, Any]]],
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
    if not any(s["check"]["type"] == CHECK_TYPE for s in config["steps"]):
        print(f"{release} has no nightly_binaries step")
        return True
    if branch_exists("pytorch/pytorch", config["branch"]):
        print(f"{release}: {config['branch']} is cut, the last nightly result stands")
        return True

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

    run_id, run_url = workflow_run_info()
    rows = nightly_step_rows(
        release,
        config,
        result_for,
        os.environ.get("GITHUB_SHA", "0" * 40),
        run_id,
        run_url,
        datetime.now(timezone.utc),
    )
    for row in rows:
        print(f"step {row['step_id']}: {row['status']}: {row['evidence_text']}")
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
    for release in releases:
        print(f"::group::{release}")
        try:
            ok = scan_release(release, args.write_to_clickhouse, results) and ok
        except Exception as err:
            print(f"::error::{release}: {err}")
            ok = False
        finally:
            print("::endgroup::")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
