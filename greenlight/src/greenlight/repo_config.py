"""The per-repo config GreenLight serves, read from ``greenlight/repos.yaml`` and validated entry by entry.

Each entry ends **served** (all of its work), **safety-only** (its safety work by its known fields,
no optional work) or **refused** (no work at all), and every problem is logged with its reason and
listed in ``RepoConfig.problems`` for the scan to report. A non-primary entry with an unknown key is
safety-only, so a newer config never takes safety work away from an older pinned release, and an
older release never serves an entry it does not fully understand; any other problem refuses it.

The primary entry (``TARGET_REPO``) is never refused: its ``status_comment``, ``safety`` and
``eligibility`` are pinned to ``BUILTIN_PYTORCH``'s (a different value is logged and ignored, so a
one-line config edit cannot widen whom GreenLight approves there), unknown keys on it are logged and
ignored, and its ``mode`` comes from the file. When its entry is missing or duplicated, or its
``mode`` is missing or invalid, the primary is safety-only under ``BUILTIN_PYTORCH``. See REPOS.md.

Two keys are optional on every entry. ``change_source`` (``github``, the default, or ``clickhouse``)
says where the scan learns which PRs changed. ``full_tick_minutes`` is a ``clickhouse`` entry's full
tick interval, an integer from ``FULL_TICK_MINUTES_MIN`` to ``FULL_TICK_MINUTES_MAX``, default
``FULL_TICK_MINUTES_DEFAULT``; a ``github`` entry keeps the fixed ``FULL_TICK_INTERVAL``, so the key
on one is a problem. On a non-primary entry a bad value refuses it like any other field problem; on
the primary both keys come from the file, and a missing one, or a bad one (logged), is
``BUILTIN_PYTORCH``'s.
"""

from __future__ import annotations

import dataclasses
import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Protocol, cast, get_args

import yaml

from greenlight.constants import (
    DISPATCH_REPO,
    FULL_TICK_MINUTES_DEFAULT,
    FULL_TICK_MINUTES_MAX,
    FULL_TICK_MINUTES_MIN,
    PYTORCHBOT_GUARDED_REPOS,
    REPOS_CONFIG_PATH,
    TARGET_REPO,
)

if TYPE_CHECKING:

    class _Content(Protocol):
        @property
        def decoded_content(self) -> bytes: ...

    class _ContentsRepo(Protocol):
        def get_contents(self, path: str) -> _Content | Sequence[_Content]: ...


logger = logging.getLogger(__name__)

StatusComment = Literal["drci", "greenlight"]
Safety = Literal["pytorchbot", "gate"]
Eligibility = Literal["merge_rules", "write_permission"]
Mode = Literal["shadow", "active", "off"]
ChangeSource = Literal["github", "clickhouse"]

STATUS_COMMENTS: tuple[StatusComment, ...] = get_args(StatusComment)
SAFETIES: tuple[Safety, ...] = get_args(Safety)
ELIGIBILITIES: tuple[Eligibility, ...] = get_args(Eligibility)
MODES: tuple[Mode, ...] = get_args(Mode)
CHANGE_SOURCES: tuple[ChangeSource, ...] = get_args(ChangeSource)

_ENUMS: dict[str, tuple[str, ...]] = {
    "status_comment": STATUS_COMMENTS,
    "safety": SAFETIES,
    "eligibility": ELIGIBILITIES,
    "mode": MODES,
}
_PINNED_FIELDS = ("status_comment", "safety", "eligibility")
_KNOWN_KEYS = frozenset({"repo", *_ENUMS, "change_source", "full_tick_minutes"})
_REPO_NAME = re.compile(r"pytorch/[A-Za-z0-9._-]+")


class _Loader(yaml.SafeLoader):
    """``yaml.SafeLoader`` that reads no scalar as a boolean.

    PyYAML follows YAML 1.1, which reads a bare ``off`` (and ``on``, ``yes``, ``no``) as a boolean, so
    ``mode: off`` would otherwise arrive as False. Every value this file holds is a string.
    """


_Loader.yaml_implicit_resolvers = {
    first: [(tag, regexp) for tag, regexp in resolvers if tag != "tag:yaml.org,2002:bool"]
    for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}


class ConfigUnreadable(ValueError):
    """The config file as a whole cannot be used."""


class _ContentsClient(Protocol):
    def get_repo(self, full_name_or_id: str) -> _ContentsRepo: ...


@dataclass(frozen=True)
class RepoEntry:
    repo: str
    status_comment: StatusComment
    safety: Safety
    eligibility: Eligibility
    mode: Mode
    change_source: ChangeSource = "github"
    full_tick_minutes: int = FULL_TICK_MINUTES_DEFAULT


BUILTIN_PYTORCH = RepoEntry(TARGET_REPO, "drci", "pytorchbot", "merge_rules", "active")


def is_primary(repo: str) -> bool:
    """True for the primary repo, by exact name: the one every pytorch special case asks about."""
    return repo == TARGET_REPO


