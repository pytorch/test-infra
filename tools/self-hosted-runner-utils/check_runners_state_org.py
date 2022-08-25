import os
import argparse
import re
from dataclasses import dataclass, field
from collections import defaultdict
from typing import Dict

from github import Github, SelfHostedActionsRunner, PaginatedList


@dataclass
class RunnersState:
    num_total: int = 0
    num_online: int = 0
    num_per_label: Dict[str, int] = field(default_factory=lambda: defaultdict(int))
    num_busy_per_label: Dict[str, int] = field(default_factory=lambda: defaultdict(int))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Display self hosted runners state for Github repositories"
    )
    parser.add_argument(
        "org",
        help="Repository to remove offline self hosted runners for, (ex. pytorch/pytorch)",
        type=str,
    )
    parser.add_argument(
        "--repo",
        help="Repository to remove offline self hosted runners for, (ex. pytorch/pytorch)",
        type=str,
    )
    parser.add_argument(
        "--include",
        help="Regex to match runner names",
        type=str,
        default=".*",
    )
    parser.add_argument(
        "--token",
        required=True,
        help="Github token to pull from (Can also pass GITHUB_TOKEN as an env variable)",
        type=str,
        default=os.getenv("GITHUB_TOKEN", ""),
    )
    options = parser.parse_args()
    return options


def get_self_hosted_runners_org(org):
    return PaginatedList.PaginatedList(
        SelfHostedActionsRunner.SelfHostedActionsRunner,
        org._requester,
        f"https://api.github.com/orgs/{org.login}/actions/runners",
        None,
        list_item="runners",
    )


def main() -> None:
    options = parse_args()
    gh = Github(options.token)
    org = gh.get_organization(options.org)
    runners = get_self_hosted_runners_org(org)
    include_pattern = re.compile(options.include)
    state = RunnersState()
    for runner in runners:
        if not include_pattern.match(runner.name):
            continue
        state.num_total += 1
        if runner.status == "online":
            state.num_online += 1
            for label in runner.labels():
                if label.get("type") == "custom" and label:
                    state.num_per_label[str(label["name"])] += 1
                    if runner.busy:
                        state.num_busy_per_label[str(label["name"])] += 1
    over_total = lambda num: f"{num}/{state.num_total}"
    percentage_of = lambda num, label: f"{state.num_busy_per_label[label]}/{num}"
    print(f"Self Hosted stats for {options.org}")
    print(f"{state.num_total:>15} total runners")
    print(f"{over_total(state.num_online):>15} online runners")
    print()
    print("Number of busy/online runners per label")
    for label, num_label in sorted(state.num_per_label.items()):
        print(f"{percentage_of(num_label, label):>15} {label}")

    if options.repo:
        repo = gh.get_repo(f"{options.org}/{options.repo}")
        num_queued_workflows = len([_ for _ in repo.get_workflow_runs(status="queued")])
        num_in_progress_workflows = len(
            [_ for _ in repo.get_workflow_runs(status="in_progress")]
        )
        print()
        print(f"Workflow stats for {options.org}")
        print(f"{num_queued_workflows:>15} queued workflows")
        print(f"{num_in_progress_workflows:>15} in_progress workflows")


if __name__ == "__main__":
    main()
