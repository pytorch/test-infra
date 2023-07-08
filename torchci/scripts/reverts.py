import argparse
import datetime
import os
import re
import shlex
import sys
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

from rockset import RocksetClient  # type: ignore[import]

from torchci.scripts.github_analyze import GitCommit  # type: ignore[import]
from torchci.scripts.github_analyze import GitRepo

# Should match the contents produced by trymerge on revert
RE_REVERT_COMMIT_BODY = r"Reverted .* on behalf of .* due to .* \(\[comment\]\((.*)\)\)"

CLASSIFICATIONS = {
    "nosignal": "No Signal",
    "ignoredsignal": "Ignored Signal",
    "landrace": "Landrace",
    "weird": "Weird",
    "ghfirst": "GHFirst",
    "manual": "Not through pytorchbot",
}

ROCKSET_REVERT_QUERY = """
SELECT
    ic._event_time revert_time,
    ic.user.login as reverter,
    ic.body,
    ic.html_url as comment_url
FROM
    commons.issue_comment AS ic
WHERE
    REGEXP_LIKE(
        ic.body,
        '^ *@pytorch(merge|)bot revert'
    )
    AND ic._event_time >= PARSE_TIMESTAMP_ISO8601(:startTime)
    AND ic._event_time < PARSE_TIMESTAMP_ISO8601(:stopTime)
    AND ic.user.login != 'pytorch-bot[bot]'
"""


def parse_body(body: str) -> argparse.Namespace:
    parser = argparse.ArgumentParser()

    parser.add_argument("-c", "--classification")
    parser.add_argument("-m", "--message")

    return parser.parse_args(shlex.split(" ".join(body.split(" ")[2:])))


def format_string_for_markdown_long(
    commit: Optional[GitCommit], rockset_result: Optional[Dict[str, str]] = None
) -> str:
    s = ""
    if commit is None:
        s += "- cannot find commit corresponding to @pytorchbot revert comment"
    else:
        s = f"- [{commit.title}](https://github.com/pytorch/pytorch/commit/{commit.commit_hash})"
    if rockset_result is not None:
        s += f'\n  - {rockset_result["message"]} ([comment]({rockset_result["comment_url"]}))'
    s += "\n"
    return s


def get_start_stop_times() -> Tuple[str, str]:
    today = datetime.date.today()
    start_time_date = today + datetime.timedelta(days=-today.weekday(), weeks=-1)
    end_time_date = today + datetime.timedelta(days=-today.weekday())
    start_time = f"{start_time_date}T00:13:30.000Z"
    end_time = f"{end_time_date}T00:13:30.000Z"
    return start_time, end_time


def get_rockset_reverts(start_time: str, end_time: str) -> List[Dict[str, str]]:
    params = {
        "startTime": start_time,
        "stopTime": end_time,
    }
    ROCKSET_API_KEY = os.environ.get("ROCKSET_API_KEY")
    if ROCKSET_API_KEY is None:
        raise RuntimeError("ROCKSET_API_KEY not set")

    client = RocksetClient(
        api_key=ROCKSET_API_KEY,
        host="https://api.usw2a1.rockset.com",
    )
    response = client.sql(ROCKSET_REVERT_QUERY, params=params)
    res: List[Dict[str, str]] = response.results

    cleaned_up: List[Dict[str, str]] = []
    # re-parse message to reduce errors, should really just upload to rockset from pytorchbot or trymerge
    for revert in res:
        body = revert["body"].splitlines()[0].strip()
        try:
            parse = parse_body(body)
            if parse.classification is None or parse.message is None:
                # comment is badly formed
                continue
            revert["code"] = parse.classification
            revert["message"] = parse.message
            cleaned_up.append(revert)
        except (Exception, SystemExit) as e:
            print(
                f"failed to parse {revert['comment_url']}: {revert['body']}",
                file=sys.stderr,
            )
            print(e, file=sys.stderr)
            continue

    return cleaned_up


def get_gitlog_reverts(start_time: str, end_time: str) -> List[GitCommit]:
    repo_path = "../pytorch"
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
    rockset_reverts = get_rockset_reverts(start_time, end_time)
    gitlog_reverts = get_gitlog_reverts(start_time, end_time)
    # map classification type -> list of (commit, rockset result)
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
        for rockset_revert in rockset_reverts:
            if rockset_revert["comment_url"] == comment_url:
                classification_dict[rockset_revert["code"]].append(
                    (gitlog_revert, rockset_revert)
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
            for commit, rockset_result in reverts:
                f.write(format_string_for_markdown_long(commit, rockset_result))
    print(filename)


if __name__ == "__main__":
    main()
