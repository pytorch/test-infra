"""A repo's GreenLight config: ``.github/greenlight/config.yml`` on its own default branch.

``parse_settings`` judges a file's text and ``read_settings`` reads it through the contents API (never
from a PR head); both end in a ``Settings``, the one place the outcome of every case is decided:

- **absent** (a 404): the primary (``TARGET_REPO``) is served under ``BUILTIN_PYTORCH``; any other
  repo is not configured;
- **valid**: served; a non-primary file with an unknown key is safety-only, so a newer config never
  takes safety work away from an older pinned release, and an older release never serves a file it
  does not fully understand;
- **invalid** (not YAML, an anchor, alias or duplicate key, not a mapping, over ``CONFIG_MAX_BYTES``,
  a directory, not UTF-8 text, a field missing or out of its values, a cross-field rule broken): the
  primary is safety-only under ``BUILTIN_PYTORCH``, any other repo is refused;
- **unreadable** (any other read failure but a rate limit, which is re-raised): the primary is served
  under ``BUILTIN_PYTORCH`` and any other repo gets no work. The scan's config cache
  (``config_cache``) serves the last file read instead.

``read_settings`` judges the contents API's answer through ``config_contents``, as ``config_cache`` does.
The primary reads only ``mode`` from its file: its ``status_comment``, ``safety``, ``eligibility`` and
``minimum_role`` are pinned to ``BUILTIN_PYTORCH``'s (a different value or an unknown key is logged and
ignored, so a one-line config edit cannot widen whom GreenLight approves there). Every problem is logged
with its reason and carried in ``Settings.problem``. See REPOS.md.
"""

from __future__ import annotations

import dataclasses
import logging
import reprlib
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, cast, get_args

import yaml

from greenlight import github_client
from greenlight.config_contents import config_url, contents_answer, too_big
from greenlight.constants import (
    CONFIG_MAX_BYTES,
    DRCI_STATUS_COMMENT_REPOS,
    PYTORCHBOT_GUARDED_REPOS,
    REPO_CONFIG_PATH,
    TARGET_REPO,
    normalize_repo,
)
from greenlight.guards import IterationTimeout

if TYPE_CHECKING:
    from collections.abc import Mapping
    from pathlib import Path

    from github import Github


logger = logging.getLogger(__name__)

StatusComment = Literal["drci", "greenlight"]
Safety = Literal["pytorchbot", "gate"]
Eligibility = Literal["merge_rules", "write_permission"]
Mode = Literal["shadow", "active", "off"]
MinimumRole = Literal["write", "maintain"]
SettingsKind = Literal["absent", "valid", "invalid", "unreadable"]

STATUS_COMMENTS: tuple[StatusComment, ...] = get_args(StatusComment)
SAFETIES: tuple[Safety, ...] = get_args(Safety)
ELIGIBILITIES: tuple[Eligibility, ...] = get_args(Eligibility)
MODES: tuple[Mode, ...] = get_args(Mode)
MINIMUM_ROLES: tuple[MinimumRole, ...] = get_args(MinimumRole)
_DEFAULT_MINIMUM_ROLE: MinimumRole = "write"

_ENUMS: dict[str, tuple[str, ...]] = {
    "status_comment": STATUS_COMMENTS,
    "safety": SAFETIES,
    "eligibility": ELIGIBILITIES,
    "mode": MODES,
    "minimum_role": MINIMUM_ROLES,
}
_OPTIONAL_FIELDS = frozenset({"minimum_role"})
_PINNED_FIELDS = ("status_comment", "safety", "eligibility", "minimum_role")


class _Invalid(ValueError):
    """The file cannot be used as a config; the message is the reason."""


_REPR = reprlib.Repr(maxstring=60, maxother=60)


def _cut(text: str) -> str:
    return text if len(text) <= _REPR.maxstring else text[: _REPR.maxstring - 3] + "..."


def _shown(value: object) -> str:
    """``value`` for a problem message: a string's repr cut to a bounded length, anything else by type."""
    return _REPR.repr(value) if isinstance(value, str) else f"a {type(value).__name__}"


