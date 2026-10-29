"""The workflow's "Collect stack context" step, as the harness reproduces it.

The step lists, in ``/tmp/greenlight-stack.json``, the open pull requests among the five
directly above the reviewed one in its stack, a ghstack or a GitHub stack of pull
requests, top first, with each one's diff at ``/tmp/greenlight-stack/<n>.diff``. This
module holds what that shell decides on its own for a ghstack: which lines of a body are
the listing, which five numbers sit above, how a diff is cut at 2000 lines, and the pins
on the step itself, with the stack context each collects. It imports nothing else from
the harness, so the policy loader can check a pin without pulling in :mod:`.stack`,
which reads GitHub back to the replayed verdict's cutoff.

**A pin covers the whole step but its ``name``.** :data:`STEP_SHA256` is the digest of
every other key as canonical JSON, so an edited ``run:``, ``env`` or ``shell``, or an
added ``if:``, is refused, while a retitled step is not. The step's version collecting
a ghstack's context alone is pinned too, by :data:`GHSTACK_ONLY_STEP_SHA256`, so a
policy ref carrying it replays with ghstack context, as CI ran it. Where the step sits
-- its order among the job's steps, and which job holds it -- is not checked. The step
is found by a ``run:`` naming the stack path inline; moved into a script, its policy
would read as one without the step and replay with no stack, a known limit.
"""

from __future__ import annotations

import enum
import hashlib
import json
import re
from collections.abc import Iterable, Mapping
from typing import Any


__all__ = [
    "CI_STACK_DIR",
    "CI_STACK_JSON",
    "GHSTACK_HEAD",
    "GHSTACK_ONLY_STEP_SHA256",
    "STACK_CONTEXT_BY_PIN",
    "STACK_DIRNAME",
    "STACK_FILENAME",
    "STEP_SHA256",
    "StackContext",
    "cap_diff",
    "listed_above",
    "listing",
    "stack_steps",
    "step_digest",
]

# The step writes both under /tmp and the prompt names them there, so a replay keeps the
# names and moves only the directory. The JSON's diff fields keep the /tmp spelling.
STACK_FILENAME = "greenlight-stack.json"
STACK_DIRNAME = "greenlight-stack"
CI_STACK_JSON = f"/tmp/{STACK_FILENAME}"
CI_STACK_DIR = f"/tmp/{STACK_DIRNAME}"


class StackContext(enum.Enum):
    """The stack context a policy collects, each value as the policy loader logs it.

    ``NONE`` is a policy without the step, ``GHSTACK`` one collecting a ghstack's
    context alone, and ``BOTH`` one collecting a ghstack's and a GitHub stack's.
    """

    NONE = "off"
    GHSTACK = "on, ghstack only"
    BOTH = "on"


# step_digest() of the step as PyYAML loads it.
STEP_SHA256 = "5fa7c0723e0ddabae1f5c0295ebbb60bf4260e89806a42d46a917f361b8f3b67"
# step_digest() of its ghstack-only version, the "Collect ghstack stack context" step at
# https://github.com/pytorch/test-infra/blob/9206d491d3a5507163cb9d5b77040d4c3ef5e038/.github/workflows/greenlight-pr-review.yml#L315
GHSTACK_ONLY_STEP_SHA256 = (
    "87ab279185061334eb6885620cbe9a7513a2a87fecbbd2e441869e1ad919be50"
)
STACK_CONTEXT_BY_PIN = {
    STEP_SHA256: StackContext.BOTH,
    GHSTACK_ONLY_STEP_SHA256: StackContext.GHSTACK,
}

# The step's `window`, for its `grep -xF -B "$window"` and its jq selection alike, and
# its `awk 'NR > 2000 { print "[truncated]"; exit } ...'`.
SIBLINGS_ABOVE = 5
DIFF_LINE_CAP = 2000
TRUNCATED_LINE = b"[truncated]\n"

GHSTACK_HEAD = re.compile(r"gh/([^/]+)/[0-9]+/head")
_LISTING_HEADER = "Stack from [ghstack]"
_LISTING_ROW = re.compile(r"\* (__->__ )?#[1-9][0-9]*")


def step_digest(step: Mapping[str, Any]) -> str:
    """The sha256 of ``step`` without its ``name``, as canonical JSON."""
    fields = {key: value for key, value in step.items() if key != "name"}
    canonical = json.dumps(fields, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def stack_steps(steps: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """Every step whose ``run:`` names a stack path, the JSON or the diff directory.

    Naming one is enough. Shell can touch a file in more ways than a redirect, and a
    step missed here goes unpinned: the stack step would replay silently without its
    context, and a second step trimming the stack files would be ignored. A step
    matched in error only makes the gate refuse loudly.
    """
    return [
        step
        for step in steps
        if isinstance(step.get("run"), str) and CI_STACK_DIR in step["run"]
    ]


def listing(body: str) -> list[str]:
    """The pull request numbers the step's ``tr -d '\\r' | awk`` reads out of ``body``.

    Records split on LF alone, so NEL, VT, FF, U+2028 and the like stay inside a line
    and spoil it. ``[0-9]`` is ASCII. A row is the whole line, with no trailing space
    and no leading zero. The block opens at a line starting with the header, a repeated
    header continues it, and the first line that is neither ends it for good. A number
    listed twice counts once, where it first appears.
    """
    numbers: list[str] = []
    in_block = False
    for line in body.replace("\r", "").split("\n"):
        if line.startswith(_LISTING_HEADER):
            in_block = True
        elif in_block and _LISTING_ROW.fullmatch(line):
            number = line.rpartition("#")[2]
            if number not in numbers:
                numbers.append(number)
        elif in_block:
            break
    return numbers


def listed_above(body: str, pr_number: int) -> list[str] | None:
    """The up to five numbers listed directly above ``pr_number``, top of stack first.

    None when the listing does not name ``pr_number``, where the step stops. The step's
    ``grep -xF -B "$window" | sed '$d'`` is exactly this slice, as no number repeats.
    """
    numbers = listing(body)
    own = str(pr_number)
    if own not in numbers:
        return None
    index = numbers.index(own)
    return numbers[max(0, index - SIBLINGS_ABOVE) : index]


def cap_diff(diff: bytes) -> bytes:
    """The step's ``awk 'NR > 2000 { print "[truncated]"; exit } { print }'``.

    Byte for byte: records split on LF and print with LF, so CR bytes survive and an
    unterminated last line gains one; a marker line replaces line 2001 onward.
    """
    lines = diff.split(b"\n")
    if lines[-1] == b"":
        # A final LF ends the last record rather than opening an empty one.
        lines.pop()
    capped = b"".join(line + b"\n" for line in lines[:DIFF_LINE_CAP])
    return capped + TRUNCATED_LINE if len(lines) > DIFF_LINE_CAP else capped
