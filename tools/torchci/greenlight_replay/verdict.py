"""The verdict artifact: where it lives, how to get it back, and whether it is valid.

Kept apart from ``transcript`` because the two answer different questions. ``transcript``
asks what happened to a RUN -- did it time out, trip its budget, silently do nothing. This
module asks what the reviewer SAID, which survives several of those failures: a budget trip
bills in full and omits ``result`` while the verdict is usually already written, so the run
is a failure and the answer is not.

The two validation failures in here are likewise unrelated to each other, and conflating
them is expensive. A verdict the schema rejects is one pull request's bad answer. A schema
keyword the harness cannot interpret is a property of the POLICY, identical for every pull
request in the sweep, so treating it as a per-run fault would re-run and re-bill an entire
corpus to reach the same refusal twice.
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
    "schema_support_violation",
    "verdict_fields",
    "verdict_path",
    "verdict_violation",
]

_WRITE_TOOL = "Write"

_SUPPORTED_SCHEMA_KEYS = frozenset(
    {"$schema", "$comment", "type", "required", "additionalProperties", "properties"}
)
_SUPPORTED_PROPERTY_KEYS = frozenset({"$comment", "enum", "type", "minLength"})


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
    already made the call that produces the verdict. Discarding the run without looking
    here throws away work that was paid for.
    """
    # Resolved on both sides. remap rewrites to os.path.realpath(run_dir), so on macOS a
    # Write logged at /private/tmp/... would never match an unresolved /tmp/... entry here,
    # and budget-trip recovery is the only way to get paid-for work back off a trip. The
    # turn record logs the ORIGINAL tool_input (measured, CLI 2.1.267), so the canonical
    # path is what actually appears today -- both are accepted so that stays true either way.
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


def schema_support_violation(schema: Mapping[str, Any]) -> str | None:
    """Why this module cannot interpret ``schema``, or None when it can.

    Separate from verdict validation because the two failures have nothing in common. A
    verdict the schema rejects is one pull request's bad answer, worth one retry. A schema
    keyword the harness does not implement is a property of the POLICY, identical for every
    pull request in the sweep -- a policy PR adding ``description`` or ``maxLength`` to
    ``verdict-schema.json`` would otherwise fail every review, retry each one, fail again,
    and bill the whole corpus twice for nothing.

    Callers check this once up front, before any money is spent.
    """
    unknown = set(schema) - _SUPPORTED_SCHEMA_KEYS
    if unknown:
        return f"verdict schema uses unsupported keywords {sorted(unknown)}"
    for name, spec in (schema.get("properties") or {}).items():
        unknown = set(spec) - _SUPPORTED_PROPERTY_KEYS
        if unknown:
            return (
                f"verdict schema property {name!r} uses unsupported keywords "
                f"{sorted(unknown)}"
            )
    return None


def verdict_violation(
    schema: Mapping[str, Any], verdict: Mapping[str, Any]
) -> str | None:
    """Why the VERDICT fails the policy tree's schema, or None when it passes.

    Reads the schema file rather than mirroring it, so a policy PR that widens the reason
    enum is honoured. Assumes ``schema_support_violation`` already passed: this function
    judges the reviewer's answer, never the schema.
    """
    properties = schema.get("properties") or {}
    for name in schema.get("required") or []:
        if name not in verdict:
            return f"verdict is missing required field {name!r}"
    if schema.get("additionalProperties") is False:
        extra = sorted(set(verdict) - set(properties))
        if extra:
            return f"verdict carries fields the schema forbids: {extra}"
    for name, spec in properties.items():
        if name not in verdict:
            continue
        value = verdict[name]
        if "enum" in spec and value not in spec["enum"]:
            return f"verdict {name}={value!r} is not one of {spec['enum']}"
        if spec.get("type") == "string" and not isinstance(value, str):
            return f"verdict {name} must be a string, got {type(value).__name__}"
        if "minLength" in spec and len(value or "") < spec["minLength"]:
            return f"verdict {name} is shorter than the required {spec['minLength']} characters"
    return None


def _same_path(candidate: Any, wanted: set[str]) -> bool:
    return isinstance(candidate, str) and os.path.realpath(candidate) in wanted