class _Loader(yaml.SafeLoader):
    """``yaml.SafeLoader`` that reads no scalar as a boolean and refuses anchors, aliases and duplicate keys.

    PyYAML follows YAML 1.1, which reads a bare ``off`` (and ``on``, ``yes``, ``no``) as a boolean, so
    ``mode: off`` would otherwise arrive as False. Every value this file holds is a string. Aliases
    let a few hundred bytes expand into a structure of many megabytes, and with a duplicate key the
    last copy would silently win. A bare ``<<`` is a plain key; any tag written in the file is refused,
    since an explicit ``!!merge`` would merge keys past the duplicate check.
    """

    def compose_node(self, parent: yaml.Node | None, index: int) -> yaml.Node | None:
        event = self.peek_event()  # type: ignore[no-untyped-call]
        if isinstance(event, yaml.AliasEvent) or getattr(event, "anchor", None) is not None:
            raise _Invalid("anchors and aliases are not allowed")
        if getattr(event, "tag", None) is not None:
            raise _Invalid(f"explicit YAML tags are not allowed (found {_shown(event.tag)})")
        return super().compose_node(parent, index)

    def construct_mapping(self, node: yaml.MappingNode, deep: bool = False) -> dict[object, object]:
        seen: set[tuple[str, str]] = set()
        for key_node, _value_node in node.value:
            if isinstance(key_node, yaml.ScalarNode):
                if (key_node.tag, key_node.value) in seen:
                    raise _Invalid(f"duplicate key {_shown(key_node.value)}")
                seen.add((key_node.tag, key_node.value))
        return super().construct_mapping(node, deep=deep)


_Loader.yaml_implicit_resolvers = {
    first: [
        (tag, regexp) for tag, regexp in resolvers if tag not in {"tag:yaml.org,2002:bool", "tag:yaml.org,2002:merge"}
    ]
    for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}


@dataclass(frozen=True)
class RepoEntry:
    repo: str
    status_comment: StatusComment
    safety: Safety
    eligibility: Eligibility
    mode: Mode
    minimum_role: MinimumRole = _DEFAULT_MINIMUM_ROLE


BUILTIN_PYTORCH = RepoEntry(TARGET_REPO, "drci", "pytorchbot", "merge_rules", "active")


def is_primary(repo: str) -> bool:
    """True for the primary repo, by exact name: the one every pytorch special case asks about."""
    return repo == TARGET_REPO


@dataclass(frozen=True)
class Settings:
    """How GreenLight serves ``repo``: ``entry`` (None: no work at all), ``served`` (False with an entry:
    its safety work only), and ``problem`` (why it is not simply served or absent, or None)."""

    repo: str
    kind: SettingsKind
    entry: RepoEntry | None
    served: bool
    problem: str | None = None


def outcome(repo: str, kind: SettingsKind, reason: str = "") -> Settings:
    """The settings of a file that is absent, invalid for ``reason`` or unreadable for ``reason``.

    An unreadable file serves the primary's built-in entry, and no work anywhere else.
    """
    primary = is_primary(repo)
    builtin = BUILTIN_PYTORCH if primary else None
    if kind == "absent":
        return Settings(repo, kind, builtin, served=primary)
    if kind == "invalid":
        action = "safety-only under the built-in entry" if primary else "refused"
        settings = Settings(repo, kind, builtin, served=False, problem=f"invalid config, {action}: {reason}")
    else:
        action = "serving the built-in entry" if primary else "no work"
        settings = Settings(repo, kind, builtin, served=primary, problem=f"config unreadable, {action}: {reason}")
    logger.error("%s %s: %s", repo, REPO_CONFIG_PATH, settings.problem)
    return settings


def _field_problem(field: str, raw: Mapping[object, object]) -> str | None:
    """Why ``raw``'s ``field`` is not one of its values, or None; an optional field may be absent."""
    if field not in raw:
        return None if field in _OPTIONAL_FIELDS else f"{field} is missing"
    value, allowed = raw[field], _ENUMS[field]
    if not isinstance(value, str):
        return f"{field} must be a string, got {type(value).__name__}"
    if value not in allowed:
        return f"{field} {_shown(value)} is not one of {list(allowed)}"
    return None


