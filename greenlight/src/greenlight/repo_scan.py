"""The per-repo decisions of one scan: its config entry, the live checks, its eligibility source, its mode.

``scan_repo`` reads the repos config through its cache (a cold failure falls back to
``BUILTIN_CONFIG``), looks the repo up by exact name, checks what GitHub reports for it (the exact
canonical name, public, default branch ``main``: ``accepts_base`` judges bases against ``main``, so a
repo on another default branch would get no reviews), and then drains it when its mode is ``off``
or runs ``review.run`` on it otherwise: whole when served, only its safety work when safety-only.
A refused or absent repo, or one that fails a live check, gets no work at all. Every such problem,
an unreadable config and a safety-only entry fail the scan, the last two after the safety work ran.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, NamedTuple, NoReturn

from greenlight import drain, github_client, merge_authz, review, writers
from greenlight.constants import TARGET_BRANCH
from greenlight.guards import IterationTimeout
from greenlight.repo_config import BUILTIN_CONFIG, is_primary
from greenlight.scan_memory import ScanMemory
from greenlight.snapshot_cache import SnapshotCache

if TYPE_CHECKING:
    from collections.abc import Callable

    from github import Github

    from greenlight.config import Config
    from greenlight.merge_authz import MergeRulesSnapshot
    from greenlight.quota import RequestMeter
    from greenlight.repo_config import Eligibility, RepoConfig, RepoEntry
    from greenlight.review_finish import BuildClient

    EligibilityCaches = dict[tuple[str, Eligibility], SnapshotCache[Github, MergeRulesSnapshot]]

logger = logging.getLogger(__name__)

# An eligibility source may be served stale on a transient failure for this many TTLs; past that the
# repo's scan fails, as it would at once with no snapshot.
_ELIGIBILITY_MAX_STALE_TTLS = 3


class RepoIdentity(NamedTuple):
    full_name: str
    private: bool
    default_branch: str


def fetch_identity(client: Github, repo: str) -> RepoIdentity:
    """What GitHub reports for ``repo`` (``GET /repos/{repo}``), its canonical name included."""
    _headers, data = client.requester.requestJsonAndCheck("GET", f"/repos/{repo}")
    full_name, private, default_branch = data.get("full_name"), data.get("private"), data.get("default_branch")
    if not isinstance(full_name, str) or not isinstance(private, bool) or not isinstance(default_branch, str):
        raise ValueError(f"GET /repos/{repo} returned an unexpected shape")
    return RepoIdentity(full_name, private, default_branch)


def identity_problem(entry: RepoEntry, identity: RepoIdentity) -> str | None:
    """Why GitHub's report refuses ``entry`` for this scan, or None when it passes every live check."""
    if identity.full_name != entry.repo:
        return f"GitHub names it {identity.full_name!r}; the entry must use that exact name"
    if identity.private:
        return "it is private"
    if identity.default_branch != TARGET_BRANCH:
        return f"its default branch is {identity.default_branch!r}, not {TARGET_BRANCH!r}"
    return None


def eligibility_resolver(entry: RepoEntry) -> Callable[[Github], MergeRulesSnapshot]:
    """The fetch of ``entry``'s eligibility source: its merge rules, or its writers as one rule."""
    if entry.eligibility == "write_permission":

        def resolve_writers(client: Github) -> MergeRulesSnapshot:
            return writers.resolve_writers(client, entry.repo)

        resolve_writers.__name__ = f"writers of {entry.repo}"
        return resolve_writers

    def resolve(client: Github) -> MergeRulesSnapshot:
        return merge_authz.resolve_merge_rules(client, entry.repo)

    resolve.__name__ = f"merge rules of {entry.repo}"
    return resolve


def eligibility_client(entry: RepoEntry, token: str, *, meter: RequestMeter | None = None) -> Callable[[], Github]:
    """The primary's eligibility reads ride out a short rate limit (``build_authz_client``); others fail fast.

    ``meter`` counts and stops the client's requests (``quota``).
    """
    if is_primary(entry.repo):
        return lambda: github_client.build_authz_client(token, meter=meter)
    return lambda: github_client.build_client(token, meter=meter)


