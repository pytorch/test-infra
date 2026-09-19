"""Validation for the optional agent-assisted triage verdict.

A downstream repo may attach a small JSON verdict to its ``report-ci-result``
callback saying *why* its CI failed -- most importantly whether the failure was
caused by the upstream ``pytorch/pytorch`` change under test rather than by the
backend itself.  See the ``triage-verdict`` input of the
``cross-repo-ci-relay-callback`` action for the wire shape.

The verdict is **advisory** and **fully untrusted**: it is authored by whatever
tool the downstream repo runs, it never gates a merge, and it never overrides a
raw conclusion.  So everything here is written for a hostile input:

* Every field is enum-, type- and size-checked.
* A *structural* violation (wrong type, unknown enum value, unknown schema
  version) drops the WHOLE verdict -- CRCR then behaves exactly as it does
  today, with no verdict at all.  Partially rendering a malformed object would
  mean showing a PR author a `category` whose `summary` we refused to trust.
* An *overflow* (a long summary, too many evidence entries) is capped rather
  than rejected, since the excess carries no meaning of its own.

Unknown keys are ignored rather than rejected, so a newer analyzer emitting an
additive field still validates against ``SCHEMA_VERSION``.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime


logger = logging.getLogger(__name__)

# Bumped only when the wire shape changes incompatibly.  A verdict declaring
# any other version is dropped: an older relay cannot know which of a newer
# schema's fields changed meaning.
SCHEMA_VERSION = 1

CATEGORIES = frozenset({"upstream", "backend", "infra", "flake", "unknown"})
CONFIDENCES = frozenset({"high", "medium", "low"})

# Size caps.  MAX_RAW_BYTES bounds the serialized verdict as a whole so that a
# pathological input can neither blow up the check-run output (GitHub caps
# `output.summary` at 65535 chars) nor the DynamoDB item behind it.
MAX_RAW_BYTES = 16 * 1024
MAX_SUMMARY_LEN = 1000
MAX_REASON_LEN = 300
MAX_EVIDENCE_ENTRIES = 10
MAX_EXCERPT_LEN = 1000
MAX_SHORT_FIELD_LEN = 200
MAX_URL_LEN = 500

# Length bounds match an abbreviated-to-full git SHA.
_COMMIT_RE = re.compile(r"^[0-9a-fA-F]{7,40}$")


class _Invalid(Exception):
    """Structural violation -- the whole verdict is dropped."""


def _require(cond: bool, msg: str) -> None:
    if not cond:
        raise _Invalid(msg)


def _string(value: object, field: str, max_len: int) -> str:
    """A non-empty string, truncated to ``max_len``.

    Numbers/bools are NOT coerced: a `summary` of `true` is a bug in the
    analyzer, and silently rendering "True" to a PR author hides it.
    """
    _require(isinstance(value, str), f"{field} must be a string")
    text = value.strip()  # type: ignore[union-attr]
    _require(text != "", f"{field} must not be empty")
    return text[:max_len]


def _optional_string(value: object, field: str, max_len: int) -> str | None:
    if value is None:
        return None
    return _string(value, field, max_len)


def _parse_suspected_upstream(value: object) -> dict:
    _require(isinstance(value, dict), "suspected_upstream must be an object")
    raw = dict(value)  # type: ignore[arg-type]

    result: dict = {}

    pr = raw.get("pr")
    if pr is not None:
        # bool is an int subclass in Python; a `pr` of `true` is not a PR.
        _require(
            isinstance(pr, int) and not isinstance(pr, bool) and pr > 0,
            "suspected_upstream.pr must be a positive integer",
        )
        result["pr"] = pr

    commit = raw.get("commit")
    if commit is not None:
        commit = _string(commit, "suspected_upstream.commit", MAX_SHORT_FIELD_LEN)
        _require(
            _COMMIT_RE.match(commit) is not None,
            "suspected_upstream.commit must be a hex git SHA",
        )
        result["commit"] = commit

    reason = _optional_string(
        raw.get("reason"), "suspected_upstream.reason", MAX_REASON_LEN
    )
    if reason is not None:
        result["reason"] = reason

    # A suspicion that names neither a PR nor a commit cannot be checked
    # against the triggering PR, which is the entire point of the field.
    _require(
        "pr" in result or "commit" in result,
        "suspected_upstream must name a pr or a commit",
    )
    return result


def _parse_evidence(value: object) -> list[dict]:
    _require(isinstance(value, list), "evidence must be an array")

    entries: list[dict] = []
    for index, item in enumerate(value[:MAX_EVIDENCE_ENTRIES]):  # type: ignore[index]
        _require(isinstance(item, dict), f"evidence[{index}] must be an object")
        entry: dict = {}
        for field, max_len in (
            ("job", MAX_SHORT_FIELD_LEN),
            ("test", MAX_SHORT_FIELD_LEN),
            ("excerpt", MAX_EXCERPT_LEN),
        ):
            text = _optional_string(
                item.get(field), f"evidence[{index}].{field}", max_len
            )  # type: ignore[union-attr]
            if text is not None:
                entry[field] = text

        log_url = _optional_string(
            item.get("log_url"),  # type: ignore[union-attr]
            f"evidence[{index}].log_url",
            MAX_URL_LEN,
        )
        if log_url is not None:
            # Anything else (javascript:, data:, a relative path) would be
            # rendered as a link into a pytorch/pytorch PR comment.
            _require(
                log_url.startswith("https://") or log_url.startswith("http://"),
                f"evidence[{index}].log_url must be http(s)",
            )
            entry["log_url"] = log_url

        if entry:
            entries.append(entry)

    return entries


def _parse_analyzer(value: object) -> dict:
    _require(isinstance(value, dict), "analyzer must be an object")
    analyzer: dict = {}
    for field in ("name", "version", "model", "prompt_version"):
        text = _optional_string(
            value.get(field),  # type: ignore[union-attr]
            f"analyzer.{field}",
            MAX_SHORT_FIELD_LEN,
        )
        if text is not None:
            analyzer[field] = text
    return analyzer


def _parse_analyzed_at(value: object) -> str:
    text = _string(value, "analyzed_at", MAX_SHORT_FIELD_LEN)
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise _Invalid("analyzed_at must be an ISO 8601 timestamp") from exc
    return text


def validate_triage_verdict(raw: object) -> dict | None:
    """Return a normalized verdict, or ``None`` when it must be dropped.

    ``raw`` is the ``workflow.triage_verdict`` value straight off the wire.
    ``None``/absent input returns ``None`` without logging: not attaching a
    verdict is the normal case, not an error.
    """
    if raw is None:
        return None

    try:
        _require(isinstance(raw, dict), "triage_verdict must be an object")
        raw_dict: dict = raw  # type: ignore[assignment]

        encoded_size = len(json.dumps(raw_dict, default=str).encode("utf-8"))
        _require(
            encoded_size <= MAX_RAW_BYTES,
            f"triage_verdict is {encoded_size} bytes, over the {MAX_RAW_BYTES} cap",
        )

        version = raw_dict.get("schema_version")
        # Accept the string form too.
        if isinstance(version, str) and version.strip().isdigit():
            version = int(version.strip())
        _require(
            version == SCHEMA_VERSION,
            f"unsupported triage_verdict schema_version {raw_dict.get('schema_version')!r}",
        )

        category = _string(raw_dict.get("category"), "category", MAX_SHORT_FIELD_LEN)
        _require(category in CATEGORIES, f"unknown category {category!r}")

        confidence = _string(
            raw_dict.get("confidence"), "confidence", MAX_SHORT_FIELD_LEN
        )
        _require(confidence in CONFIDENCES, f"unknown confidence {confidence!r}")

        verdict: dict = {
            "schema_version": SCHEMA_VERSION,
            "category": category,
            "confidence": confidence,
            "summary": _string(raw_dict.get("summary"), "summary", MAX_SUMMARY_LEN),
        }

        suspected_upstream = raw_dict.get("suspected_upstream")
        if suspected_upstream is not None:
            # Per the schema, a suspected upstream cause is only meaningful for
            # `category: upstream`.  Attaching one to a `backend` verdict means
            # the analyzer and CRCR disagree about what the object says, so the
            # verdict is not trustworthy enough to render any part of.
            _require(
                category == "upstream",
                "suspected_upstream is only valid for category 'upstream'",
            )
            verdict["suspected_upstream"] = _parse_suspected_upstream(
                suspected_upstream
            )

        evidence = raw_dict.get("evidence")
        if evidence is not None:
            parsed_evidence = _parse_evidence(evidence)
            if parsed_evidence:
                verdict["evidence"] = parsed_evidence

        reproduced_on_retry = raw_dict.get("reproduced_on_retry")
        if reproduced_on_retry is not None:
            _require(
                isinstance(reproduced_on_retry, bool),
                "reproduced_on_retry must be a boolean",
            )
            verdict["reproduced_on_retry"] = reproduced_on_retry

        analyzer = raw_dict.get("analyzer")
        if analyzer is not None:
            parsed_analyzer = _parse_analyzer(analyzer)
            if parsed_analyzer:
                verdict["analyzer"] = parsed_analyzer

        analyzed_at = raw_dict.get("analyzed_at")
        if analyzed_at is not None:
            verdict["analyzed_at"] = _parse_analyzed_at(analyzed_at)

        return verdict
    except _Invalid as exc:
        logger.warning(f"dropping triage_verdict: {exc}")
        return None
