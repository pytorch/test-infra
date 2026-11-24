"""The scan's shared state between invocations: repo leases, scan memory, the config cache, eligibility, the latch.

``StateStore`` has two backends with the same semantics: ``state_dynamo.DynamoStore`` (the scan Lambda's
DynamoDB table) and ``InProcessStore`` (a dict, for the CLI and the tests). Three kinds of item, keyed by
the string attribute ``pk``:

- ``repo#<repo>``: the repo's lease (``lease_owner``, ``lease_expires``), its scan memory (``memory``,
  the ``scan_memory`` codec's bytes), the last tick a run completed and when (``last_tick``,
  ``last_completed_at``), whether its drain is complete (``drain_complete``), and its config cache
  (``ConfigRecord``, the ``cfg_*`` attributes, ``served``, ``work_since``, ``reported``);
- ``eligibility#<repo>#<eligibility>#<minimum_role>``: an eligibility snapshot (``snapshot``, the
  ``merge_authz`` codec's bytes) and when it was fetched (``fetched_at``);
- ``ratelimit``: until when the installation's GitHub quota is latched (``until``).

A lease is a conditional write that succeeds only when no lease is there or the one there has expired; a
memory save with an owner succeeds only while that owner holds an unexpired lease, and a release clears
the lease only for its owner. Every expiry is checked against the caller's clock, never left to the
table's TTL, which deletes late: ``ttl_at`` is set on the latch item alone, since a TTL on a repo item
would delete its memory and config cache with the lease. The latch is clamped to
``RATE_LIMIT_LATCH_MAX`` from the caller's clock on write and on read. Times are epoch seconds. Tokens
and the App key are never stored. Every backend failure is a ``StoreError``.
"""

from __future__ import annotations

import dataclasses
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Literal, NamedTuple, Protocol, get_args

from greenlight.constants import RATE_LIMIT_LATCH_MAX

if TYPE_CHECKING:
    from collections.abc import Mapping

    from greenlight.repo_config import Eligibility, MinimumRole

ConfigKind = Literal["file", "absent", "invalid"]
_CONFIG_KINDS: tuple[ConfigKind, ...] = get_args(ConfigKind)
Value = str | float | int | bool | bytes

REPO_PREFIX = "repo#"
LATCH_KEY = "ratelimit"
LEASE_OWNER = "lease_owner"
LEASE_EXPIRES = "lease_expires"
MEMORY = "memory"
LAST_TICK = "last_tick"
LAST_COMPLETED_AT = "last_completed_at"
DRAIN_COMPLETE = "drain_complete"
SNAPSHOT = "snapshot"
FETCHED_AT = "fetched_at"
UNTIL = "until"
TTL_AT = "ttl_at"


class StoreError(Exception):
    """The store could not be reached or refused a request."""


class LeaseLost(StoreError):
    """A save under a lease found the lease gone, expired or held by another owner."""


@dataclass(frozen=True)
class ConfigRecord:
    """A repo's config cache: what the last read of its file found, and what the planner decided from it.

    ``kind`` is None before any read; ``text``, ``etag`` and ``size`` are the last file read (``kind``
    ``file``), ``reason`` why the last read was not a usable file (``invalid``), ``read_at`` when it was
    read. ``valid_text`` is the last text that parsed valid. ``served`` says the repo was served and its
    approvals not yet drained since; ``work_since`` when its current run of ticks with work began;
    ``reported`` the problem the planner last reported for it.
    """

    kind: ConfigKind | None = None
    text: str | None = None
    etag: str | None = None
    size: int | None = None
    read_at: float | None = None
    reason: str | None = None
    valid_text: str | None = None
    served: bool = False
    work_since: float | None = None
    reported: str | None = None


_CONFIG_ATTRIBUTES: dict[str, str] = {
    "kind": "cfg_kind",
    "text": "cfg_text",
    "etag": "cfg_etag",
    "size": "cfg_size",
    "read_at": "cfg_read_at",
    "reason": "cfg_reason",
    "valid_text": "cfg_valid_text",
    "served": "served",
    "work_since": "work_since",
    "reported": "reported",
}
CONFIG_ATTRIBUTE_NAMES: tuple[str, ...] = tuple(_CONFIG_ATTRIBUTES.values())


