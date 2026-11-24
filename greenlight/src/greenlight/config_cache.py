"""The scan Lambda's cache of each repo's config file, and the one place its settings are decided from it.

``revalidate`` reads ``REPO_CONFIG_PATH`` through the contents API with ``If-None-Match`` on the stored
etag, so an unchanged file costs a 304 and no body; a file found absent (a 404) is asked again only
``CONFIG_ABSENT_TTL`` later. A directory, or a file over ``CONFIG_MAX_BYTES``, is invalid. Any other failed
read leaves the record as it was and says why (unreadable); a rate limit is re-raised.

``decide`` turns a repo's stored ``ConfigRecord`` into its settings. The planner calls it after each read,
and a worker calls it on the record the planner stored for its tick, so both reach the same settings. It
applies ``repo_config``'s rules to the last file read, then these on top:

- an invalid file is safety-only under the repo's last valid settings, when it had some (else, as
  ``repo_config`` says, the primary is safety-only under the built-in entry and any other repo refused);
- an unreadable file serves the last file read, with the failure as a problem;
- a repo other than the primary whose file is absent after it was served runs as ``off`` (its drain)
  until its drain completes, a problem until then; then it is no longer served;
- the primary's file absent after a valid one is safety-only under its last valid settings, never the
  built-in entry's active mode;
- a repo the installation no longer reaches gets no work; while it was served and not drained that is a
  problem on every tick (``Decision.persistent``), since its approvals cannot be drained.

``ConfigRecord.served`` is set once a decision serves the repo and cleared when its drain completes after
its file was removed; ``valid_text`` follows every valid file read.
"""

from __future__ import annotations

import base64
import binascii
import dataclasses
import json
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from greenlight import github_client
from greenlight.constants import CONFIG_ABSENT_TTL, CONFIG_MAX_BYTES, REPO_CONFIG_PATH
from greenlight.guards import IterationTimeout
from greenlight.repo_config import Settings, is_primary, outcome, parse_settings

if TYPE_CHECKING:
    from github import Github

    from greenlight.state_store import ConfigKind, ConfigRecord

logger = logging.getLogger(__name__)

UNREACHABLE = "the GitHub App installation no longer reaches it, so its approvals cannot be drained"
REMOVED = "its config was removed while it was served; it runs as off until its drain completes"
PRIMARY_ABSENT = "its config is absent after a valid one; safety-only under its last valid settings"


@dataclass(frozen=True)
class Decision:
    """A repo's settings, its updated record, and whether its problem fails every tick."""

    settings: Settings
    record: ConfigRecord
    persistent: bool = False


def _file(data: Any) -> tuple[ConfigKind, str | None, int | None, str | None]:
    """The record ``kind``, ``text``, ``size`` and ``reason`` of a contents API answer; ``ValueError`` on
    an answer that is no contents response."""
    if isinstance(data, list):
        return "invalid", None, None, "it is a directory, not a file"
    if not isinstance(data, dict) or not isinstance(data.get("size"), int):
        raise ValueError("the contents API answered an unexpected shape")
    size: int = data["size"]
    if data.get("type") != "file":
        return "invalid", None, size, f"it is a {data.get('type')}, not a file"
    if size > CONFIG_MAX_BYTES:
        return "invalid", None, size, f"the file is {size} bytes, over the {CONFIG_MAX_BYTES}-byte limit"
    try:
        text = base64.b64decode(str(data.get("content", "")), validate=False).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        logger.error("the contents API answered a file that is not base64-encoded UTF-8", exc_info=True)
        return "invalid", None, size, "the file is not UTF-8 text"
    return "file", text, size, None


