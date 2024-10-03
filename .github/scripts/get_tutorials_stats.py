#!/usr/bin/env python3
import csv
import gzip
import io
import os.path
import shlex
from functools import lru_cache
from subprocess import check_output
from typing import Any, Dict, List, Optional, Tuple, Union

import boto3  # type: ignore[import]

METADATA_PATH = "ossci_tutorials_stats/metadata.csv"
FILENAMES_PATH = "ossci_tutorials_stats/filenames.csv"


def run_command(cmd: str, cwd: Optional[str] = None) -> str:
    """
    Run a shell command.

    Args:
        cmd: Command to run
        cwd: Working directory
    Returns:
        Output of the command.
    """
    return check_output(shlex.split(cmd), cwd=cwd).decode("utf-8")


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


def get_file_names(
    cwd: Optional[str] = None,
) -> List[Tuple[str, List[Tuple[str, int, int]]]]:
    lines = run_command("git log --pretty='format:%h' --numstat", cwd=cwd).split("\n")
    rc = []
    commit_hash = ""
    files: List[Tuple[str, int, int]] = []
    for line in lines:
        if not line:
            # Git log uses empty line as separator between commits (except for oneline case)
            rc.append((commit_hash, files))
            commit_hash, files = "", []
        elif not commit_hash:
            # First line is commit short hash
            commit_hash = line
        elif len(line.split("\t")) != 3:
            # Encountered an empty commit
            assert len(files) == 0
            rc.append((commit_hash, files))
            commit_hash = line
        else:
            added, deleted, name = line.split("\t")
            # Special casing for binary files
            if added == "-":
                assert deleted == "-"
                files.append((name, -1, -1))
            else:
                files.append((name, int(added), int(deleted)))
    return rc


def convert_to_dict(
    entry: Tuple[str, List[Tuple[str, int, int]]]
) -> List[Dict[str, Union[str, int]]]:
    return [
        {
            "commit_id": entry[0],
            "filename": i[0],
            "lines_added": i[1],
            "lines_deleted": i[2],
        }
        for i in entry[1]
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
        Body=gzip.compress(body.getvalue().encode()),
        ContentEncoding="gzip",
        ContentType="application/csv",
    )
    print("Done!")


def conv_to_csv(json_data: List[Dict[str, Any]]) -> str:
    # Will not handle nested
    body = io.StringIO()
    f = csv.writer(body)

    alphabetized_keys = sorted(json_data[0].keys())

    for item in json_data:
        f.writerow([item[key] for key in alphabetized_keys])
    return body


def main() -> None:
    tutorials_dir = os.path.expanduser("./tutorials")
    get_history_log = get_history(tutorials_dir)
    commits_to_files = get_file_names(tutorials_dir)

    # Upload data to S3

    print(f"Uploading data to {METADATA_PATH}")
    history_log = [
        {
            "commit_id": i[0],
            "author": i[1],
            "date": i[2],
            "title": i[3],
            "number_of_changed_files": int(i[4]),
            "lines_added": int(i[5]),
            "lines_deleted": int(i[6]),
        }
        for i in get_history_log
    ]
    upload_to_s3(
        "ossci-raw-job-status",
        f"{METADATA_PATH}",
        history_log,
    )
    print(f"Finished uploading data to {METADATA_PATH}")

    print(f"Uploading data to {FILENAMES_PATH}")
    filenames = []
    for entry in commits_to_files:
        items = convert_to_dict(entry)
        filenames.extend(items)
    upload_to_s3(
        "ossci-raw-job-status",
        f"{FILENAMES_PATH}",
        filenames,
    )
    print(f"Finished uploading data to {FILENAMES_PATH}")
    print(f"Success!")


if __name__ == "__main__":
    main()
