import os
import argparse
import re

from github import Github


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Clear offline self hosted runners for Github repositories"
    )
    parser.add_argument(
        "repo",
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
    repo = gh.get_repo(options.repo)
    runners = repo.get_self_hosted_runners()
    include_pattern = re.compile(options.include)
    for runner in runners:
        if runner.status != "offline" or not include_pattern.match(runner.name):
            continue
        print(f"- {runner.name} ", end="")
        if options.dry_run:
            print("skipped (dry run)")
        else:
            repo.remove_self_hosted_runner(runner)
            print("removed")


if __name__ == "__main__":
    main()
