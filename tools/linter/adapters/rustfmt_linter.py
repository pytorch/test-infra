from __future__ import annotations

import argparse
import concurrent.futures
import json
import logging
import os
import re
import subprocess
import sys
import time
from enum import Enum
from typing import Any, BinaryIO, List, NamedTuple, Optional, Pattern


IS_WINDOWS: bool = os.name == "nt"


def eprint(*args: Any, **kwargs: Any) -> None:
    print(*args, file=sys.stderr, flush=True, **kwargs)


class LintSeverity(str, Enum):
    ERROR = "error"
    WARNING = "warning"
    ADVICE = "advice"
    DISABLED = "disabled"


class LintMessage(NamedTuple):
    path: str
    line: Optional[int]
    char: Optional[int]
    code: str
    severity: LintSeverity
    name: str
    original: Optional[str]
    replacement: Optional[str]
    description: Optional[str]


def as_posix(name: str) -> str:
    return name.replace("\\", "/") if IS_WINDOWS else name


SYNTAX_ERROR_ARROW_RE: Pattern[str] = re.compile(
    r"(?m)^( +--> )(.+)(:(?P<line>\d+):(?P<column>\d+))\n"
)

SYNTAX_ERROR_PARSE_RE: Pattern[str] = re.compile(r"(?m)^failed to parse .*\n")


def strip_path_from_error(error: str) -> str:
    # Remove full paths from the description to have deterministic messages.
    error = SYNTAX_ERROR_ARROW_RE.sub("", error, count=1)
    error = SYNTAX_ERROR_PARSE_RE.sub("", error, count=1)
    return error


def run_command(
    args: list[str],
    *,
    stdin: BinaryIO | None = None,
    check: bool = False,
) -> subprocess.CompletedProcess[bytes]:
    logging.debug("$ %s", " ".join(args))
    start_time = time.monotonic()
    try:
        return subprocess.run(
            args,
            capture_output=True,
            shell=False,
            stdin=stdin,
            check=check,
        )
    finally:
        end_time = time.monotonic()
        logging.debug("took %dms", (end_time - start_time) * 1000)


def check_file(
    filename: str,
    binary: str,
    config_path: str,
) -> List[LintMessage]:
    try:
        with open(filename, "rb") as f:
            original = f.read()
        with open(filename, "rb") as f:
            proc = run_command(
                [
                    binary,
                    "--config-path",
                    config_path,
                    "--emit=stdout",
                    "--quiet",
                ],
                stdin=f,
                check=True,
            )
    except (OSError, subprocess.CalledProcessError) as err:
        # https://github.com/rust-lang/rustfmt#running
        # TODO: Fix the syntax error regexp to handle multiple issues and
        # to handle the empty result case.
        if (
            isinstance(err, subprocess.CalledProcessError)
            and err.returncode == 1
            and err.stderr
        ):
            line = None
            char = None
            description = err.stderr.decode("utf-8")
            match = SYNTAX_ERROR_ARROW_RE.search(description)
            if match:
                line = int(match["line"])
                char = int(match["column"])
                description = strip_path_from_error(description)
            return [
                LintMessage(
                    path=filename,
                    line=line,
                    char=char,
                    code="RUSTFMT",
                    severity=LintSeverity.ERROR,
                    name="parsing-error",
                    original=None,
                    replacement=None,
                    description=description,
                )
            ]

        return [
            LintMessage(
                path=filename,
                line=None,
                char=None,
                code="RUSTFMT",
                severity=LintSeverity.ERROR,
                name="command-failed",
                original=None,
                replacement=None,
                description=(
                    f"Failed due to {err.__class__.__name__}:\n{err}"
                    if not isinstance(err, subprocess.CalledProcessError)
                    else (
                        "COMMAND (exit code {returncode})\n"
                        "{command}\n\n"
                        "STDERR\n{stderr}\n\n"
                        "STDOUT\n{stdout}"
                    ).format(
                        returncode=err.returncode,
                        command=" ".join(as_posix(x) for x in err.cmd),
                        stderr=err.stderr.decode("utf-8").strip() or "(empty)",
                        stdout=err.stdout.decode("utf-8").strip() or "(empty)",
                    )
                ),
            )
        ]

    replacement = proc.stdout
    if original == replacement:
        return []

    if proc.stderr.startswith(b"error: "):
        clean_err = strip_path_from_error(proc.stderr.decode("utf-8")).strip()
        return [
            LintMessage(
                path=filename,
                line=None,
                char=None,
                code="RUSTFMT",
                severity=LintSeverity.WARNING,
                name="rustfmt-bug",
                original=None,
                replacement=None,
                description=(
                    "Possible rustfmt bug. "
                    "rustfmt returned error output but didn't fail:\n{}"
                ).format(clean_err),
            )
        ]

    return [
        LintMessage(
            path=filename,
            line=1,
            char=1,
            code="RUSTFMT",
            severity=LintSeverity.WARNING,
            name="format",
            original=original.decode("utf-8"),
            replacement=replacement.decode("utf-8"),
            description="See https://github.com/rust-lang/rustfmt#tips",
        )
    ]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Format rust files with rustfmt.",
        fromfile_prefix_chars="@",
    )
    parser.add_argument(
        "--binary",
        required=True,
        help="rustfmt binary path",
    )
    parser.add_argument(
        "--config-path",
        required=True,
        help="rustfmt config path",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="verbose logging",
    )
    parser.add_argument(
        "filenames",
        nargs="+",
        help="paths to lint",
    )
    args = parser.parse_args()

    logging.basicConfig(
        format="<%(threadName)s:%(levelname)s> %(message)s",
        level=logging.NOTSET
        if args.verbose
        else logging.DEBUG
        if len(args.filenames) < 1000
        else logging.INFO,
        stream=sys.stderr,
    )

    with concurrent.futures.ThreadPoolExecutor(
        max_workers=os.cpu_count(),
        thread_name_prefix="Thread",
    ) as executor:
        futures = {
            executor.submit(check_file, x, args.binary, args.config_path): x
            for x in args.filenames
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
