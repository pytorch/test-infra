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

# The keywords this module implements, at EVERY schema level -- a subschema under ``allOf``
# or ``if``/``then``/``else`` is checked against the same set as the root. Anything outside
# it aborts the sweep rather than being skipped: a keyword we ignore is a policy constraint
# silently not enforced, which is the one failure worse than refusing to run.
_SUPPORTED_SCHEMA_KEYS = frozenset(
    {
        "$schema",
        "$comment",
        "type",
        "required",
        "additionalProperties",
        "properties",
        "allOf",
        "if",
        "then",
        "else",
    }
)
_SUPPORTED_PROPERTY_KEYS = frozenset({"$comment", "enum", "type", "minLength", "const"})

# Every keyword whose value is itself a schema, so support checking recurses into it.
_BRANCH_KEYS = ("if", "then", "else")


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
    if not isinstance(schema, Mapping):
        return f"verdict schema has a non-object subschema: {schema!r}"
    unknown = set(schema) - _SUPPORTED_SCHEMA_KEYS
    if unknown:
        return f"verdict schema uses unsupported keywords {sorted(unknown)}"
    for name, spec in (schema.get("properties") or {}).items():
        if not isinstance(spec, Mapping):
            return f"verdict schema property {name!r} is not an object: {spec!r}"
        unknown = set(spec) - _SUPPORTED_PROPERTY_KEYS
        if unknown:
            return (
                f"verdict schema property {name!r} uses unsupported keywords "
                f"{sorted(unknown)}"
            )
    for subschema in _subschemas(schema):
        violation = schema_support_violation(subschema)
        if violation is not None:
            return violation
    return None


def _subschemas(schema: Mapping[str, Any]) -> list[Any]:
    """Every nested schema, so neither support checking nor validation stops at the root."""
    nested: list[Any] = list(schema.get("allOf") or [])
    nested.extend(schema[key] for key in _BRANCH_KEYS if key in schema)
    return nested


def verdict_violation(
    schema: Mapping[str, Any], verdict: Mapping[str, Any]
) -> str | None:
    """Why the VERDICT fails the policy tree's schema, or None when it passes.

    Reads the schema file rather than mirroring it, so a policy PR that widens the reason
    enum is honoured. Assumes ``schema_support_violation`` already passed: this function
    judges the reviewer's answer, never the schema.

    Applied recursively, because the constraints that matter most are conditional. The
    policy expresses "a LAND may carry only the reason ``clean``" as an ``if``/``then``
    under ``allOf`` -- and a LAND stamped with a reason objecting to landing would authorise
    the very merge its reason objects to, since the land-time guard reads only the status.
    Parsing that constraint without evaluating it would be worse than refusing the schema.
    """
    properties = schema.get("properties") or {}
    if schema.get("type") == "object" and not isinstance(verdict, Mapping):
        return f"verdict must be an object, got {type(verdict).__name__}"
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
        if "const" in spec and value != spec["const"]:
            return f"verdict {name}={value!r} must be {spec['const']!r}"
        if "enum" in spec and value not in spec["enum"]:
            return f"verdict {name}={value!r} is not one of {spec['enum']}"
        if spec.get("type") == "string" and not isinstance(value, str):
            return f"verdict {name} must be a string, got {type(value).__name__}"
        if "minLength" in spec and len(value or "") < spec["minLength"]:
            return f"verdict {name} is shorter than the required {spec['minLength']} characters"
    for index, subschema in enumerate(schema.get("allOf") or []):
        violation = verdict_violation(subschema, verdict)
        if violation is not None:
            return f"verdict fails allOf[{index}]: {violation}"
    return _conditional_violation(schema, verdict)


def _conditional_violation(
    schema: Mapping[str, Any], verdict: Mapping[str, Any]
) -> str | None:
    """Apply ``then`` when ``if`` matches and ``else`` when it does not.

    The ``if`` subschema is a CONDITION, not an assertion: a verdict that fails it has not
    done anything wrong, it has merely selected the other branch. An absent branch passes.
    """
    condition = schema.get("if")
    if condition is None:
        return None
    branch = "then" if verdict_violation(condition, verdict) is None else "else"
    applied = schema.get(branch)
    if applied is None:
        return None
    violation = verdict_violation(applied, verdict)
    if violation is None:
        return None
    return f"verdict fails the schema's {branch} branch: {violation}"


def _same_path(candidate: Any, wanted: set[str]) -> bool:
    return isinstance(candidate, str) and os.path.realpath(candidate) in wanted
