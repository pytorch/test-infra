import sys
import os
import re

from typing import Any, Dict, List, NamedTuple, Tuple, cast
from argparse import ArgumentParser

import rockset  # type: ignore[import]
from tools.scripts.gitutils import check_output


def eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


class WorkflowCheck(NamedTuple):
    workflowName: str
    name: str
    jobName: str
    conclusion: str


def get_latest_commits(viable_strict_branch: str) -> List[str]:
    latest_viable_commit = check_output(
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
    commits = check_output(
        [
            "git",
            "rev-list",
            f"{latest_viable_commit}^..HEAD",
            "--remotes=*origin/master",
        ],
        encoding="ascii",
    ).splitlines()

    return commits


def query_commits(commits: List[str]) -> List[Dict[str, Any]]:
    rs = rockset.RocksetClient(
        host="api.usw2a1.rockset.com", api_key=os.environ["ROCKSET_API_KEY"]
    )
    params = [{
        "name": "shas",
        "type": "string",
        "value": ",".join(commits)
    }]
    res = rs.QueryLambdas.execute_query_lambda(
        query_lambda='commit_jobs_batch_query',
        version='8003fdfd18b64696',
        workspace='commons',
        parameters=params
    )

    return cast(List[Dict[str, Any]], res.results)


def print_commit_status(commit: str, results: Dict[str, Any]) -> None:
    for check in results['results']:
        if check['sha'] == commit:
            print(f"\t{check['conclusion']:>10}: {check['name']}")


def get_commit_results(commit: str, results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    workflow_checks = []
    for check in results:
        if check['sha'] == commit:
            workflow_checks.append(WorkflowCheck(
                workflowName=check['workflowName'],
                name=check['name'],
                jobName=check['jobName'],
                conclusion=check['conclusion'],
            )._asdict())
    return workflow_checks


def is_green(commit: str, results: List[Dict[str, Any]], required_checks: List[str]) -> Tuple[bool, str]:
    workflow_checks = get_commit_results(commit, results)
    regex = {check: False for check in required_checks}

    print("### regex:", regex)

    for check in workflow_checks:
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


def get_latest_green_commit(commits: List[str], results: List[Dict[str, Any]], required_checks: str) -> Any:
    required_checks = required_checks.split(',')
    print("### required_checks:", required_checks)

    for commit in commits:
        eprint(f"Checking {commit}")
        is_green_status, msg = is_green(commit, results, required_checks)

        if is_green_status:
            eprint("GREEN")
            return commit
        else:
            eprint("RED: " + msg)
    return None


def _arg_parser() -> Any:
    parser = ArgumentParser()
    parser.add_argument("required_checks", type=str)
    parser.add_argument("viable_strict_branch", type=str)

    return parser.parse_args()


def main() -> None:
    args = _arg_parser()

    commits = get_latest_commits(args.viable_strict_branch)
    results = query_commits(commits)

    latest_viable_commit = get_latest_green_commit(commits, results, args.required_checks)
    print(latest_viable_commit)


if __name__ == "__main__":
    """
    The basic logic was taken from the pytorch/pytorch repo -
    https://github.com/pytorch/pytorch/blob/master/.github/scripts/fetch_latest_green_commit.py
    """
    main()