@dataclass(frozen=True)
class RepoItem:
    """One ``repo#<repo>`` item; a repo with no item reads as ``RepoItem(repo)``."""

    repo: str
    lease_owner: str | None = None
    lease_expires: float | None = None
    memory: bytes | None = None
    last_tick: str | None = None
    last_completed_at: float | None = None
    drain_complete: bool = False
    config: ConfigRecord = field(default_factory=ConfigRecord)

    def lease_free(self, now: float) -> bool:
        return self.lease_owner is None or self.lease_expires is None or self.lease_expires <= now


class EligibilityKey(NamedTuple):
    repo: str
    eligibility: Eligibility
    minimum_role: MinimumRole


def repo_key(repo: str) -> str:
    return f"{REPO_PREFIX}{repo}"


def eligibility_key(key: EligibilityKey) -> str:
    return f"eligibility#{key.repo}#{key.eligibility}#{key.minimum_role}"


def epoch_text(epoch: float) -> str:
    """``epoch`` (seconds) as an ISO-8601 UTC time, for the logs."""
    return datetime.fromtimestamp(epoch, UTC).isoformat(timespec="seconds")


def clamp_latch(until: float, now: float) -> float:
    return min(until, now + RATE_LIMIT_LATCH_MAX.total_seconds())


def config_attributes(record: ConfigRecord) -> dict[str, Value | None]:
    """``record`` as its item attributes; None values are the attributes to remove."""
    return {attribute: getattr(record, name) for name, attribute in _CONFIG_ATTRIBUTES.items()}


def _number(value: Value | None) -> float | None:
    return None if value is None or isinstance(value, bool | str | bytes) else float(value)


def _text(value: Value | None) -> str | None:
    return value if isinstance(value, str) else None


def repo_item(repo: str, attributes: Mapping[str, Value]) -> RepoItem:
    """The ``RepoItem`` of ``repo`` from its item's attributes."""
    kind = _text(attributes.get("cfg_kind"))
    size = _number(attributes.get("cfg_size"))
    memory = attributes.get(MEMORY)
    record = ConfigRecord(
        kind=kind if kind in _CONFIG_KINDS else None,
        text=_text(attributes.get("cfg_text")),
        etag=_text(attributes.get("cfg_etag")),
        size=None if size is None else int(size),
        read_at=_number(attributes.get("cfg_read_at")),
        reason=_text(attributes.get("cfg_reason")),
        valid_text=_text(attributes.get("cfg_valid_text")),
        served=attributes.get("served") is True,
        work_since=_number(attributes.get("work_since")),
        reported=_text(attributes.get("reported")),
    )
    return RepoItem(
        repo=repo,
        lease_owner=_text(attributes.get(LEASE_OWNER)),
        lease_expires=_number(attributes.get(LEASE_EXPIRES)),
        memory=memory if isinstance(memory, bytes) else None,
        last_tick=_text(attributes.get(LAST_TICK)),
        last_completed_at=_number(attributes.get(LAST_COMPLETED_AT)),
        drain_complete=attributes.get(DRAIN_COMPLETE) is True,
        config=record,
    )


def memory_attributes(memory: bytes, *, now: float, tick: str | None, drain_complete: bool) -> dict[str, Value]:
    """What a memory save writes: the memory, the drain's completion and, for a tick, the tick and when."""
    attributes: dict[str, Value] = {MEMORY: memory, DRAIN_COMPLETE: drain_complete}
    if tick is not None:
        attributes[LAST_TICK] = tick
        attributes[LAST_COMPLETED_AT] = now
    return attributes