def _entry_problems(raw: Mapping[object, object]) -> list[str]:
    return [problem for field in _ENUMS if (problem := _field_problem(field, raw)) is not None]


def _cross_field_problems(repo: str, raw: Mapping[object, object]) -> list[str]:
    problems: list[str] = []
    if raw["safety"] == "pytorchbot" and repo not in PYTORCHBOT_GUARDED_REPOS:
        problems.append(f"safety: pytorchbot is only for {sorted(PYTORCHBOT_GUARDED_REPOS)}")
    if raw["status_comment"] == "drci" and normalize_repo(repo) not in DRCI_STATUS_COMMENT_REPOS:
        problems.append(f"status_comment: drci is only for {sorted(DRCI_STATUS_COMMENT_REPOS)}")
    if raw["safety"] == "gate" and raw["mode"] == "active":
        problems.append("safety: gate cannot be active in this release")
    if "minimum_role" in raw and raw["eligibility"] != "write_permission":
        problems.append("minimum_role is only for eligibility: write_permission")
    return problems


def _entry(repo: str, raw: Mapping[object, object]) -> RepoEntry:
    """``raw`` as an entry; its fields were already checked against their values."""
    return RepoEntry(
        repo,
        status_comment=cast("StatusComment", raw["status_comment"]),
        safety=cast("Safety", raw["safety"]),
        eligibility=cast("Eligibility", raw["eligibility"]),
        mode=cast("Mode", raw["mode"]),
        minimum_role=cast("MinimumRole", raw.get("minimum_role", _DEFAULT_MINIMUM_ROLE)),
    )


def _unknown_keys(raw: Mapping[object, object]) -> list[str]:
    return sorted(_cut(str(key)) for key in raw if key not in _ENUMS)


def _load(text: str | bytes) -> Mapping[object, object]:
    """The file's top-level mapping; ``_Invalid`` when it cannot be one."""
    size = len(text.encode() if isinstance(text, str) else text)
    if size > CONFIG_MAX_BYTES:
        raise _Invalid(too_big(size))
    try:
        document = yaml.load(text, Loader=_Loader)  # noqa: S506 -- _Loader is a yaml.SafeLoader
    except _Invalid:
        raise
    except Exception as exc:
        logger.error("cannot parse a %s", REPO_CONFIG_PATH, exc_info=True)
        raise _Invalid(f"not valid YAML: {type(exc).__name__}: {exc}") from exc
    if not isinstance(document, dict):
        raise _Invalid(f"the top level must be a mapping, got {type(document).__name__}")
    return document


def _primary_findings(raw: Mapping[object, object]) -> tuple[list[str], list[str]]:
    """The primary's reasons to be safety-only, and what of its file is ignored."""
    ignored: list[str] = []
    for field in _PINNED_FIELDS:
        pinned = getattr(BUILTIN_PYTORCH, field)
        if field not in raw:
            if field not in _OPTIONAL_FIELDS:
                ignored.append(f"{field} is missing; it is pinned to {pinned!r}")
        elif raw[field] != pinned:
            ignored.append(f"{field} {_shown(raw[field])} ignored; it is pinned to {pinned!r}")
    if unknown := _unknown_keys(raw):
        ignored.append(f"unknown key(s) {unknown} ignored")
    mode_problem = _field_problem("mode", raw)
    return ([] if mode_problem is None else [mode_problem]), ignored


def _other_findings(repo: str, raw: Mapping[object, object]) -> tuple[list[str], list[str]]:
    """A non-primary repo's reasons to be refused, and its unknown keys."""
    return _entry_problems(raw) or _cross_field_problems(repo, raw), _unknown_keys(raw)


