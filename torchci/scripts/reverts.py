from collections import defaultdict
import datetime
import re
from torchci.scripts.github_analyze import GitCommit, GitRepo
import json
import os
from typing import Dict, List, Optional
from rockset import Client, ParamDict
import sys


CLASSIFICATIONS = {
    "nosignal": "No Signal",
    "ignoredsignal": "Ignored Signal",
    "landrace": "Landrace",
    "weird": "Weird",
    "ghfirst": "GHFirst",
    "manual": "Not through pytorchbot",
    "unknown": "Got @pytorchbot revert command, but no corresponding commit"
}


def find_corresponding_gitlog_commit(
    pr_num: str, list_of_commits: List[GitCommit]
) -> Optional[GitCommit]:
    for i, revert in enumerate(list_of_commits):
        if revert.title.endswith(f'(#{pr_num})"'):
            return list_of_commits.pop(i)
    return None


def format_string_for_markdown_short(
    commit: Optional[GitCommit], rockset_result: Optional[Dict[str, str]] = None
) -> str:
    s = ""
    if commit is None:
        s += "- cannot find commit corresponding to @pytorchbot revert comment"
    else:
        s += f"- [{commit.title}](https://github.com/pytorch/pytorch/commit/{commit.commit_hash})"
    if rockset_result is not None:
        s += f' by [comment]({rockset_result["comment_url"]})'
    return s


def format_string_for_markdown_long(
    commit: GitCommit, rockset_result: Optional[Dict[str, str]] = None
) -> str:
    s = ""
    if commit is None:
        s += "- cannot find commit corresponding to @pytorchbot revert comment"
    else:
        s = f"- [{commit.title}](https://github.com/pytorch/pytorch/commit/{commit.commit_hash})"
    if rockset_result is not None:
        s += f'\n  - {rockset_result["message"]} ([comment]({rockset_result["comment_url"]}))'
    return s


def get_start_stop_times():
    today = datetime.date.today()
    start_time = today + datetime.timedelta(days=-today.weekday(), weeks=-1)
    end_time = today + datetime.timedelta(days=-today.weekday())
    start_time = f"{start_time}T00:13:30.000Z"
    end_time = f"{end_time}T00:13:30.000Z"
    return start_time, end_time


def get_rockset_reverts(start_time: str, end_time: str) -> List[Dict[str, str]]:
    params = ParamDict(
        {
            "startTime": start_time,
            "stopTime": end_time,
        }
    )
    ROCKSET_API_KEY = os.environ.get("ROCKSET_API_KEY")
    if ROCKSET_API_KEY is None:
        raise RuntimeError("ROCKSET_API_KEY not set")

    with open("torchci/rockset/prodVersions.json") as f:
        prod_versions = json.load(f)

    client = Client(
        api_key=ROCKSET_API_KEY,
        api_server="https://api.rs2.usw2.rockset.com",
    )
    qlambda = client.QueryLambda.retrieve(
        "reverted_prs_with_reason",
        version=prod_versions["commons"]["reverted_prs_with_reason"],
        workspace="commons",
    )

    return qlambda.execute(parameters=params).results


def get_gitlog_reverts(start_time: str, end_time: str):
    repo_path = "../pytorch"
    remote = "origin"
    repo = GitRepo(repo_path, remote)
    all_commits = repo._run_git_log(
        f"{remote}/master", [f"--since={start_time}", f"--before={end_time}"]
    )

    return [
        commit
        for commit in all_commits
        if commit.title.startswith("Revert") or commit.title.startswith("Back out")
    ]


def main():
    start_time, end_time = get_start_stop_times()
    rockset_reverts = get_rockset_reverts(start_time, end_time)
    gitlog_reverts = get_gitlog_reverts(start_time, end_time)
    classification_dict = defaultdict(lambda: [])

    for rockset_revert in rockset_reverts:
        pr_num = re.search(r"/(\d+)\#", rockset_revert["comment_url"]).group(1)
        commit = find_corresponding_gitlog_commit(pr_num, gitlog_reverts)
        if commit is not None:
            classification_dict[rockset_revert["code"]].append((commit, rockset_revert))
        else:
            classification_dict["unknown"].append((None, rockset_revert))

    for gitlog_revert in gitlog_reverts:
        classification_dict["manual"].append((gitlog_revert, None))

    print(f"# Week of {start_time.split('T')[0]} to {end_time.split('T')[0]}")
    for classification, reverts in classification_dict.items():
        print(f"\n### {CLASSIFICATIONS[classification]}\n")
        for commit, rockset_result in reverts:
            print(format_string_for_markdown_short(commit, rockset_result))
    print(f"# Week of {start_time.split('T')[0]} to {end_time.split('T')[0]}")
    for classification, reverts in classification_dict.items():
        print(f"\n### {CLASSIFICATIONS[classification]}\n")
        for commit, rockset_result in reverts:
            print(format_string_for_markdown_long(commit, rockset_result))


if __name__ == "__main__":
    main()
