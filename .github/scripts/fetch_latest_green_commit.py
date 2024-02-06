import json
import os
import re
import sys
from typing import Any, cast, Dict, List, NamedTuple, Optional, Tuple

import rockset  # type: ignore[import]
from gitutils import _check_output


def eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


class WorkflowCheck(NamedTuple):
    workflowName: str
    name: str
    jobName: str
    conclusion: str


def get_latest_commits() -> List[str]:
    latest_viable_commit = _check_output(
        [
            "git",
            "log",
            "-n",
            "1",
            "--pretty=format:%H",
            "origin/viable/strict",
        ],
        encoding="ascii",
    )
    commits = _check_output(
        [
            "git",
            "rev-list",
            f"{latest_viable_commit}^..HEAD",
            "--remotes=*origin/main",
        ],
        encoding="ascii",
    ).splitlines()

    return commits


def query_commits(commits: List[str]) -> List[Dict[str, Any]]:
    rs = rockset.RocksetClient(
        host="api.usw2a1.rockset.com", api_key=os.environ["ROCKSET_API_KEY"]
    )
    params = [{"name": "shas", "type": "string", "value": ",".join(commits)}]
    res = rs.QueryLambdas.execute_query_lambda(
        # https://console.rockset.com/lambdas/details/commons.commit_jobs_batch_query
        query_lambda="commit_jobs_batch_query",
        version="19c74e10819104f9",
        workspace="commons",
        parameters=params,
    )

    return cast(List[Dict[str, Any]], res.results)


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

    regex = {name: False for name in requires}

    for check in workflow_checks:
        jobName = check["jobName"]
        # Ignore result from unstable job, be it success or failure
        if "unstable" in jobName:
            continue

        workflowName = check["workflowName"]
        conclusion = check["conclusion"]
        for required_check in regex:
            if re.match(required_check, workflowName, flags=re.IGNORECASE):
                if conclusion not in ["success", "skipped"]:
                    return (False, workflowName + " checks were not successful")
                else:
                    regex[required_check] = True

    missing_workflows = [x for x in regex.keys() if not regex[x]]
    if len(missing_workflows) > 0:
        return (False, "missing required workflows: " + ", ".join(missing_workflows))

    return (True, "")


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
    parser.add_argument(
        "--requires",
        type=str,
        required=True,
        help="the JSON list of required jobs that need to pass for the commit to be green",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    commits = get_latest_commits()
    results = query_commits(commits)

    latest_viable_commit = get_latest_green_commit(
        commits, json.loads(args.requires), results
    )
    print(latest_viable_commit)


if __name__ == "__main__":
    main()
