"""Allowlist loading and parsing

YAML format:
  L1:
    - org1/repo1
    - org2/repo2
  L3:
    device1:
      org3/device1-repo: [oncall1, oncall2]
    device2:
      org4/device2-repo: [oncall1]
  L4:
    - org5/repo5: oncall1, oncall2
"""

import logging
from dataclasses import dataclass, field
from enum import Enum
from urllib.parse import urlparse

import yaml

from . import gh_helper, redis_helper
from .config import RelayConfig


logger = logging.getLogger(__name__)


class AllowlistLevel(str, Enum):
    L1 = "L1"
    L2 = "L2"
    L3 = "L3"
    L4 = "L4"


class CrcrEvent(str, Enum):
    PULL_REQUEST = "pull_request"
    NIGHTLY = "nightly"


DEFAULT_CRCR_EVENTS = frozenset(CrcrEvent)


@dataclass
class AllowlistEntry:
    repo: str
    oncalls: list[str] = field(default_factory=list)
    device: str = ""  # L3 only: suffix of the ciflow/crcr/{device} label
    events: frozenset[CrcrEvent] = field(default_factory=lambda: DEFAULT_CRCR_EVENTS)

    @staticmethod
    def _parse_oncalls(raw_oncalls, context: str) -> list[str]:
        if raw_oncalls is None:
            return []
        if isinstance(raw_oncalls, str):
            return [
                oncall.strip() for oncall in raw_oncalls.split(",") if oncall.strip()
            ]
        if isinstance(raw_oncalls, list):
            return [
                str(oncall).strip() for oncall in raw_oncalls if str(oncall).strip()
            ]
        raise RuntimeError(
            f"Invalid allowlist: {context}.oncalls must be a string or list"
        )

    @staticmethod
    def _parse_events(raw_events, context: str) -> frozenset[CrcrEvent]:
        if raw_events is None:
            return DEFAULT_CRCR_EVENTS
        if not isinstance(raw_events, list) or not raw_events:
            raise RuntimeError(
                f"Invalid allowlist: {context}.events must be a non-empty list"
            )

        events: set[CrcrEvent] = set()
        for raw_event in raw_events:
            if not isinstance(raw_event, str):
                raise RuntimeError(
                    f"Invalid allowlist: {context}.events entries must be strings"
                )
            try:
                event = CrcrEvent(raw_event.strip())
            except ValueError as exc:
                supported = ", ".join(event.value for event in CrcrEvent)
                raise RuntimeError(
                    f"Invalid allowlist: {context}.events has unsupported event "
                    f"{raw_event!r}; expected one of {supported}"
                ) from exc
            if event in events:
                raise RuntimeError(
                    f"Invalid allowlist: {context}.events contains duplicate {event.value!r}"
                )
            events.add(event)
        return frozenset(events)

    @classmethod
    def _metadata_from_raw(
        cls, raw_metadata, context: str
    ) -> tuple[list[str], frozenset[CrcrEvent]]:
        if isinstance(raw_metadata, dict):
            unknown_fields = set(raw_metadata) - {"oncalls", "events"}
            if unknown_fields:
                unknown = ", ".join(sorted(map(str, unknown_fields)))
                raise RuntimeError(
                    f"Invalid allowlist: {context} has unsupported metadata field(s): {unknown}"
                )
            raw_oncalls = raw_metadata.get("oncalls")
            raw_events = raw_metadata.get("events")
        else:
            raw_oncalls = raw_metadata
            raw_events = None
        return (
            cls._parse_oncalls(raw_oncalls, context),
            cls._parse_events(raw_events, context),
        )

    @classmethod
    def _from_raw(cls, raw_entry, level: AllowlistLevel, idx: int) -> "AllowlistEntry":
        if isinstance(raw_entry, str):
            repo = raw_entry.strip().strip("/")
            if not repo or "/" not in repo:
                raise RuntimeError(
                    f"Invalid allowlist: {level}[{idx}] must be in owner/repo format, got {raw_entry!r}"
                )
            return cls(repo=repo)

        if isinstance(raw_entry, dict):
            if len(raw_entry) != 1:
                raise RuntimeError(
                    f"Invalid allowlist: {level}[{idx}] mapping must have exactly one repo key"
                )
            repo_raw, oncalls_raw = next(iter(raw_entry.items()))
            repo = str(repo_raw).strip().strip("/")
            if not repo or "/" not in repo:
                raise RuntimeError(
                    f"Invalid allowlist: {level}[{idx}] must be in owner/repo format, got {repo_raw!r}"
                )
            oncalls, events = cls._metadata_from_raw(oncalls_raw, f"{level}[{idx}]")
            return cls(repo=repo, oncalls=oncalls, events=events)

        raise RuntimeError(
            f"Invalid allowlist: {level}[{idx}] must be a string or mapping, got {type(raw_entry).__name__}"
        )


