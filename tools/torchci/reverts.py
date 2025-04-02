import argparse
import datetime
import os
import re
import shlex
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from analytics.github_analyze import GitCommit, GitRepo
from torchci.clickhouse import query_clickhouse


# Should match the contents produced by trymerge on revert
RE_REVERT_COMMIT_BODY = r"Reverted .* on behalf of .* due to .* \(\[comment\]\((.*)\)\)"

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

CLASSIFICATIONS = {
    "nosignal": "No Signal",
    "ignoredsignal": "Ignored Signal",
    "landrace": "Landrace",
    "weird": "Weird",
    "ghfirst": "GHFirst",
    "manual": "Not through pytorchbot",
}

DB_REVERT_QUERY = """
SELECT
    ic.user.login as reverter,
    ic.body,
    ic.html_url as comment_url
FROM
    default.issue_comment AS ic final
WHERE
    match(
        ic.body,
        '@pytorch(merge|)bot +revert'
    )
    AND ic.created_at >= {startTime: DateTime64}
    AND ic.created_at < {stopTime: DateTime64}
    AND ic.user.login != 'pytorch-bot[bot]'
"""


class ErrorRaisingArgumentParser(argparse.ArgumentParser):
    """
    Raises an exception on unrecognized arguments that can be caught.  The
    default argument parser exits.
    Reference: https://stackoverflow.com/questions/73441232/raise-exception-if-argumentparser-encounters-unknown-argument
    """

    def error(self, message):
        raise ValueError(message)


def parse_body(revert: Dict[str, str]) -> None:
    parser = ErrorRaisingArgumentParser()
    subparser = parser.add_subparsers()
    group = subparser.add_parser("revert")

    group.add_argument("-c", "--classification")
    group.add_argument("-m", "--message")
    for line in revert["body"].splitlines():
        try:
            command = shlex.split(re.sub(r"@pytorch(merge|)bot", "", line.strip()))
            parsed = parser.parse_args(command)
            if parsed.classification is None or parsed.message is None:
                continue
            revert["code"] = parsed.classification
            revert["message"] = parsed.message
            return
        except (ValueError, AttributeError):
            continue
    raise RuntimeError(f"failed to parse {revert['comment_url']}")


def format_string_for_markdown_long(
    commit: Optional[GitCommit], db_result: Optional[Dict[str, str]] = None
) -> str:
    s = ""
    if commit is None:
        s += "- cannot find commit corresponding to @pytorchbot revert comment"
    else:
        s = f"- [{commit.title}](https://github.com/pytorch/pytorch/commit/{commit.commit_hash})"
    if db_result is not None:
        s += f'\n  - {db_result["message"]} ([comment]({db_result["comment_url"]}))'
    s += "\n"
    return s


def get_start_stop_times() -> Tuple[str, str]:
    today = datetime.date.today()
    start_time_date = today + datetime.timedelta(days=-today.weekday(), weeks=-1)
    end_time_date = today + datetime.timedelta(days=-today.weekday())
    start_time = f"{start_time_date}T00:13:30.000Z"
    end_time = f"{end_time_date}T00:13:30.000Z"
    return start_time, end_time


def get_db_reverts(start_time: str, end_time: str) -> Dict[str, Dict[str, str]]:
    params = {
        "startTime": start_time[:-1],  # Remove Z
        "stopTime": end_time[:-1],
    }
    res: List[Dict[str, str]] = query_clickhouse(DB_REVERT_QUERY, params)
    return {revert["comment_url"]: revert for revert in res}


def get_gitlog_reverts(start_time: str, end_time: str) -> List[GitCommit]:
    repo_path = REPO_ROOT / ".." / "pytorch"
    remote = "origin"
    repo = GitRepo(repo_path, remote)
    all_commits = repo._run_git_log(
        f"{remote}/main", [f"--since={start_time}", f"--before={end_time}"]
    )

    return [
        commit
        for commit in all_commits
        if commit.title.startswith("Revert") or commit.title.startswith("Back out")
    ]


def main() -> None:
    start_time, end_time = get_start_stop_times()
    db_reverts = get_db_reverts(start_time, end_time)
    gitlog_reverts = get_gitlog_reverts(start_time, end_time)
    # map classification type -> list of (commit, db result)
    classification_dict: Dict[
        str, List[Tuple[Optional[str], Optional[Dict[str, str]]]]
    ] = defaultdict(lambda: [])

    for gitlog_revert in gitlog_reverts:
        comment_match = re.search(
            RE_REVERT_COMMIT_BODY,
            gitlog_revert.body,
        )
        if comment_match is None:
            classification_dict["manual"].append((gitlog_revert, None))
            continue
        comment_url = comment_match[1]
        db_revert = db_reverts[comment_url]
        parse_body(db_revert)
        classification_dict[db_revert["code"]].append((gitlog_revert, db_revert))

    assert sum(len(code) for code in classification_dict.values()) == len(
        gitlog_reverts
    )

    filename = f"{start_time.split('T')[0]}.md"
    with open(filename, "w") as f:
        num_reverts = sum([len(reverts) for reverts in classification_dict.values()])
        f.write(
            f"# Week of {start_time.split('T')[0]} to {end_time.split('T')[0]} ({num_reverts})\n"
        )
        for classification, reverts in sorted(
            classification_dict.items(), key=lambda x: x[0]
        ):
            f.write(f"\n### {CLASSIFICATIONS[classification]} ({len(reverts)})\n\n")
            for commit, db_result in reverts:
                f.write(format_string_for_markdown_long(commit, db_result))

    # Probably not a great idea but at least this way I never have to worry
    # about print to stdout vs stderr
    with open("revert_file_name.txt", "w") as f:
        f.write(filename)
    print(filename)


if __name__ == "__main__":
    main()
