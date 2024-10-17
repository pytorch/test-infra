import json
from pathlib import Path
import re
import sys
from typing import Any, cast, Dict, List, NamedTuple, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))
from tools.torchci.clickhouse import query_clickhouse_saved
from tools.scripts.gitutils import _check_output

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

    return commits


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


def is_green(
    commit: str, requires: List[str], results: List[Dict[str, Any]]
) -> Tuple[bool, str]:
    workflow_checks = get_commit_results(commit, results)

    regex = {check: False for check in requires}

    for check in workflow_checks:
        jobName = check["jobName"]
        # Ignore result from unstable job, be it success or failure
        if "unstable" in jobName:
            continue

        workflow_name = check["workflowName"]
        conclusion = check["conclusion"]
        for required_check in regex:
            if re.match(required_check, workflow_name, flags=re.IGNORECASE):
                if conclusion not in ["success", "skipped"]:
                    return False, workflow_name + " checks were not successful"
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