class StateStore(Protocol):
    def read_repo(self, repo: str) -> RepoItem:
        """``repo``'s item, its memory included (a consistent read)."""

    def scan_repos(self) -> dict[str, RepoItem]:
        """Every repo item, keyed by repo, without its memory (a consistent read)."""

    def write_config(self, repo: str, record: ConfigRecord) -> None:
        """Replace ``repo``'s config cache with ``record``, touching no other attribute."""

    def acquire_lease(self, repo: str, owner: str, *, expires: float, now: float) -> bool:
        """Take ``repo``'s lease for ``owner`` until ``expires``; False when an unexpired lease is held."""

    def save_memory(
        self, repo: str, memory: bytes, *, owner: str | None, now: float, tick: str | None, drain_complete: bool
    ) -> None:
        """Save ``repo``'s memory (and ``tick`` as completed at ``now``); with an ``owner``, only while it holds
        an unexpired lease, else ``LeaseLost``."""

    def release_lease(self, repo: str, owner: str) -> bool:
        """Clear ``repo``'s lease if ``owner`` holds it; False when it does not."""

    def read_eligibility(self, key: EligibilityKey) -> tuple[bytes, float] | None:
        """The stored snapshot of ``key`` and when it was fetched, or None."""

    def write_eligibility(self, key: EligibilityKey, snapshot: bytes, fetched_at: float) -> None:
        """Store the snapshot of ``key`` fetched at ``fetched_at``."""

    def read_latch(self, now: float) -> float | None:
        """Until when the shared rate-limit latch holds, clamped; None when it is not set at ``now``."""

    def extend_latch(self, until: float, now: float) -> None:
        """Hold the shared latch until ``until`` (clamped), unless it already holds later."""


class InProcessStore:
    """``StateStore`` on a dict of items in this process: the CLI's and the tests'."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.items: dict[str, dict[str, Value]] = {}

    def _item(self, key: str) -> dict[str, Value]:
        return self.items.setdefault(key, {"pk": key})

    def read_repo(self, repo: str) -> RepoItem:
        with self._lock:
            return repo_item(repo, dict(self.items.get(repo_key(repo), {})))

    def scan_repos(self) -> dict[str, RepoItem]:
        with self._lock:
            return {
                key.removeprefix(REPO_PREFIX): dataclasses.replace(
                    repo_item(key.removeprefix(REPO_PREFIX), attributes), memory=None
                )
                for key, attributes in self.items.items()
                if key.startswith(REPO_PREFIX)
            }

    def write_config(self, repo: str, record: ConfigRecord) -> None:
        with self._lock:
            item = self._item(repo_key(repo))
            for attribute, value in config_attributes(record).items():
                if value is None:
                    item.pop(attribute, None)
                else:
                    item[attribute] = value

    def acquire_lease(self, repo: str, owner: str, *, expires: float, now: float) -> bool:
        with self._lock:
            item = self._item(repo_key(repo))
            if not repo_item(repo, item).lease_free(now):
                return False
            item[LEASE_OWNER] = owner
            item[LEASE_EXPIRES] = expires
            return True

    def save_memory(
        self, repo: str, memory: bytes, *, owner: str | None, now: float, tick: str | None, drain_complete: bool
    ) -> None:
        with self._lock:
            item = self._item(repo_key(repo))
            if owner is not None:
                current = repo_item(repo, item)
                if current.lease_owner != owner or current.lease_free(now):
                    raise LeaseLost(f"{repo}: the lease of {owner} is gone, expired or held by another owner")
            item.update(memory_attributes(memory, now=now, tick=tick, drain_complete=drain_complete))

    def release_lease(self, repo: str, owner: str) -> bool:
        with self._lock:
            item = self._item(repo_key(repo))
            if item.get(LEASE_OWNER) != owner:
                return False
            item.pop(LEASE_OWNER, None)
            item.pop(LEASE_EXPIRES, None)
            return True

    def read_eligibility(self, key: EligibilityKey) -> tuple[bytes, float] | None:
        with self._lock:
            item = self.items.get(eligibility_key(key), {})
        snapshot, fetched_at = item.get(SNAPSHOT), _number(item.get(FETCHED_AT))
        if not isinstance(snapshot, bytes) or fetched_at is None:
            return None
        return snapshot, fetched_at

    def write_eligibility(self, key: EligibilityKey, snapshot: bytes, fetched_at: float) -> None:
        with self._lock:
            self._item(eligibility_key(key)).update({SNAPSHOT: snapshot, FETCHED_AT: fetched_at})

    def read_latch(self, now: float) -> float | None:
        with self._lock:
            until = _number(self.items.get(LATCH_KEY, {}).get(UNTIL))
        if until is None or until <= now:
            return None
        return clamp_latch(until, now)

    def extend_latch(self, until: float, now: float) -> None:
        clamped = clamp_latch(until, now)
        with self._lock:
            item = self._item(LATCH_KEY)
            current = _number(item.get(UNTIL))
            if current is None or current < clamped:
                item.update({UNTIL: clamped, TTL_AT: int(clamped) + 1})