def revalidate(record: ConfigRecord, client: Github, repo: str, *, now: float) -> tuple[ConfigRecord, str | None]:
    """``record`` updated by a read of ``repo``'s file, and why the read failed (None when it did not)."""
    absent_for = None if record.read_at is None else now - record.read_at
    if record.kind == "absent" and absent_for is not None and 0 <= absent_for < CONFIG_ABSENT_TTL.total_seconds():
        return record, None
    headers = {"If-None-Match": record.etag} if record.etag else None
    url = f"/repos/{repo}/contents/{REPO_CONFIG_PATH}"
    try:
        status, response_headers, body = client.requester.requestJson("GET", url, headers=headers)
        if github_client.is_rate_limit_status(status, response_headers):
            from github import GithubException

            raise GithubException(status, None, response_headers)
        if status == 304:
            return record, None
        if status == 404:
            cleared = dataclasses.replace(record, kind="absent", text=None, etag=None, size=None, reason=None)
            return dataclasses.replace(cleared, read_at=now), None
        if status != 200:
            raise ValueError(f"GET {url} answered HTTP {status}")
        kind, text, size, reason = _file(json.loads(body))
    except IterationTimeout:
        raise
    except Exception as exc:
        if github_client.is_rate_limit_error(exc):
            raise
        logger.error("cannot read %s of %s", REPO_CONFIG_PATH, repo, exc_info=True)
        return record, f"{type(exc).__name__}: {exc}"
    etag = response_headers.get("etag")
    updated = dataclasses.replace(record, kind=kind, text=text, size=size, reason=reason, read_at=now)
    return dataclasses.replace(updated, etag=etag if isinstance(etag, str) else None), None


def _last_read(repo: str, record: ConfigRecord, unreadable: str | None) -> Settings:
    if record.kind == "file":
        return parse_settings(repo, record.text or "")
    if record.kind == "absent":
        return outcome(repo, "absent")
    if record.kind == "invalid":
        return outcome(repo, "invalid", record.reason or "")
    return outcome(repo, "unreadable", unreadable or "it was never read")


def _with_problem(settings: Settings, problem: str) -> Settings:
    joined = problem if settings.problem is None else f"{settings.problem}; {problem}"
    return dataclasses.replace(settings, problem=joined)


def _on_top(repo: str, base: Settings, record: ConfigRecord, *, drain_complete: bool) -> tuple[Settings, bool]:
    """The store-aware rules on top of the last read's ``base``: the settings, and whether the repo stays served."""
    last = None if record.valid_text is None else parse_settings(repo, record.valid_text)
    last_entry = None if last is None else last.entry
    if base.kind == "invalid" and last_entry is not None:
        safety_only = Settings(repo, "invalid", last_entry, served=False, problem=base.problem)
        return _with_problem(safety_only, "safety-only under its last valid settings instead"), record.served
    if base.kind != "absent" or last_entry is None:
        return base, record.served
    if is_primary(repo):
        return Settings(repo, "absent", last_entry, served=False, problem=PRIMARY_ABSENT), record.served
    if not record.served:
        return base, False
    if drain_complete:
        logger.info("%s: its config was removed and its drain is complete; it is no longer served", repo)
        return base, False
    off = dataclasses.replace(last_entry, mode="off")
    return Settings(repo, "absent", off, served=False, problem=REMOVED), True


def decide(
    repo: str, record: ConfigRecord, *, unreadable: str | None, reachable: bool, drain_complete: bool
) -> Decision:
    """``repo``'s settings from ``record`` (``unreadable``: why this tick's read failed, or None)."""
    if not reachable:
        if record.served and not drain_complete:
            settings = Settings(repo, "unreadable", None, served=False, problem=UNREACHABLE)
            return Decision(settings, record, persistent=True)
        return Decision(Settings(repo, "absent", None, served=False), dataclasses.replace(record, served=False))
    base = _last_read(repo, record, unreadable)
    settings, served = _on_top(repo, base, record, drain_complete=drain_complete)
    if unreadable is not None and record.kind is not None:
        settings = _with_problem(settings, f"config unreadable, serving the last file read: {unreadable}")
    valid_text = record.text if base.kind == "valid" and record.kind == "file" else record.valid_text
    updated = dataclasses.replace(record, valid_text=valid_text, served=served or settings.served)
    return Decision(settings, updated)
