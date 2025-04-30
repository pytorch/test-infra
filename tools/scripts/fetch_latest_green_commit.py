import json
import re
import sys
from functools import lru_cache
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
            f"{latest_viable_commit}^..HEAD",
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


def is_green(
    commit: str, requires: List[str], results: List[Dict[str, Any]]
) -> Tuple[bool, str]:
    workflow_checks = get_commit_results(commit, results)

    regex = {check: False for check in requires}

    for check in workflow_checks:
        jobName = check["name"]
        # Ignore result from unstable job, be it success or failure
        if is_unstable(check):
            continue

        workflow_name = check["workflowName"]
        conclusion = check["conclusion"]
        for required_check in regex:
            if re.match(required_check, workflow_name, flags=re.IGNORECASE):
                if conclusion not in ["success", "skipped"]:
                    return (
                        False,
                        f"{workflow_name} was not successful, {jobName} failed",
                    )
                else:
                    regex[required_check] = True

    missing_workflows = [x for x in regex.keys() if not regex[x]]
    if len(missing_workflows) > 0:
        return False, "missing required workflows: " + ", ".join(missing_workflows)

    return True, ""


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
    print(latest_viable_commit)


if __name__ == "__main__":
    main()
