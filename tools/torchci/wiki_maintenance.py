"""
This script checks the wiki and README files of PyTorch repositories for
maintainers and last verified information.  It clones the repositories, analyzes
the files, and saves the results in CSV format.
"""

import csv
import glob
import os
import subprocess
import tempfile
from collections import namedtuple
from pathlib import Path

from torchci.utils import REPO_ROOT  # type: ignore[import]


PATH = REPO_ROOT / "_logs" / "wiki_maintenance"

Info = namedtuple(
    "Info",
    [
        "file",
        "maintainers",
        "last_verified",
        "last_verified_by",
        "last_edited",
        "last_edited_by",
    ],
)


def clone_repo(tempdir: str, repo: str, branch: str):
    os.chdir(tempdir)
    # Clone the repo
    subprocess.run(
        [
            "git",
            "clone",
            f"https://github.com/{repo}.git",
            f"{repo}",
            f"--branch={branch}",
            "--single-branch",
        ]
    )
    os.chdir(f"{repo}")


def save_csv(files: list[Info], output: Path):
    os.makedirs(output.parent, exist_ok=True)

    with open(output, "w") as f:
        writer = csv.writer(f)
        writer.writerow(Info._fields)
        writer.writerows(files)


def get_last_edited(file: str):
    last_edited_by = (
        subprocess.run(
            ["git", "log", "-1", "--pretty=format:%an", file], capture_output=True
        )
        .stdout.decode()
        .strip()
    )
    # format of date is YYYY-MM-DD
    last_edited_date = (
        subprocess.run(
            ["git", "log", "-1", "--pretty=format:%ad", "--date=short", file],
            capture_output=True,
        )
        .stdout.decode()
        .strip()
    )
    last_edited_date = last_edited_date.split(" ")[0]

    return last_edited_by, last_edited_date


def get_line_last_edited_by(file: str, line: int):
    last_edited_by = (
        subprocess.run(
            ["git", "log", "-1", "--pretty=format:%an", f"-L{line},+1:{file}"],
            capture_output=True,
        )
        .stdout.decode()
        .strip()
        .splitlines()[0]
    )
    return last_edited_by


def analyze_file(file: str):
    magic_string_maintainer = "page maintainers:"
    magic_string_last_verified = "last verified:"
    with open(file) as f:
        lines = f.readlines()
        maintainers = None
        last_verified = None
        last_verified_by = None
        for i, line in enumerate(lines):
            if magic_string_maintainer in line.strip().lower():
                maintainers = line[len(line.split(":")[0]) + 1 :].strip()
            if magic_string_last_verified in line.strip().lower():
                last_verified = line[len(line.split(":")[0]) + 1 :].strip()
                # Wrong if someone just edits the line randomly, like white space or formatting
                last_verified_by = get_line_last_edited_by(file, i)
        last_edited_by, last_edited = get_last_edited(file)
    return Info(
        file, maintainers, last_verified, last_verified_by, last_edited, last_edited_by
    )


def _check_repo(repo: str, branch: str, file_type: str):
    files = []
    with tempfile.TemporaryDirectory() as tempdir:
        clone_repo(tempdir, repo, branch)

        for file in glob.glob(file_type, recursive=True):
            files.append(analyze_file(file))
    save_csv(files, PATH / f"{repo}.csv")


def check_repo_wiki(repo: str):
    repo = f"{repo}.wiki"
    _check_repo(repo, "master", "**/*.md")


def check_repo_readmes(repo: str):
    _check_repo(repo, "main", "**/README.md")


def main():
    print(f"Saving files to {PATH}")
    check_repo_wiki("pytorch/test-infra")
    check_repo_wiki("pytorch/pytorch")
    check_repo_readmes("pytorch/test-infra")
    check_repo_readmes("pytorch/pytorch")


if __name__ == "__main__":
    main()
