import argparse
import os
import re
import sys

from github import Github
from tqdm import tqdm


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Clear offline self hosted runners for Github repositories"
    )
    parser.add_argument(
        "entity",
        help="Repository to remove offline self hosted runners for, (ex. pytorch/pytorch)",
        type=str,
    )
    parser.add_argument(
        "--dry-run",
        help="Don't actually remove the runners, just output which runners would be removed",
        action="store_true",
        default=False,
    )
    parser.add_argument(
        "--include",
        help="Regex to match runner names to remove offline runners of",
        type=str,
        default=".*",
    )
    parser.add_argument(
        "--token",
        help="Github token to pull from (Can also pass GITHUB_TOKEN as an env variable)",
        type=str,
        default=os.getenv("GITHUB_TOKEN", ""),
    )
    options = parser.parse_args()
    return options


def main() -> None:
    options = parse_args()
    if options.token == "":
        raise Exception("GITHUB_TOKEN or --token must be set")
    gh = Github(options.token)
    entity_get = gh.get_organization
    if "/" in options.entity:
        entity_get = gh.get_repo
    entity = entity_get(options.entity)
    runners = entity.get_self_hosted_runners()
    include_pattern = re.compile(options.include)
    num_removed = 0
    num_total = 0
    to_delete = list()
    for runner in runners:
        num_total += 1
        if runner.status == "offline" and include_pattern.match(runner.name):
            to_delete.append(runner)
    for runner in tqdm(to_delete):
        if not options.dry_run:
            entity.remove_self_hosted_runner(runner.id)
        num_removed += 1
    print(f"Removed {num_removed}/{num_total}")


if __name__ == "__main__":
    main()