class AllowlistMap:
    def __init__(self, levels: dict[AllowlistLevel, list[AllowlistEntry]]):
        self._levels = levels

    def get_level(self, level: AllowlistLevel) -> tuple[list[str], list[str]]:
        """Return (backends, oncalls) for exactly the given level."""
        entries = self._levels.get(level, [])
        return (
            [e.repo for e in entries],
            [o for e in entries for o in e.oncalls],
        )

    def get_repos_for_device(self, device: str) -> tuple[list[str], list[str]]:
        """Return (backends, oncalls) for L3 repos registered under the given device label.

        device is the suffix of ciflow/crcr/{device}.
        """
        entries = [
            e for e in self._levels.get(AllowlistLevel.L3, []) if e.device == device
        ]
        return [e.repo for e in entries], [o for e in entries for o in e.oncalls]

    def get_repo_device(self, repo: str) -> str | None:
        """Return the device label suffix for an L3 repo, or None if not L3."""
        for entry in self._levels.get(AllowlistLevel.L3, []):
            if entry.repo == repo:
                return entry.device or None
        return None

    def get_repos_at_or_above_level(
        self, level: AllowlistLevel
    ) -> tuple[list[str], list[str]]:
        """Return (backends, oncalls) for the given level and all lower-priority levels.

        Example: get_repos_at_or_above_level(AllowlistLevel.L2) returns
        repos/oncalls from L2, L3, L4.
        """
        levels = list(AllowlistLevel)
        repos: list[str] = []
        oncalls: list[str] = []
        for lvl in levels[levels.index(level) :]:
            lvl_repos, lvl_oncalls = self.get_level(lvl)
            repos.extend(lvl_repos)
            oncalls.extend(lvl_oncalls)
        return repos, oncalls

    def get_repo_level(self, repo: str) -> AllowlistLevel | None:
        """Return the level for a specific repo, or None if repo is not in allowlist."""
        for level, entries in self._levels.items():
            for entry in entries:
                if entry.repo == repo:
                    return level
        return None

    def get_repo_events(self, repo: str) -> frozenset[CrcrEvent]:
        """Return configured logical CRCR events for a repo, or an empty set if unknown."""
        for entries in self._levels.values():
            for entry in entries:
                if entry.repo == repo:
                    return entry.events
        return frozenset()

    def needs_check_run(self, repo: str, pr_labels: set[str]) -> bool:
        """Return True when an upstream check run should be created for this repo.

        L4+: always True.
        L3: True only when the matching ciflow/crcr/<device> label is present.
        L1/L2/unknown: False.
        """
        level = self.get_repo_level(repo)
        if level is None or level.value < AllowlistLevel.L3.value:
            return False
        if level.value >= AllowlistLevel.L4.value:
            return True
        device = self.get_repo_device(repo)
        return bool(device and f"ciflow/crcr/{device}" in pr_labels)

    @classmethod
    def _parse(cls, raw: dict) -> "AllowlistMap":
        if not isinstance(raw, dict):
            raise RuntimeError(
                f"Invalid allowlist: expected a dict with L1-L4 keys, got {type(raw).__name__}"
            )
        seen_repos: set[str] = set()
        levels: dict[AllowlistLevel, list[AllowlistEntry]] = {}
        for level in AllowlistLevel:
            entries: list[AllowlistEntry] = []
            if level == AllowlistLevel.L3:
                raw_entries = raw.get(level) or {}
                if not isinstance(raw_entries, dict):
                    raise RuntimeError(
                        f"Invalid allowlist: L3 must be a device mapping "
                        f"(e.g. 'device:\\n  org/repo: [oncall]'), "
                        f"got {type(raw_entries).__name__}"
                    )
                for device, repos_raw in raw_entries.items():
                    device = str(device).strip()
                    if not device:
                        raise RuntimeError(
                            "Invalid allowlist: L3 device name must not be empty"
                        )
                    if not isinstance(repos_raw, dict):
                        raise RuntimeError(
                            f"Invalid allowlist: L3.{device} must be a repo mapping, "
                            f"got {type(repos_raw).__name__}"
                        )
                    for repo_raw, metadata_raw in repos_raw.items():
                        repo = str(repo_raw).strip().strip("/")
                        if not repo or "/" not in repo:
                            raise RuntimeError(
                                f"Invalid allowlist: L3.{device}.{repo_raw!r} must be in owner/repo format"
                            )
                        if repo in seen_repos:
                            raise RuntimeError(
                                f"Invalid allowlist: duplicate repo {repo!r}"
                            )
                        seen_repos.add(repo)
                        oncalls, events = AllowlistEntry._metadata_from_raw(
                            metadata_raw, f"L3.{device}.{repo}"
                        )
                        entries.append(
                            AllowlistEntry(
                                repo=repo,
                                oncalls=oncalls,
                                device=device,
                                events=events,
                            )
                        )
            else:
                raw_entries = raw.get(level) or []
                if not isinstance(raw_entries, list):
                    raise RuntimeError(
                        f"Invalid allowlist: {level} must be a list, got {type(raw_entries).__name__}"
                    )
                for idx, raw_entry in enumerate(raw_entries):
                    entry = AllowlistEntry._from_raw(raw_entry, level, idx)
                    if entry.repo in seen_repos:
                        raise RuntimeError(
                            f"Invalid allowlist: duplicate repo {entry.repo!r}"
                        )
                    seen_repos.add(entry.repo)
                    entries.append(entry)
            levels[level] = entries
        return cls(levels)