def eligibility_cache(
    caches: EligibilityCaches, entry: RepoEntry, ttl_seconds: float
) -> SnapshotCache[Github, MergeRulesSnapshot]:
    """``entry``'s cache in ``caches``, made on first use: TTL ``ttl_seconds``, never stale on a broken source."""
    key = (entry.repo, entry.eligibility)
    cache = caches.get(key)
    if cache is None:
        cache = SnapshotCache(
            eligibility_resolver(entry),
            ttl_seconds=ttl_seconds,
            max_stale_seconds=_ELIGIBILITY_MAX_STALE_TTLS * ttl_seconds,
            stale_on_broken=False,
        )
        caches[key] = cache
    return cache


def _read_config(
    cache: SnapshotCache[Github, RepoConfig], build_client: Callable[[], Github], errors: list[str]
) -> RepoConfig:
    try:
        repo_config = cache.snapshot(build_client)
    except IterationTimeout:
        raise
    except Exception as exc:
        if github_client.is_rate_limit_error(exc):
            raise
        logger.error("cannot read the repos config; serving only the built-in entry", exc_info=True)
        errors.append(f"repos config unreadable, serving only the built-in entry: {exc}")
        return BUILTIN_CONFIG
    if cache.stale_error is not None:
        errors.append(f"repos config unreadable, serving the last good snapshot: {cache.stale_error}")
    if repo_config.error is not None:
        errors.append(f"repos config unreadable: {repo_config.error}")
    return repo_config


def _raise(repo: str, errors: list[str]) -> NoReturn:
    raise RuntimeError(f"{repo}: " + "; ".join(errors))


def _raise_any(repo: str, errors: list[str]) -> None:
    if errors:
        _raise(repo, errors)


def scan_repo(
    config: Config,
    *,
    repo: str,
    config_cache: SnapshotCache[Github, RepoConfig],
    eligibility_caches: EligibilityCaches,
    memories: dict[str, ScanMemory] | None,
    pr: int | None = None,
    bot_login: str = "",
    build_github: BuildClient = github_client.build_client,
    get_identity: Callable[[Github, str], RepoIdentity] = fetch_identity,
    run_review: Callable[..., int] = review.run,
    run_drain: Callable[..., drain.DrainReport] = drain.drain,
    **review_kwargs: Any,
) -> None:
    """Scan ``repo`` once as its config entry says.

    ``memories`` is None for ``--pr``; ``review_kwargs`` go to ``review.run``.
    """
    token = config.github_token
    if not token:
        raise ValueError("PYTORCH_GREENLIGHT_GITHUB_TOKEN is required to query GitHub")
    errors: list[str] = []
    repo_config = _read_config(config_cache, lambda: build_github(token), errors)
    found = repo_config.lookup(repo)
    if found is None:
        reasons = [reason for name, reason in repo_config.refused if name == repo]
        errors.append(f"refused: {reasons[0]}" if reasons else "it has no entry in the repos config")
        _raise(repo, errors)
    entry, served = found
    client = build_github(token)
    try:
        problem = identity_problem(entry, get_identity(client, repo))
    finally:
        github_client.close_client(client)
    if problem is not None:
        errors.append(f"refused for this scan: {problem}")
        _raise(repo, errors)
    if not served:
        errors.append(f"safety-only: {dict(repo_config.safety_only)[entry]}")
    memory = None if memories is None else memories.setdefault(repo, ScanMemory())
    if entry.mode == "off":
        if memory is None:
            logger.warning("%s is off: --pr reviews nothing", repo)
        else:
            report = run_drain(config, repo=repo, memory=memory, bot_login=bot_login, build_github=build_github)
            if report.failed:
                errors.append(f"the drain failed on {len(report.failed)} PR(s): {list(report.failed)}")
        _raise_any(repo, errors)
        return
    if memory is not None:
        memory.clear_drain()
    cache = eligibility_cache(eligibility_caches, entry, config.merge_rules_ttl_seconds)
    build_eligibility_client = eligibility_client(entry, token)
    run_review(
        config,
        entry=entry,
        optional=served,
        pr=pr,
        bot_login=bot_login,
        build_github=build_github,
        resolve_merge_rules=lambda: cache.snapshot(build_eligibility_client),
        memory=memory,
        **review_kwargs,
    )
    _raise_any(repo, errors)
