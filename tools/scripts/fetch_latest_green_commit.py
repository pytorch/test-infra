import json
import os
import re
import sys
from collections.abc import Iterator
from functools import lru_cache
from html import escape
from pathlib import Path
from typing import Any, cast, Dict, List, NamedTuple, Optional, Tuple


REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))
from scripts.gitutils import _check_output
from torchci.clickhouse import query_clickhouse_saved


sys.path.pop(0)


def eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


class WorkflowCheck(NamedTuple):
    workflowName: str
    name: str
    jobName: str
    conclusion: str


def get_latest_commits(viable_strict_branch: str, main_branch: str) -> List[str]:
    latest_viable_commit = _check_output(
        [
            "git",
            "log",
            "-n",
            "1",
            "--pretty=format:%H",
            f"origin/{viable_strict_branch}",
        ],
        encoding="ascii",
    )
    commits = _check_output(
        [
            "git",
            "rev-list",
            f"{latest_viable_commit}..HEAD",
            f"--remotes=*origin/{main_branch}",
        ],
        encoding="ascii",
    ).splitlines()

    return commits  # type: ignore[no-any-return]


def query_commits(commits: List[str]) -> List[Dict[str, Any]]:
    res = query_clickhouse_saved("commit_jobs_batch_query", {"shas": commits})

    return cast(List[Dict[str, Any]], res)


def print_commit_status(commit: str, results: Dict[str, Any]) -> None:
    print(commit)
    for check in results["results"]:
        if check["sha"] == commit:
            print(f"\t{check['conclusion']:>10}: {check['name']}")


