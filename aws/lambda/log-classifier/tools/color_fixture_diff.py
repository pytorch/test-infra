#!/usr/bin/env python3
"""Recolor a `git show`/`git diff` stream for reviewing classify fixtures.

Added lines in a new fixture are all-green under normal `git` coloring, which
buries the one line that matters -- the `#=MATCH=#` line the classifier landed
on. This filter DIMS ordinary added log lines and highlights only the match line
(and its `<< >>` capture delimiters), so the verdict pops while the surrounding
confusers stay readable but quiet.

Usage (pipe an UNcolored diff in):
    git show --color=never <rev> | tools/color_fixture_diff.py | less -R
    git diff --color=never      | tools/color_fixture_diff.py | less -R

Or wire it as a git alias (see tools/README or `git config`):
    git showfix <rev>
"""

from __future__ import annotations

import sys


RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
YELLOW = "\033[33m"
CYAN = "\033[36m"
RED = "\033[31m"
GREEN = "\033[32m"
MATCH_GREEN = "\033[1;97;42m"  # bold white on green -- unmissable
CAP = "\033[1;93m"  # bright yellow for the ‹ › capture spans
SRC = "\033[4;36m"  # underlined cyan for the source link

MARKER = "#=MATCH=#"
SOURCE = "#=SOURCE=#"
CAP_OPEN, CAP_CLOSE = "‹", "›"


def emphasize_captures(text: str) -> str:
    """Repaint ‹...› capture spans, restoring the match highlight after each."""
    return text.replace(CAP_OPEN, CAP + CAP_OPEN).replace(
        CAP_CLOSE, CAP_CLOSE + RESET + MATCH_GREEN
    )


def colorize(line: str, in_fixture: bool) -> str:
    # Commit/metadata + file headers: keep them legible, git-ish.
    if line.startswith("commit "):
        return YELLOW + line + RESET
    if line.startswith(
        (
            "diff --git",
            "index ",
            "new file",
            "deleted file",
            "rename ",
            "similarity ",
            "--- ",
            "+++ ",
        )
    ):
        return BOLD + line + RESET
    if line.startswith("@@"):
        return CYAN + line + RESET
    # Diff body.
    if line.startswith("+"):
        if MARKER in line:
            return MATCH_GREEN + emphasize_captures(line) + RESET
        if SOURCE in line:
            return SRC + line + RESET  # the review link -- keep it visible
        # Ordinary added line: dim it ONLY inside a fixture's log (where all-green
        # buries the match); elsewhere (ruleset.toml, log.rs) keep normal green.
        return (DIM if in_fixture else GREEN) + line + RESET
    if line.startswith("-"):
        return RED + line + RESET
    return line  # context lines / commit message


def main() -> None:
    in_fixture = False
    for raw in sys.stdin:
        line = raw.rstrip("\n")
        # Track which file the hunk belongs to; the new-side path is authoritative.
        if line.startswith("diff --git"):
            in_fixture = "fixtures/classify/" in line
        elif line.startswith("+++ "):
            in_fixture = "fixtures/classify/" in line
        sys.stdout.write(colorize(line, in_fixture) + "\n")


if __name__ == "__main__":
    main()