def parse_settings(repo: str, text: str | bytes) -> Settings:
    """``repo``'s settings from its file's text. Never raises for bad content."""
    try:
        raw = _load(text)
    except _Invalid as exc:
        return outcome(repo, "invalid", str(exc))
    if is_primary(repo):
        invalid, ignored = _primary_findings(raw)
        for finding in ignored:
            logger.error("%s %s: %s", repo, REPO_CONFIG_PATH, finding)
        if invalid:
            return outcome(repo, "invalid", "; ".join(invalid))
        mode = cast("Mode", raw["mode"])
        return Settings(repo, "valid", dataclasses.replace(BUILTIN_PYTORCH, mode=mode), served=True)
    invalid, unknown = _other_findings(repo, raw)
    if invalid:
        return outcome(repo, "invalid", "; ".join(invalid))
    if unknown:
        problem = f"safety-only: unknown key(s) {unknown}"
        logger.error("%s %s: %s", repo, REPO_CONFIG_PATH, problem)
        return Settings(repo, "valid", _entry(repo, raw), served=False, problem=problem)
    return Settings(repo, "valid", _entry(repo, raw), served=True)


def _is_not_found(exc: Exception) -> bool:
    from github import GithubException

    return isinstance(exc, GithubException) and exc.status == 404


def read_settings(client: Github, repo: str) -> Settings:
    """``repo``'s settings from its default branch. Re-raises a rate limit and ``IterationTimeout``."""
    try:
        _headers, data = client.requester.requestJsonAndCheck("GET", config_url(repo))
        answer = contents_answer(data)
    except IterationTimeout:
        raise
    except Exception as exc:
        if github_client.is_rate_limit_error(exc):
            raise
        if _is_not_found(exc):
            return outcome(repo, "absent")
        logger.error("cannot read %s of %s", REPO_CONFIG_PATH, repo, exc_info=True)
        return outcome(repo, "unreadable", f"{type(exc).__name__}: {exc}")
    if answer.text is None:
        return outcome(repo, "invalid", answer.reason or "")
    return parse_settings(repo, answer.text)


def fetch_settings(token: str, repo: str) -> Settings:
    """``read_settings`` with a client of its own on ``token``: the patient one the verdict's eligibility
    check uses (``build_authz_client``), which rides out a short rate limit."""
    client = github_client.build_authz_client(token)
    try:
        return read_settings(client, repo)
    finally:
        github_client.close_client(client)


def record_entry(token: str, repo: str) -> tuple[RepoEntry, bool]:
    """``repo``'s entry and whether it is served, for a LAND or NO_LAND. Raises with no usable entry."""
    settings = fetch_settings(token, repo)
    if settings.entry is None or settings.kind == "unreadable":
        why = settings.problem or f"no {REPO_CONFIG_PATH}"
        raise ValueError(f"{repo} has no valid GreenLight settings ({why}); no row is recorded")
    return settings.entry, settings.served


def marker_entry(token: str | None, repo: str) -> tuple[RepoEntry, bool]:
    """``repo``'s entry and whether it is served, for a marker. Never raises.

    A failed or unreadable read falls back to the primary's built-in entry, served, and to a shadow entry
    anywhere else, as does a repo with no usable settings.
    """
    settings: Settings | None = None
    try:
        if not token:
            raise ValueError("no GitHub token to read it with")
        settings = fetch_settings(token, repo)
    except Exception:
        logger.warning("cannot read %s of %s for a marker; falling back", REPO_CONFIG_PATH, repo, exc_info=True)
    if (settings is None or settings.kind == "unreadable") and is_primary(repo):
        return BUILTIN_PYTORCH, True
    if settings is None or settings.entry is None or settings.kind == "unreadable":
        return RepoEntry(repo, "greenlight", "gate", "merge_rules", "shadow"), False
    return settings.entry, settings.served


def check_file(path: Path, repo: str) -> list[str]:
    """Every problem of the config file at ``path`` for ``repo``; for the primary also what of it is ignored."""
    try:
        raw = _load(path.read_bytes())
    except OSError as exc:
        return [f"cannot read {path}: {exc}"]
    except _Invalid as exc:
        return [str(exc)]
    if is_primary(repo):
        invalid, ignored = _primary_findings(raw)
        return invalid + ignored
    invalid, unknown = _other_findings(repo, raw)
    return invalid + ([f"unknown key(s) {unknown}"] if unknown else [])
