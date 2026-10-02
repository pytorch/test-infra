"""Resolve pytorch/pytorch's merge rules: the merge-authorized login set and the rules themselves.

The scan filters fingerprint comments down to authors who can authorize a merge, drawn
from ``.github/merge_rules.yaml``: every rule's ``approved_by`` entry, with team refs
(``org/team-slug``) expanded to member logins. Team expansion needs org ``Members: read``
(``read:org``). The resolved set is a filter, so a login entering or leaving it only
changes a PR's fingerprint when that login has authored a comment on the PR.

The same fetch keeps every rule as a ``MergeRule``: its approvers in exact case and its file
patterns compiled with trymerge's own semantics, so a rule can be asked whether it covers all of
a PR's files (``changed_files``) the way trymerge asks at land time.

``AuthorizedLoginsCache`` owns the only cross-scan state: it fetches lazily, serves a
cached snapshot for ``ttl_seconds``, and on a refresh failure serves the last good snapshot
rather than failing a scan over a transient merge_rules/GitHub hiccup. A cold failure (never
fetched successfully) has no snapshot to fall back to and propagates.
"""

from __future__ import annotations

import itertools
import logging
import re
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol

import yaml

from greenlight import constants, github_client
from greenlight.guards import IterationTimeout

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Mapping

    from greenlight.github_types import _FilesPR

logger = logging.getLogger(__name__)

# trymerge's RE_GHSTACK_HEAD_REF. trymerge exempts a ghstack head from its main-base refusal and lands
# the stack by cherry-picking its orig branch, so the PR's own file listing does not bound what lands.
_GHSTACK_HEAD_REF = re.compile(r"^(gh/[^/]+/[0-9]+/)head$")

# Exact port of pytorch's gitutils.patterns_to_regex and trymerge._find_non_matching_files; keep
# every quirk in sync with them.
_INVALID_PATTERN_CHARS = "{}()[]\\"
_GLOB_TOKEN = re.compile(r"\*\*|[*.+]")
_GLOB_TOKEN_REGEX = {"**": ".*", "*": "[^/]*", ".": r"\.", "+": r"\+"}


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


def _glob_to_regex(pattern: str) -> str:
    return _GLOB_TOKEN.sub(lambda token: _GLOB_TOKEN_REGEX[token.group()], pattern)


def _patterns_to_regex(patterns: Sequence[str]) -> re.Pattern[str]:
    for pattern in patterns:
        if any(c in pattern for c in _INVALID_PATTERN_CHARS):
            raise ValueError(f"pattern contains invalid characters (braces/parens/brackets/backslash): {pattern!r}")
    regex = "(" + "|".join(map(_glob_to_regex, patterns)) + ")"
    try:
        return re.compile(regex)
    except re.PatternError as exc:
        raise ValueError(f"patterns {list(patterns)!r} compile to an invalid regex {regex!r}: {exc}") from exc


@dataclass(frozen=True)
class _Matcher:
    include: re.Pattern[str]
    exclude: re.Pattern[str] | None

    def matches(self, path: str) -> bool:
        return self.include.match(path) is not None and (self.exclude is None or self.exclude.match(path) is None)


def _compile(patterns: Sequence[str]) -> _Matcher:
    positive = [p for p in patterns if not p.startswith("-")]
    negative = [p[1:] for p in patterns if p.startswith("-")]
    return _Matcher(_patterns_to_regex(positive), _patterns_to_regex(negative) if negative else None)


@dataclass(frozen=True)
class MergeRule:
    """One merge_rules.yaml rule: whom it names and which files it covers. Build it with ``compile_rule``.

    ``approvers`` keep their exact case -- raw YAML entries, team members as GitHub returns them --
    because trymerge compares approvers case-sensitively. A rule whose patterns are malformed or do
    not compile is invalid: it covers nothing, so it qualifies nobody.
    """

    name: str
    patterns: tuple[str, ...]
    approvers: frozenset[str]
    covers_all: bool
    _matcher: _Matcher | None = field(default=None, repr=False)

    def covers(self, files: Iterable[str]) -> bool:
        matcher = self._matcher
        return matcher is not None and all(matcher.matches(f) for f in files)


def compile_rule(name: str, patterns: Sequence[str], approvers: frozenset[str]) -> MergeRule:
    """Compile ``patterns`` once. An invalid pattern is logged and yields an invalid rule; it never raises."""
    try:
        matcher = _compile(patterns)
    except ValueError:
        logger.error("merge rule %r has an invalid pattern; it qualifies nobody", name, exc_info=True)
        return MergeRule(name, tuple(patterns), approvers, covers_all=False)
    covers_all = any(p in ("*", "**") for p in patterns) and not any(p.startswith("-") for p in patterns)
    return MergeRule(name, tuple(patterns), approvers, covers_all, _matcher=matcher)


@dataclass(frozen=True)
class MergeRulesSnapshot:
    """One resolution of merge_rules.yaml: the lowercased approver union and every rule, in file order."""

    authorized: frozenset[str]
    rules: tuple[MergeRule, ...]


def _rule_from_yaml(rule: Mapping[str, object], approvers: frozenset[str]) -> MergeRule:
    name = str(rule.get("name"))
    patterns = rule.get("patterns")
    if isinstance(patterns, list) and all(isinstance(p, str) for p in patterns):
        return compile_rule(name, patterns, approvers)
    logger.error("merge rule %r: patterns must be a list of strings, got %r; it qualifies nobody", name, patterns)
    return MergeRule(name, (), approvers, covers_all=False)


