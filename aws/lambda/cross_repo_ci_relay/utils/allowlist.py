"""Allowlist loading and parsing

YAML format:
  L1:
    - org1/repo1
    - org2/repo2
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


@dataclass
class AllowlistEntry:
    repo: str
    oncalls: list[str] = field(default_factory=list)

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
            oncalls = (
                [o.strip() for o in str(oncalls_raw).split(",") if o.strip()]
                if oncalls_raw
                else []
            )
            return cls(repo=repo, oncalls=oncalls)

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

    @classmethod
    def _parse(cls, raw: dict) -> "AllowlistMap":
        if not isinstance(raw, dict):
            raise RuntimeError(
                f"Invalid allowlist: expected a dict with L1-L4 keys, got {type(raw).__name__}"
            )
        seen_repos: set[str] = set()
        levels: dict[AllowlistLevel, list[AllowlistEntry]] = {}
        for level in AllowlistLevel:
            raw_entries = raw.get(level) or []
            if not isinstance(raw_entries, list):
                raise RuntimeError(
                    f"Invalid allowlist: {level} must be a list, got {type(raw_entries).__name__}"
                )
            entries: list[AllowlistEntry] = []
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
