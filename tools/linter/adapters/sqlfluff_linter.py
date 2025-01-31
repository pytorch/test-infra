import argparse
import concurrent.futures
import json
import logging
import os
import re
import subprocess
import tempfile
import time
from enum import Enum
from typing import List, NamedTuple, Optional, Pattern

from isort.api import _tmp_file


LINTER_CODE = "SQLFLUFF"


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
    with open(filename, "r") as f:
        original = f.read()
        original_edited = original.replace("{", "'{").replace("}", "}'")

    tmp = tempfile.NamedTemporaryFile(suffix=".sql")
    with open(tmp.name, "w") as f:
        f.write(original_edited)
    try:
        proc = run_command(
            [
                "sqlfluff",
                "format",
                "--config",
                os.path.join(os.getcwd(), ".sqlfluff"),
                "--dialect",
                "clickhouse",
                tmp.name,
            ]
        )
    except OSError as err:
        return [
            LintMessage(
                path=None,
                line=None,
                char=None,
                code=LINTER_CODE,
                severity=LintSeverity.ERROR,
                name="command-failed",
                original=None,
                replacement=None,
                description=(f"Failed due to {err.__class__.__name__}:\n{err}"),
            )
        ]

    with open(tmp.name, "r") as f:
        replacement = f.read().replace("'{", "{").replace("}'", "}")
    if original == replacement:
        return []
    lint_message = proc.stdout

    return [
        LintMessage(
            path=filename,
            line=None,
            char=None,
            code=LINTER_CODE,
            severity=LintSeverity.WARNING,
            name="format",
            original=original,
            replacement=replacement,
            description=lint_message.decode("utf-8"),
        )
    ]


def main() -> None:
    parser = argparse.ArgumentParser(
        description=f"sqlfluff format linter for sql queries.",
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
