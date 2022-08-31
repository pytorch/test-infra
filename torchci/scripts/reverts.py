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
}


def find_corresponding_gitlog_commit(
    pr_num: str, list_of_commits: List[GitCommit]
) -> Optional[GitCommit]:
    for i, revert in enumerate(list_of_commits):
        if revert.title.endswith(f'(#{pr_num})"'):
            return list_of_commits.pop(i)
    return None


def format_string_for_markdown(
    commit: GitCommit, rockset_result: Optional[Dict[str, str]] = None
) -> str:
    s = f"- [{commit.title}](https://github.com/pytorch/pytorch/commit/{commit.commit_hash})"
    if rockset_result is not None:
        s += f' by [comment]({rockset_result["comment_url"]})'
    return s


def format_string_for_markdown2(
    commit: GitCommit, rockset_result: Optional[Dict[str, str]] = None
) -> str:
    s = f"- [{commit.title}](https://github.com/pytorch/pytorch/commit/{commit.commit_hash})"
    if rockset_result is not None:
        s += f'\n  - because {rockset_result["message"]} ([comment]({rockset_result["comment_url"]}))'
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
    classifcation_dict1 = defaultdict(lambda: [])
    classifcation_dict2 = defaultdict(lambda: [])

    for rockset_revert in rockset_reverts:
        pr_num = re.search(r"/(\d+)\#", rockset_revert["comment_url"]).group(1)
        commit = find_corresponding_gitlog_commit(pr_num, gitlog_reverts)
        if commit is not None:
            classifcation_dict1[rockset_revert["code"]].append(
                format_string_for_markdown(commit, rockset_revert)
            )
            classifcation_dict2[rockset_revert["code"]].append(
                format_string_for_markdown2(commit, rockset_revert)
            )
        if commit is None:
            print(
                f"I cant find the commit corresponding to {rockset_revert['comment_url']}",
                file=sys.stderr,
            )

    for gitlog_revert in gitlog_reverts:
        classifcation_dict1["manual"].append(format_string_for_markdown(gitlog_revert))
        classifcation_dict2["manual"].append(format_string_for_markdown(gitlog_revert))

    print(f"# Week of {start_time.split('T')[0]} to {end_time.split('T')[0]}")
    for classification, reverts in classifcation_dict1.items():
        print(f"\n### {CLASSIFICATIONS[classification]}\n")
        for revert in reverts:
            print(revert)
    print(f"# Week of {start_time.split('T')[0]} to {end_time.split('T')[0]}")
    for classification, reverts in classifcation_dict2.items():
        print(f"\n### {CLASSIFICATIONS[classification]}\n")
        for revert in reverts:
            print(revert)


if __name__ == "__main__":
    main()
