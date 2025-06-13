#!/usr/bin/env python3
import csv
import gzip
import io
import os.path
import shlex
from functools import lru_cache
from subprocess import check_output
from typing import Any, Dict, List, NamedTuple, Optional, Union

import boto3  # type: ignore[import-not-found]


METADATA_PATH = "ossci_tutorials_stats/metadata.csv"
FILENAMES_PATH = "ossci_tutorials_stats/filenames.csv"


def run_command(
    cmd: str, cwd: Optional[str] = None, env=Optional[Dict[str, str]]
) -> str:
    """
    Run a shell command.

    Args:
        cmd: Command to run
        cwd: Working directory
        env: Environment variables
    Returns:
        Output of the command.
    """
    return check_output(shlex.split(cmd), cwd=cwd, env=env).decode("utf-8")


def get_history(cwd: Optional[str] = None) -> List[List[str]]:
    """
    Get commit history from git.
    Args:
        cwd: Working directory
    Returns:
        List of commit hashes
    """
    lines = run_command(
        'git log --date=short --pretty=format:%h;"%an";%ad;"%s" --shortstat',
        cwd=cwd,
        env={"TZ": "UTC"},
    ).split("\n")

    def standardize_format(line: str) -> str:
        """
        Parse strings and match all them the following format: x files changed, x insertions(+), x deletions(-).
        Args:
            line: Line to parse
        Returns:
            A string in the following format: x files changed, x insertions(+), x deletions(-).
        """
        # Add missing deletions info
        if "deletion" not in line:
            line += ", 0 deletions(-)"
        elif "insertion" not in line:
            line = ",".join(
                [line.split(",")[0], " 0 insertions(+)", line.split(",")[-1]]
            )
        return line

    def do_replace(x: str) -> str:
        """
        Replace patterns from git log with empty string. This helps us get rid of unnecessary "insertions" and "deletions"
        and we'd like to have only numbers.
        Args:   x: String to replace
        Returns:
            Replaced string
        """
        for pattern in [
            "files changed",
            "file changed",
            "insertions(+)",
            "insertion(+)",
            "deletion(-)",
            "deletions(-)",
        ]:
            x = x.replace(f" {pattern}", "")
        return x

    title = None
    rc: List[List[str]] = []
    for line in lines:
        # Check for weird entries where subject has double quotes or similar issues
        if title is None:
            title = line.split(";", 3)
        # In the lines with stat, add 0 insertions or 0 deletions to make sure we don't break the table
        elif "files changed" in line.replace("file changed", "files changed"):
            stats = do_replace(standardize_format(line)).split(",")
        elif len(line) == 0:
            rc.append(title + stats)
            title = None
        else:
            rc.append(title + ["0", "0", "0"])
            title = line.split(";", 3)
    return rc


class FileInfo(NamedTuple):
    filename: str
    lines_added: int
    lines_deleted: int


class CommitInfo(NamedTuple):
    commit_id: str
    date: str
    files: List[FileInfo]


def get_file_names(
    cwd: Optional[str] = None,
    path_filter: Optional[str] = None,
) -> List[CommitInfo]:
    cmd = "git log --date=short --pretty='format:%h;%ad' --numstat"
    if path_filter:
        cmd += f" -- {path_filter}"
    lines = run_command(
        cmd,
        cwd=cwd,
        env={"TZ": "UTC"},
    ).split("\n")
    rc: List[CommitInfo] = []

    for line in lines:
        line = line.strip()
        if not line:
            continue
        elif len(line.split("\t")) != 3:
            commit_hash, date = line.split(";")
            rc.append(CommitInfo(commit_hash, date, []))
        else:
            added, deleted, name = line.split("\t")
            # Special casing for binary files
            if added == "-":
                assert deleted == "-"
                rc[-1].files.append(FileInfo(name, -1, -1))
            else:
                rc[-1].files.append(FileInfo(name, int(added), int(deleted)))
    return rc


def convert_to_dict(
    entry: CommitInfo,
) -> List[Dict[str, Union[str, int]]]:
    return [
        {
            "commit_id": entry.commit_id,
            "date": entry.date,
            "filename": i.filename,
            "lines_added": i.lines_added,
            "lines_deleted": i.lines_deleted,
        }
        for i in entry.files
    ]


@lru_cache
def get_s3_resource() -> Any:
    return boto3.resource("s3")


def upload_to_s3(
    bucket_name: str,
    key: str,
    docs: list[dict[str, Any]],
) -> None:
    print(f"Writing {len(docs)} documents to S3")
    body = conv_to_csv(docs)

    get_s3_resource().Object(
        f"{bucket_name}",
        f"{key}",
    ).put(
        Body=gzip.compress(body.getvalue().encode()),  # type: ignore[attr-defined]
        ContentEncoding="gzip",
        ContentType="application/csv",
    )
    print("Done!")


def conv_to_csv(json_data: List[Dict[str, Any]]) -> io.StringIO:
    # Will not handle nested
    body = io.StringIO()
    f = csv.writer(body)

    alphabetized_keys = sorted(json_data[0].keys())

    for item in json_data:
        f.writerow([item[key] for key in alphabetized_keys])
    return body


def main() -> None:
    # Process the tutorials repo
    print("Processing tutorials repo")
    tutorials_dir = os.path.expanduser("./tutorials")
    tutorials_history_log = get_history(tutorials_dir)
    tutorials_commits_to_files = get_file_names(tutorials_dir)

    # Process the pytorch/docs dir
    print("Processing pytorch/docs dir")
    pytorch_docs_dir = os.path.expanduser("./pytorch/docs")
    pytorch_docs_history_log = get_history(pytorch_docs_dir)
    pytorch_docs_commits_to_files = get_file_names(
        os.path.expanduser("./pytorch"), "docs"
    )

    # Combine the two histories

    history_log = [
        {
            "commit_id": i[0],
            "author": i[1],
            "date": i[2],
            "title": i[3],
            "number_of_changed_files": int(i[4]),
            "lines_added": int(i[5]),
            "lines_deleted": int(i[6]),
            "repo": "tutorials",
        }
        for i in tutorials_history_log
    ]

    history_log.extend(
        [
            {
                "commit_id": i[0],
                "author": i[1],
                "date": i[2],
                "title": i[3],
                "number_of_changed_files": int(i[4]),
                "lines_added": int(i[5]),
                "lines_deleted": int(i[6]),
                "repo": "pytorch",
            }
            for i in pytorch_docs_history_log
        ]
    )

    # Combine the two commits to files

    filenames = []
    for entry in tutorials_commits_to_files:
        items = convert_to_dict(entry)
        for item in items:
            item["filename"] = f"tutorials/{item['filename']}"
        filenames.extend(items)

    for entry in pytorch_docs_commits_to_files:
        items = convert_to_dict(entry)
        for item in items:
            item["filename"] = f"pytorch/{item['filename']}"
        filenames.extend(items)

    # Upload data to S3 as csv with gzip compression and no header line

    print(f"Uploading data to {METADATA_PATH}")
    upload_to_s3(
        "ossci-raw-job-status",
        f"{METADATA_PATH}",
        history_log,
    )
    print(f"Finished uploading data to {METADATA_PATH}")

    # Upload filenames to S3
    print(f"Uploading data to {FILENAMES_PATH}")
    upload_to_s3(
        "ossci-raw-job-status",
        f"{FILENAMES_PATH}",
        filenames,
    )
    print(f"Finished uploading data to {FILENAMES_PATH}")
    print(f"Success!")


if __name__ == "__main__":
    main()
