import os
import argparse
from datetime import datetime, timedelta

from github import Github


def pretty_time_delta(seconds):
    # taken from https://gist.github.com/thatalextaylor/7408395
    sign_string = '-' if seconds < 0 else ''
    seconds = abs(int(seconds))
    days, seconds = divmod(seconds, 86400)
    hours, seconds = divmod(seconds, 3600)
    minutes, seconds = divmod(seconds, 60)
    if days > 0:
        return '%s%dd%dh%dm%ds' % (sign_string, days, hours, minutes, seconds)
    elif hours > 0:
        return '%s%dh%dm%ds' % (sign_string, hours, minutes, seconds)
    elif minutes > 0:
        return '%s%dm%ds' % (sign_string, minutes, seconds)
    else:
        return '%s%ds' % (sign_string, seconds)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Re-kicks queued workflows")
    parser.add_argument(
        "repo",
        help="Repository to run script on, (ex. pytorch/pytorch)",
        type=str,
    )
    parser.add_argument(
        "--longer-than",
        help="Number of minutes that a workflow is queued, workflows queued for less time will not be re-run",
        type=int,
        default=10,
    )
    parser.add_argument(
        "--dry-run",
        help="Don't actually remove the runners, just output which runners would be removed",
        action="store_true",
        default=False,
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
    queued_workflows = repo.get_workflow_runs(status="queued")
    for workflow in queued_workflows:
        queued_for = f"(Queued for {pretty_time_delta((workflow.updated_at - datetime.now()).total_seconds()):>10})"
        if workflow.updated_at > datetime.now() - timedelta(
            minutes=options.longer_than
        ):
            print(f"+ {queued_for:^15} {workflow.html_url}...", end="")
            if options.dry_run:
                print("skipped (DRY_RUN)")
            else:
                workflow.rerun()


if __name__ == "__main__":
    main()
