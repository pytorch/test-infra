"""Resolve pytorch/pytorch's merge-authorization login set (the fingerprint comment allowlist).

The scan filters fingerprint comments down to authors who can authorize a merge, drawn
from ``.github/merge_rules.yaml``: every rule's ``approved_by`` entry, with team refs
(``org/team-slug``) expanded to member logins. Team expansion needs org ``Members: read``
(``read:org``). The resolved set is a filter, so a login entering or leaving it only
changes a PR's fingerprint when that login has authored a comment on the PR.

``AuthorizedLoginsCache`` owns the only cross-scan state: it fetches lazily, serves a
cached set for ``ttl_seconds``, and on a refresh failure serves the last good set rather
than failing a scan over a transient merge_rules/GitHub hiccup. A cold failure (never
fetched successfully) has no set to fall back to and propagates.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Sequence
from typing import TYPE_CHECKING, Protocol

import yaml

from greenlight import constants
from greenlight.guards import IterationTimeout

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

logger = logging.getLogger(__name__)


class _Content(Protocol):
    @property
    def decoded_content(self) -> bytes: ...


class _Member(Protocol):
    @property
    def login(self) -> str | None: ...


class _Team(Protocol):
    def get_members(self) -> Iterable[_Member]: ...


class _Organization(Protocol):
    def get_team_by_slug(self, slug: str) -> _Team: ...


class _MergeRulesRepo(Protocol):
    # Sequence (not list) keeps this covariant so the real ``Repository.get_contents`` --
    # ``ContentFile | list[ContentFile]`` -- satisfies it; a file yields one ``_Content``.
    def get_contents(self, path: str) -> _Content | Sequence[_Content]: ...


class AuthzClient(Protocol):
    """Structural GitHub client for merge-rules resolution; the real ``github.Github`` satisfies it."""

    def get_repo(self, full_name_or_id: str) -> _MergeRulesRepo: ...
    def get_organization(self, login: str) -> _Organization: ...


def _expand_team(client: AuthzClient, team_ref: str) -> set[str]:
    org_name, _, slug = team_ref.partition("/")
    if not org_name or not slug or "/" in slug:
        raise ValueError(f"approved_by team ref must be 'org/team-slug', got {team_ref!r}")
    team = client.get_organization(org_name).get_team_by_slug(slug)
    members: set[str] = set()
    for member in team.get_members():
        login = member.login
        if login:
            members.add(login.lower())
    return members


def resolve_authorized_logins(client: AuthzClient) -> frozenset[str]:
    """Return the lowercased set of logins authorized to approve a merge in pytorch/pytorch.

    Raises ``ValueError`` on malformed YAML, an unexpected rule/entry shape, or an empty
    result -- an empty allowlist would silently blank every comment from the fingerprint.
    """
    contents = client.get_repo(constants.TARGET_REPO).get_contents(constants.MERGE_RULES_PATH)
    if isinstance(contents, Sequence):
        raise ValueError(f"{constants.MERGE_RULES_PATH} resolved to a directory, not a single file")
    try:
        rules = yaml.safe_load(contents.decoded_content)
    except yaml.YAMLError as exc:
        raise ValueError(f"failed to parse {constants.MERGE_RULES_PATH}: {exc}") from exc
    if not isinstance(rules, list):
        raise ValueError(f"{constants.MERGE_RULES_PATH} must be a list of rules, got {type(rules).__name__}")

    logins: set[str] = set()
    for rule in rules:
        if not isinstance(rule, dict):
            raise ValueError(f"merge rule must be a mapping, got {type(rule).__name__}")
        approved_by = rule.get("approved_by", [])
        if not isinstance(approved_by, list):
            raise ValueError(f"approved_by must be a list, got {type(approved_by).__name__}")
        for entry in approved_by:
            if not isinstance(entry, str) or not entry.strip():
                raise ValueError(f"approved_by entry must be a non-empty string, got {entry!r}")
            if "/" in entry:
                logins.update(_expand_team(client, entry))
            else:
                logins.add(entry.strip().lower())

    if not logins:
        raise ValueError(f"resolved an empty merge-authorized set from {constants.MERGE_RULES_PATH}")
    return frozenset(logins)


def _close_client(client: AuthzClient) -> None:
    close = getattr(client, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            logger.warning("failed to close merge-authorization client", exc_info=True)


class AuthorizedLoginsCache:
    """Lazy, TTL-bounded, stale-on-error cache of the merge-authorized login set.

    ``monotonic`` is the injected float clock (defaults to ``time.monotonic``);
    ``build_client`` is a thunk so each refresh builds its own client, closed as soon as
    the fetch returns. Not thread-safe by design: ``.get()`` is called once per scan from
    the main thread, and the immutable result is what fans out to the fingerprint workers.
    """

    def __init__(
        self,
        build_client: Callable[[], AuthzClient],
        *,
        ttl_seconds: float,
        monotonic: Callable[[], float] = time.monotonic,
        fetch: Callable[[AuthzClient], frozenset[str]] = resolve_authorized_logins,
    ) -> None:
        self._build_client = build_client
        self._ttl_seconds = ttl_seconds
        self._monotonic = monotonic
        self._fetch = fetch
        self._cached: frozenset[str] | None = None
        # Only ever read once _cached is set (the two are written together on a successful fetch),
        # so the initial value is never used for a freshness decision.
        self._fetched_at: float = 0.0

    def _is_fresh(self) -> bool:
        return self._monotonic() - self._fetched_at < self._ttl_seconds

    def get(self) -> frozenset[str]:
        if self._cached is not None and self._is_fresh():
            return self._cached
        return self._refresh()

    def _refresh(self) -> frozenset[str]:
        client = self._build_client()
        try:
            result = self._fetch(client)
        except IterationTimeout:
            # greenlight's soft per-iteration timeout is a control signal, not a refresh
            # failure: it must abort the scan, never be masked and served stale.
            raise
        except Exception:
            if self._cached is not None:
                logger.warning(
                    "failed to refresh merge-authorized logins; serving stale set of %d login(s)",
                    len(self._cached),
                    exc_info=True,
                )
                return self._cached
            raise
        finally:
            _close_client(client)
        self._cached = result
        self._fetched_at = self._monotonic()
        return result
