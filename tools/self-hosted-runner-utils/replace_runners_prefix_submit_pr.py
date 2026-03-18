#!/bin/bash

"""
This script is used to replace the prefix of the runners from the scale config file on GH workflows and submit PRs to the repos,

it is a **hacky script** that is useful to help test new runners in partner repos to quickly open PRs agains them and run CI.

it depends on git and gh command line tools, so make sure you have them installed and configured.
"""

import argparse
import fnmatch
import os
import subprocess
import sys
from datetime import datetime

import yaml


REPOS = [
    "https://github.com/pytorch/audio",
    "https://github.com/pytorch/benchmark",
    "https://github.com/pytorch/captum",
    "https://github.com/pytorch/cppdocs",
    "https://github.com/pytorch/executorch",
    "https://github.com/pytorch/FBGEMM",
    "https://github.com/pytorch/ignite",
    "https://github.com/pytorch/pytorch.github.io",
    "https://github.com/pytorch/serve",
    "https://github.com/pytorch/text",
    "https://github.com/pytorch/torchrec",
    "https://github.com/pytorch/torchtune",
    "https://github.com/pytorch/vision",
]


def get_opts() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--scale-config", type=str, required=True)
    parser.add_argument(
        "--temp-folder", type=str, default="/Users/jschmidt/.the_tmp_repl_runners"
    )
    parser.add_argument("--prefix", type=str, default="amz2023.")
    return parser.parse_args()


def get_runners_names(prefix: str, scale_config: str) -> list[str]:
    with open(scale_config, "r") as f:
        config = yaml.safe_load(f)
    runners_w_prefix = set(
        runner_name.replace(prefix, "")
        for runner_name in config["runner_types"].keys()
        if runner_name.startswith(prefix)
    )
    runners_wo_prefix = [
        runner_name
        for runner_name in config["runner_types"].keys()
        if not runner_name.startswith(prefix) and runner_name in runners_w_prefix
    ]
    runners_wo_prefix.sort()

    runners = [
        runners_wo_prefix[0],
    ]
    for idx in range(1, len(runners_wo_prefix)):
        if runners_wo_prefix[idx].startswith(runners[-1]):
            continue
        runners.append(runners_wo_prefix[idx])

    return runners


def find_replace(directory, runners, prefix, filePattern) -> None:  # type: ignore[no-untyped-def]
    for path, dirs, files in os.walk(os.path.abspath(directory)):
        for filename in fnmatch.filter(files, filePattern):
            filepath = os.path.join(path, filename)
            try:
                with open(filepath) as f:
                    s = f.read()
                for runner in runners:
                    s = s.replace(runner, f"{prefix}{runner}")
                with open(filepath, "w") as f:
                    f.write(s)
            except Exception as e:
                print(f"Error: {e}")
                continue


def commit_push_open_pr(
    repo_name: str, temp_folder: str, branch_name: str, comment: str
) -> None:
    subprocess.run(
        ["git", "add", "-A"],
        cwd=f"{temp_folder}/{repo_name}",
    )
    subprocess.run(
        ["git", "commit", "-m", comment],
        cwd=f"{temp_folder}/{repo_name}",
    )
    subprocess.run(
        ["git", "push", "origin", branch_name],
        cwd=f"{temp_folder}/{repo_name}",
    )
    subprocess.run(
        [
            "gh",
            "pr",
            "create",
            "--repo",
            f"pytorch/{repo_name}",
            "--base",
            "main",
            "--head",
            branch_name,
            "--title",
            comment,
            "--body",
            f"testing new runners",
        ],
        cwd=f"{temp_folder}/{repo_name}",
    )


def open_branch(repo: str, repo_name: str, temp_folder: str, branch_name: str) -> None:
    subprocess.run(
        [
            "git",
            "clone",
            repo,
            f"{temp_folder}/{repo_name}",
        ]
    )
    subprocess.run(
        [
            "git",
            "branch",
            branch_name,
        ],
        cwd=f"{temp_folder}/{repo_name}",
    )
    subprocess.run(
        [
            "git",
            "checkout",
            branch_name,
        ],
        cwd=f"{temp_folder}/{repo_name}",
    )


def main() -> None:
    opts = get_opts()
    runners = get_runners_names(opts.prefix, opts.scale_config)
    branch_name = f"replace_runners_prefix_{datetime.today().strftime('%Y%m%d%H%M%S')}"
    subprocess.run(
        [
            "rm",
            "-rf",
            opts.temp_folder,
        ]
    )
    subprocess.run(
        [
            "mkdir",
            "-p",
            opts.temp_folder,
        ]
    )
    try:
        for repo in REPOS:
            repo_name = repo.split("/")[-1]
            open_branch(repo, repo_name, opts.temp_folder, branch_name)
            find_replace(f"{opts.temp_folder}/{repo_name}", runners, opts.prefix, "*")
            commit_push_open_pr(
                repo_name,
                opts.temp_folder,
                branch_name,
                f"Replace runners prefix {opts.prefix}",
            )
    finally:
        pass
        subprocess.run(
            [
                "rm",
                "-rf",
                opts.temp_folder,
            ]
        )


if __name__ == "__main__":
    main()
