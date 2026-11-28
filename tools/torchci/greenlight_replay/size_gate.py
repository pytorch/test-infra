"""The policy's size gate, applied to a fetched diff exactly as the ``sizecheck`` step does.

The workflow declines a diff over any of its caps with a canned verdict and runs no
model. The counts here agree with the step's commands, not merely with its caps:

* ``wc -l`` counts newlines rather than lines, so a diff whose final line is
  unterminated counts one lower than it reads;
* ``wc -c`` counts bytes;
* ``grep -a -c '^diff --git '`` counts lines starting with that header. ``-a`` keeps a
  NUL byte from making the file binary, so only a newline ends a line, and a final
  line with no newline after it is still a line.

A policy whose step sets no file cap ran without one in CI, so it has none here.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING


if TYPE_CHECKING:
    from torchci.greenlight_replay.policy import Policy


__all__ = ["DIFF_HEADER", "SizeGate", "apply_size_gate", "count_files"]

logger = logging.getLogger(__name__)

DIFF_HEADER = b"diff --git "


@dataclass(frozen=True)
class SizeGate:
    """What the gate measured, and whether it declined."""

    lines: int
    bytes: int
    files: int
    too_large: bool


def count_files(diff: bytes) -> int:
    """The file count ``grep -a -c '^diff --git '`` reports for ``diff``."""
    return sum(1 for line in diff.split(b"\n") if line.startswith(DIFF_HEADER))


def apply_size_gate(diff: bytes, policy: Policy, label: str) -> SizeGate:
    """Measure ``diff`` against the policy's caps, logging the step's own line."""
    lines, size, files = diff.count(b"\n"), len(diff), count_files(diff)
    file_cap = policy.max_diff_files
    too_large = (
        lines > policy.max_diff_lines
        or size > policy.max_diff_bytes
        or (file_cap is not None and files > file_cap)
    )
    logger.info(
        "%s diff is %d lines / %d bytes / %d files (caps: %d lines, %d bytes, %s); %s",
        label,
        lines,
        size,
        files,
        policy.max_diff_lines,
        policy.max_diff_bytes,
        "no file cap" if file_cap is None else f"{file_cap} files",
        "declining automatically" if too_large else "proceeding with review",
    )
    return SizeGate(lines=lines, bytes=size, files=files, too_large=too_large)
