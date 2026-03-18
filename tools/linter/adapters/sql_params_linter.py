import argparse
import concurrent.futures
import json
import logging
import os
import re
import subprocess
import time
from enum import Enum
from typing import List, NamedTuple, Optional, Pattern


LINTER_CODE = "SQL_PARAMS"


class LintSeverity(str, Enum):
    ERROR = "error"
    WARNING = "warning"
    ADVICE = "advice"
    DISABLED = "disabled"


class LintMessage(NamedTuple):
    path: Optional[str]
    line: Optional[int]
    char: Optional[int]
    code: str
    severity: LintSeverity
    name: str
    original: Optional[str]
    replacement: Optional[str]
    description: Optional[str]


RESULTS_RE: Pattern[str] = re.compile(
    r"""(?mx)
    ^
    (?P<file>.*?):
    (?P<line>\d+):
    (?P<char>\d+):
    \s(?P<message>.*)
    \s(?P<code>\[.*\])
    $
    """
)


def run_command(
    args: List[str],
) -> "subprocess.CompletedProcess[bytes]":
    logging.debug("$ %s", " ".join(args))
    start_time = time.monotonic()
    try:
        return subprocess.run(
            args,
            capture_output=True,
        )
    finally:
        end_time = time.monotonic()
        logging.debug("took %dms", (end_time - start_time) * 1000)


def check_file(
    filename: str,
) -> List[LintMessage]:
    with open(filename, "rb") as f:
        data = json.load(f)

    message = []
    if "params" not in data:
        message.append("The file does not contain a 'params' key.")
    elif not isinstance(data["params"], dict):
        message.append("The 'params' key is not a dictionary.")
    if "tests" not in data:
        message.append("The file does not contain a 'tests' key.")
    elif not isinstance(data["tests"], list):
        message.append("The 'tests' key is not a list.")
    if len(message) > 0:
        return [
            LintMessage(
                path=filename,
                line=None,
                char=None,
                code=LINTER_CODE,
                severity=LintSeverity.WARNING,
                name="lint",
                replacement=None,
                original=None,
                description="; ".join(message),
            )
        ]
    return []


def main() -> None:
    parser = argparse.ArgumentParser(
        description=f"A simple linter for params.json files for sql queries",
        fromfile_prefix_chars="@",
    )
    parser.add_argument(
        "filenames",
        nargs="+",
        help="paths to lint",
    )

    args = parser.parse_args()

    with concurrent.futures.ThreadPoolExecutor(
        max_workers=os.cpu_count(),
        thread_name_prefix="Thread",
    ) as executor:
        futures = {
            executor.submit(
                check_file,
                filename,
            ): filename
            for filename in args.filenames
        }
        for future in concurrent.futures.as_completed(futures):
            try:
                for lint_message in future.result():
                    print(json.dumps(lint_message._asdict()), flush=True)
            except Exception:
                logging.critical('Failed at "%s".', futures[future])
                raise


if __name__ == "__main__":
    main()