@dataclass(frozen=True)
class RepoConfig:
    """``served`` and ``safety_only`` (with its reason) in file order, the primary first.

    ``refused`` holds each refused repo as written with its reason; ``error`` says why the file as a
    whole could not be used, or is None.
    """

    served: tuple[RepoEntry, ...]
    safety_only: tuple[tuple[RepoEntry, str], ...]
    refused: tuple[tuple[str, str], ...]
    error: str | None = None

    def lookup(self, repo: str) -> tuple[RepoEntry, bool] | None:
        """``(entry, True)`` for a served repo, ``(entry, False)`` for a safety-only one, else None."""
        for entry in self.served:
            if entry.repo == repo:
                return entry, True
        for entry, _reason in self.safety_only:
            if entry.repo == repo:
                return entry, False
        return None

    @property
    def problems(self) -> tuple[str, ...]:
        found = [f"repos config unreadable: {self.error}"] if self.error is not None else []
        found.extend(f"{entry.repo} is safety-only: {reason}" for entry, reason in self.safety_only)
        found.extend(f"{repo} is refused: {reason}" for repo, reason in self.refused)
        return tuple(found)


BUILTIN_CONFIG = RepoConfig(served=(BUILTIN_PYTORCH,), safety_only=(), refused=())


def _not_one_of(field: str, value: object, allowed: Sequence[str]) -> str:
    return f"{field} {value!r} is not one of {list(allowed)}"


def _entry_problems(raw: Mapping[object, object]) -> list[str]:
    problems: list[str] = []
    for field, allowed in _ENUMS.items():
        if field not in raw:
            problems.append(f"{field} is missing")
        elif raw[field] not in allowed:
            problems.append(_not_one_of(field, raw[field], allowed))
    return problems


def _cross_field_problems(repo: str, raw: Mapping[object, object]) -> list[str]:
    problems: list[str] = []
    if raw["safety"] == "pytorchbot" and repo not in PYTORCHBOT_GUARDED_REPOS:
        problems.append(f"safety: pytorchbot is only for {sorted(PYTORCHBOT_GUARDED_REPOS)}")
    if raw["safety"] == "gate" and raw["mode"] == "active":
        problems.append("safety: gate cannot be active in this release")
    return problems


def _change_fields(raw: Mapping[object, object], default: RepoEntry) -> tuple[ChangeSource, int, dict[str, str]]:
    """``raw``'s ``change_source`` and ``full_tick_minutes``, and the problem of each key that has one.

    A missing, bad or disallowed value resolves to ``default``'s.
    """
    problems: dict[str, str] = {}
    change_source = default.change_source
    if "change_source" in raw:
        written = raw["change_source"]
        if written in CHANGE_SOURCES:
            change_source = written
        else:
            problems["change_source"] = _not_one_of("change_source", written, CHANGE_SOURCES)
    full_tick_minutes = default.full_tick_minutes
    if "full_tick_minutes" in raw:
        value = raw["full_tick_minutes"]
        if change_source != "clickhouse":
            problems["full_tick_minutes"] = "full_tick_minutes is only for change_source: clickhouse"
        elif (
            isinstance(value, bool)
            or not isinstance(value, int)
            or not FULL_TICK_MINUTES_MIN <= value <= FULL_TICK_MINUTES_MAX
        ):
            problems["full_tick_minutes"] = (
                f"full_tick_minutes {value!r} is not an integer from {FULL_TICK_MINUTES_MIN} to {FULL_TICK_MINUTES_MAX}"
            )
        else:
            full_tick_minutes = value
    return change_source, full_tick_minutes, problems


def _checked_entry(repo: str, raw: Mapping[object, object], *, duplicated: bool) -> RepoEntry | str:
    """A non-primary ``raw`` as an entry, or the reason it is refused."""
    problems = _entry_problems(raw)
    if duplicated:
        problems.append("the repo is listed more than once")
    if problems:
        return "; ".join(problems)
    entry = RepoEntry(
        repo,
        status_comment=cast("StatusComment", raw["status_comment"]),
        safety=cast("Safety", raw["safety"]),
        eligibility=cast("Eligibility", raw["eligibility"]),
        mode=cast("Mode", raw["mode"]),
    )
    change_source, full_tick_minutes, change_problems = _change_fields(raw, entry)
    if problems := [*_cross_field_problems(repo, raw), *change_problems.values()]:
        return "; ".join(problems)
    return dataclasses.replace(entry, change_source=change_source, full_tick_minutes=full_tick_minutes)


def _unknown_keys(raw: Mapping[object, object]) -> list[str]:
    return sorted(str(key) for key in raw if key not in _KNOWN_KEYS)