def _expand_team(client: AuthzClient, team_ref: str) -> set[str]:
    org_name, _, slug = team_ref.partition("/")
    if not org_name or not slug or "/" in slug:
        raise ValueError(f"approved_by team ref must be 'org/team-slug', got {team_ref!r}")
    team = client.get_organization(org_name).get_team_by_slug(slug)
    members: set[str] = set()
    for member in team.get_members():
        login = member.login
        if login:
            members.add(login)
    return members


def resolve_merge_rules(client: AuthzClient) -> MergeRulesSnapshot:
    """Resolve every merge rule in pytorch/pytorch and the lowercased union of their approvers.

    Raises ``ValueError`` on malformed YAML, an unexpected rule/entry shape, or an empty
    union -- an empty allowlist would silently blank every comment from the fingerprint. Unusable
    patterns are not fatal: that rule is logged and qualifies nobody, and its approvers still join
    the union.
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
    merge_rules: list[MergeRule] = []
    for rule in rules:
        if not isinstance(rule, dict):
            raise ValueError(f"merge rule must be a mapping, got {type(rule).__name__}")
        approved_by = rule.get("approved_by", [])
        if not isinstance(approved_by, list):
            raise ValueError(f"approved_by must be a list, got {type(approved_by).__name__}")
        approvers: set[str] = set()
        for entry in approved_by:
            if not isinstance(entry, str) or not entry.strip():
                raise ValueError(f"approved_by entry must be a non-empty string, got {entry!r}")
            if "/" in entry:
                members = _expand_team(client, entry)
                approvers.update(members)
                logins.update(member.lower() for member in members)
            else:
                approvers.add(entry)
                logins.add(entry.strip().lower())
        merge_rules.append(_rule_from_yaml(rule, frozenset(approvers)))

    if not logins:
        raise ValueError(f"resolved an empty merge-authorized set from {constants.MERGE_RULES_PATH}")
    return MergeRulesSnapshot(authorized=frozenset(logins), rules=tuple(merge_rules))


def resolve_authorized_logins(client: AuthzClient) -> frozenset[str]:
    """Return the lowercased set of logins authorized to approve a merge in pytorch/pytorch."""
    return resolve_merge_rules(client).authorized


def changed_files(pr: _FilesPR) -> tuple[str, ...] | None:
    """Return the PR's changed paths, or None when its listing is too long or cannot bound what trymerge lands.

    None for a ghstack head or a base other than ``TARGET_BRANCH``, and for more than ``MAX_DIFF_FILES``
    files, a cap kept below the 3000 at which GitHub's file listing stops silently. Only ``filename`` (the
    new path) is read, so, as in trymerge, a rename's source path is never checked.
    """
    head_ref = pr.head.ref
    if _GHSTACK_HEAD_REF.match(head_ref):
        logger.warning("PR head %r is a ghstack head; its file listing cannot bound what lands", head_ref)
        return None
    base_ref = pr.base.ref
    if base_ref != constants.TARGET_BRANCH:
        logger.warning(
            "PR base %r is not %r; its file listing cannot bound what lands", base_ref, constants.TARGET_BRANCH
        )
        return None
    files = tuple(file.filename for file in itertools.islice(pr.get_files(), constants.MAX_DIFF_FILES + 1))
    if len(files) > constants.MAX_DIFF_FILES:
        logger.warning("PR changes more than %d files; its file listing is not checked", constants.MAX_DIFF_FILES)
        return None
    return files


class AuthorizedLoginsCache:
    """Lazy, TTL-bounded, stale-on-error cache of the merge-rules snapshot.

    ``monotonic`` is the injected float clock (defaults to ``time.monotonic``);
    ``build_client`` is a thunk so each refresh builds its own client, closed as soon as
    the fetch returns. Not thread-safe by design: it is read once per scan from the main
    thread, and the immutable result is what fans out to the fingerprint workers.
    """

    def __init__(
        self,
        build_client: Callable[[], AuthzClient],
        *,
        ttl_seconds: float,
        monotonic: Callable[[], float] = time.monotonic,
        fetch: Callable[[AuthzClient], MergeRulesSnapshot] = resolve_merge_rules,
    ) -> None:
        self._build_client = build_client
        self._ttl_seconds = ttl_seconds
        self._monotonic = monotonic
        self._fetch = fetch
        self._cached: MergeRulesSnapshot | None = None
        # Only ever read once _cached is set (the two are written together on a successful fetch),
        # so the initial value is never used for a freshness decision.
        self._fetched_at: float = 0.0

    def _is_fresh(self) -> bool:
        return self._monotonic() - self._fetched_at < self._ttl_seconds

    def snapshot(self) -> MergeRulesSnapshot:
        if self._cached is not None and self._is_fresh():
            return self._cached
        return self._refresh()

    def _refresh(self) -> MergeRulesSnapshot:
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
                    "failed to refresh merge rules; serving stale snapshot of %d login(s) and %d rule(s)",
                    len(self._cached.authorized),
                    len(self._cached.rules),
                    exc_info=True,
                )
                return self._cached
            raise
        finally:
            github_client.close_client(client)
        self._cached = result
        self._fetched_at = self._monotonic()
        return result