def _fetch(url: str) -> str:
    """Fetch allowlist YAML content from a GitHub blob URL.

    Expected format: https://github.com/<owner>/<repo>/blob/<ref>/<path/to/file>
    """
    parsed = urlparse(url)
    parts = [p for p in parsed.path.split("/") if p]
    # parts must be: [owner, repo, "blob", ref, *file_path_parts]
    if (
        parsed.scheme not in ("http", "https")
        or parsed.netloc != "github.com"
        or len(parts) < 5
        or parts[2] != "blob"
    ):
        raise RuntimeError(
            f"Invalid GitHub allowlist URL {url!r}. "
            "Expected: https://github.com/<owner>/<repo>/blob/<ref>/<path>"
        )
    owner, repo, _blob, ref, *file_parts = parts
    return gh_helper.get_repo_file(owner, repo, "/".join(file_parts), ref)


def load_allowlist(config: RelayConfig) -> AllowlistMap:
    # The allowlist source is fetched from GitHub without authentication, so repeated
    # cache misses can run into the unauthenticated 60 requests/hour rate limit.
    # Keep Redis as the primary read path and rely on config-level TTL flooring to
    # prevent overly aggressive refetch intervals.
    yaml_str = redis_helper.get_cached_yaml(config)
    if yaml_str is None:
        logger.info("allowlist cache miss - loading from %s", config.allowlist_url)
        yaml_str = _fetch(config.allowlist_url)
        redis_helper.set_cached_yaml(config, yaml_str)
    return AllowlistMap._parse(yaml.safe_load(yaml_str) or {})
