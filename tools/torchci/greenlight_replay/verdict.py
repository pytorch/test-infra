"""The verdict artifact: where it lives, and what a run left of it.

Kept apart from ``transcript`` because the two answer different questions. ``transcript``
asks what happened to a RUN -- did it time out, trip its budget, silently do nothing. This
module reads what the reviewer SAID, which survives several of those failures: a budget
trip bills in full and omits ``result`` while the verdict is usually already written.

What is read here is a diagnostic. Whether a verdict counts is decided by the record
path's own checks (:mod:`.arm_code`), on the file a successful session left; a verdict
recovered from the turn record never counts.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from torchci.greenlight_replay.hooks import remap


logger = logging.getLogger(__name__)

__all__ = [
    "read_verdict",
    "recover_verdict",
    "verdict_fields",
    "verdict_path",
]

_WRITE_TOOL = "Write"


def verdict_path(run_dir: Path) -> Path:
    return Path(run_dir) / remap.VERDICT_BASENAME


def verdict_fields(verdict: Mapping[str, Any] | None) -> dict[str, Any]:
    return {
        "status": (verdict or {}).get("status"),
        "reason": (verdict or {}).get("reason"),
        "message": (verdict or {}).get("message"),
    }


def read_verdict(run_dir: Path) -> dict[str, Any] | None:
    path = verdict_path(run_dir)
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        # The ordinary "the reviewer wrote nothing" case, not worth a log line per run.
        return None
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        # Present but unreadable is a different story, and it ends at the same NO_VERDICT
        # outcome -- so without this line the reason never reaches anyone debugging it.
        logger.warning("verdict at %s could not be read: %s", path, exc)
        return None
    return loaded if isinstance(loaded, dict) else None


def recover_verdict(
    envelope: Sequence[Mapping[str, Any]], run_dir: Path
) -> dict[str, Any] | None:
    """Pull the verdict out of the turn record when the result element carries none.

    A budget trip bills the full grant and omits ``result``, but the reviewer has usually
    already made the call that produces the verdict; what it said is kept with the failed
    run, for whoever reads why it failed.
    """
    # Resolved on both sides. remap rewrites to os.path.realpath(run_dir), so on macOS a
    # Write logged at /private/tmp/... would never match an unresolved /tmp/... entry here.
    # The turn record logs the ORIGINAL tool_input (measured, CLI 2.1.267), so the
    # canonical path is what actually appears today -- both are accepted so that stays
    # true either way.
    wanted = {
        os.path.realpath(verdict_path(run_dir)),
        os.path.realpath(f"/tmp{os.sep}{remap.VERDICT_BASENAME}"),  # noqa: S108
    }
    for element in reversed(list(envelope)):
        if element.get("type") != "assistant":
            continue
        content = (element.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for block in reversed(content):
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            payload = block.get("input")
            if not isinstance(payload, dict):
                continue
            if block.get("name") != _WRITE_TOOL:
                continue
            if _same_path(payload.get("file_path"), wanted):
                try:
                    written = json.loads(payload.get("content") or "")
                except (json.JSONDecodeError, ValueError) as exc:
                    logger.warning(
                        "verdict recovery: a Write to %s did not hold JSON (%s)",
                        payload.get("file_path"),
                        exc,
                    )
                    continue
                if isinstance(written, dict):
                    return written
    return None


def _same_path(candidate: Any, wanted: set[str]) -> bool:
    return isinstance(candidate, str) and os.path.realpath(candidate) in wanted