def _primary(copies: Sequence[Mapping[object, object]], *, duplicated: bool) -> RepoEntry | str:
    """The primary's served entry, or the reason it is safety-only."""
    if duplicated:
        return f"its entry ({TARGET_REPO}) is duplicated"
    if not copies:
        return f"its entry ({TARGET_REPO}) is missing"
    raw = copies[0]
    for field in _PINNED_FIELDS:
        value = raw.get(field)
        if value != getattr(BUILTIN_PYTORCH, field):
            logger.error(
                "repos config: %s %s %r ignored; it is pinned to %r",
                TARGET_REPO,
                field,
                value,
                getattr(BUILTIN_PYTORCH, field),
            )
    if unknown := _unknown_keys(raw):
        logger.error("repos config: %s unknown key(s) %s ignored", TARGET_REPO, unknown)
    mode = raw.get("mode")
    if mode not in MODES:
        return f"its {_not_one_of('mode', mode, MODES)}"
    change_source, full_tick_minutes, problems = _change_fields(raw, BUILTIN_PYTORCH)
    for field, problem in problems.items():
        logger.error("repos config: %s %s; ignored, it stays %r", TARGET_REPO, problem, getattr(BUILTIN_PYTORCH, field))
    return dataclasses.replace(
        BUILTIN_PYTORCH, mode=mode, change_source=change_source, full_tick_minutes=full_tick_minutes
    )


def _load_document(text: str | bytes) -> list[object]:
    try:
        document = yaml.load(text, Loader=_Loader)  # noqa: S506 -- _Loader is a yaml.SafeLoader
    except yaml.YAMLError as exc:
        raise ConfigUnreadable(f"not valid YAML: {exc}") from exc
    if not isinstance(document, dict):
        raise ConfigUnreadable(f"the top level must be a mapping, got {type(document).__name__}")
    if unknown := sorted(str(key) for key in document if key != "repos"):
        logger.warning("repos config: unknown top-level key(s) %s ignored", unknown)
    repos = document.get("repos")
    if not isinstance(repos, list):
        raise ConfigUnreadable(f"repos must be a list, got {type(repos).__name__}")
    return repos


def _repo_name(item: object) -> str | None:
    repo = item.get("repo") if isinstance(item, dict) else None
    return repo if isinstance(repo, str) and _REPO_NAME.fullmatch(repo) else None


def parse(text: str | bytes) -> RepoConfig:
    """Validate a repos.yaml document; ``ConfigUnreadable`` when the file as a whole cannot be used."""
    items = _load_document(text)
    counts: dict[str, int] = {}
    for item in items:
        if (name := _repo_name(item)) is not None:
            counts[name.lower()] = counts.get(name.lower(), 0) + 1
    primary = _primary(
        [item for item in items if isinstance(item, dict) and _repo_name(item) == TARGET_REPO],
        duplicated=counts.get(TARGET_REPO.lower(), 0) > 1,
    )
    served: list[RepoEntry] = [primary] if isinstance(primary, RepoEntry) else []
    safety_only: list[tuple[RepoEntry, str]] = [] if isinstance(primary, RepoEntry) else [(BUILTIN_PYTORCH, primary)]
    refused: list[tuple[str, str]] = []
    for item in items:
        repo = _repo_name(item)
        if not isinstance(item, dict):
            refused.append((repr(item), "the entry is not a mapping"))
            continue
        if repo is None:
            refused.append((repr(item.get("repo")), "repo must be pytorch/<name>"))
            continue
        if is_primary(repo):
            continue
        entry = _checked_entry(repo, item, duplicated=counts[repo.lower()] > 1)
        if isinstance(entry, str):
            refused.append((repo, entry))
        elif unknown := _unknown_keys(item):
            safety_only.append((entry, f"unknown key(s) {unknown}"))
        else:
            served.append(entry)
    config = RepoConfig(served=tuple(served), safety_only=tuple(safety_only), refused=tuple(refused))
    for problem in config.problems:
        logger.error("repos config: %s", problem)
    return config


def _default_path() -> Path:
    return Path(__file__).resolve().parents[2] / "repos.yaml"


def load_local(path: Path | None = None) -> RepoConfig:
    """The config from a local checkout; ``BUILTIN_CONFIG`` with ``error`` set when it is missing or unreadable."""
    source = _default_path() if path is None else path
    try:
        return parse(source.read_bytes())
    except (OSError, ConfigUnreadable) as exc:
        logger.error("repos config %s is unusable; serving only the built-in %s entry: %s", source, TARGET_REPO, exc)
        return dataclasses.replace(BUILTIN_CONFIG, error=f"{source}: {exc}")


def fetch_config(client: _ContentsClient) -> RepoConfig:
    """The config on ``DISPATCH_REPO``'s default branch, through the contents API. Every failure raises."""
    contents = client.get_repo(DISPATCH_REPO).get_contents(REPOS_CONFIG_PATH)
    if isinstance(contents, Sequence):
        raise ConfigUnreadable(f"{DISPATCH_REPO}/{REPOS_CONFIG_PATH} resolved to a directory, not a single file")
    return parse(contents.decoded_content)