def get_commit_results(
    commit: str, results: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    workflow_checks = []
    for check in results:
        if check["sha"] == commit:
            workflow_checks.append(
                WorkflowCheck(
                    workflowName=check["workflowName"],
                    name=check["name"],
                    jobName=check["jobName"],
                    conclusion=check["conclusion"],
                )._asdict()
            )
    return workflow_checks


@lru_cache
def fetch_unstable_issues() -> List[str]:
    issues = query_clickhouse_saved(
        "issue_query", {"label": "unstable"}, useChQueryCache=True
    )
    return [
        issue["title"][len("UNSTABLE") :].strip()
        for issue in issues
        if issue["title"].startswith("UNSTABLE") and issue["state"] == "open"
    ]


UNSTABLE_REGEX = re.compile(r"(.*) \(([^,]*),.*\)")


def is_unstable(job: dict[str, Any]) -> bool:
    # Check if the job is an unstable job, either by name or by issue
    unstable_issues = fetch_unstable_issues()
    job_name = job["name"]
    if "unstable" in job_name or job_name in unstable_issues:
        return True
    # Go from something like pull / something / test (config, 1, 2, 3) to pull / something / test (config)
    match = UNSTABLE_REGEX.match(job_name)
    if match:
        return f"{match.group(1)} ({match.group(2)})" in unstable_issues
    return False


def iter_blockers(
    workflow_checks: List[Dict[str, Any]], requires: List[str]
) -> Iterator[tuple[str, dict[str, Any] | None]]:
    # A failed required job is present (not missing), even if no attempt passed.
    matched = {check: False for check in requires if check}
    for check in workflow_checks:
        if is_unstable(check):
            continue
        workflow_name = check["workflowName"]
        reported = False
        for required_check in matched:
            # Full match: "pull" won't also match "pull-test-sandbox".
            if re.fullmatch(required_check, workflow_name, flags=re.IGNORECASE):
                matched[required_check] = True
                if not reported and check["conclusion"] not in ["success", "skipped"]:
                    yield (
                        f"{workflow_name} was not successful, {check['name']} failed",
                        check,
                    )
                    reported = True

    missing = [name for name, seen in matched.items() if not seen]
    if missing:
        yield "missing required workflows: " + ", ".join(missing), None


def is_green(
    commit: str, requires: List[str], results: List[Dict[str, Any]]
) -> Tuple[bool, str]:
    checks = get_commit_results(commit, results)
    first = next(iter_blockers(checks, requires), None)
    return (False, first[0]) if first is not None else (True, "")


def describe_check(check: dict[str, Any]) -> str:
    label = escape(" ".join(str(check["name"]).split()))
    url = check.get("htmlUrl")
    if isinstance(url, str) and re.fullmatch(
        r"https://github\.com/[\w.-]+/[\w.-]+/actions/runs/\d+/job/\d+", url
    ):
        label = f'<a href="{url}">{label}</a>'
    attempt = check.get("run_attempt")
    if attempt is not None:
        label += f" (attempt {escape(str(attempt))})"
    return label


def write_run_summary(
    path: Path,
    commits: List[str],
    requires: List[str],
    results: List[Dict[str, Any]],
    latest_viable_commit: Optional[str],
) -> None:
    heading = "## Why hasn't viable/strict advanced?\n\n"
    if latest_viable_commit is not None:
        heading += f"Selected `{latest_viable_commit}`.\n\n"
        if commits and commits[0] != latest_viable_commit:
            heading += "Newer rejected candidates:\n\n"
    elif commits:
        heading += "No candidate passed the required checks.\n\n"
    else:
        heading += "No newer candidates to evaluate.\n\n"

    checks_by_commit: dict[str, list[dict[str, Any]]] = {}
    for check in results:
        checks_by_commit.setdefault(check["sha"], []).append(check)

    sections = [heading]
    size = len(heading.encode("utf-8"))
    for commit in commits:
        if commit == latest_viable_commit:
            break
        checks = checks_by_commit.get(commit, [])
        passed: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for check in checks:
            if check["conclusion"] == "success":
                passed.setdefault((check["workflowName"], check["jobName"]), []).append(
                    check
                )
        blockers = list(iter_blockers(checks, requires))
        details = "<details open>" if commit == commits[0] else "<details>"
        lines = [
            f"{details}<summary><code>{escape(commit)}</code> — "
            f"{len(blockers)} blocker finding(s)</summary><ul>"
        ]
        for message, blocker in blockers:
            if blocker is None:
                lines.append(f"<li>{escape(message)}</li>")
                continue
            conclusion = escape(str(blocker["conclusion"]))
            line = f"<li><strong>{conclusion}</strong>: {describe_check(blocker)}"
            other_runs = passed.get((blocker["workflowName"], blocker["jobName"]), [])
            if other_runs:
                line += "; also passed: " + ", ".join(map(describe_check, other_runs))
            lines.append(line + "</li>")
        section = "\n".join([*lines, "</ul></details>", "", ""])
        size += len(section.encode("utf-8"))
        # Leave headroom under GitHub's 1 MiB per-step summary limit.
        if size > 900_000:
            sections.append(
                "Summary truncated. See the updater log for other candidates.\n"
            )
            break
        sections.append(section)
    with path.open("a", encoding="utf-8") as summary:
        summary.writelines(sections)


def get_latest_green_commit(
    commits: List[str], requires: List[str], results: List[Dict[str, Any]]
) -> Optional[str]:
    for commit in commits:
        eprint(f"Checking {commit}")
        green, msg = is_green(commit, requires, results)
        if green:
            eprint("GREEN")
            return commit
        else:
            eprint("RED: " + msg)
    return None


def parse_args() -> Any:
    from argparse import ArgumentParser

    parser = ArgumentParser("Return the latest green commit from a PyTorch repo")
    parser.add_argument("--required-checks", type=str)
    parser.add_argument("--viable-strict-branch", type=str, default="viable/strict")
    parser.add_argument("--main-branch", type=str, default="main")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    commits = get_latest_commits(args.viable_strict_branch, args.main_branch)
    results = query_commits(commits)
    try:
        required_checks = json.loads(args.required_checks)
    except json.JSONDecodeError:
        required_checks = args.required_checks.split(",")
    latest_viable_commit = get_latest_green_commit(commits, required_checks, results)
    if summary_path := os.getenv("GITHUB_STEP_SUMMARY"):
        try:
            write_run_summary(
                Path(summary_path),
                commits,
                required_checks,
                results,
                latest_viable_commit,
            )
        except Exception:
            # Diagnostics must not interfere with the branch update.
            eprint(
                "Could not write the viable/strict run summary; see the updater log."
            )
    print(latest_viable_commit)


if __name__ == "__main__":
    main()
