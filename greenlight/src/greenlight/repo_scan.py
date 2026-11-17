"""The per-repo decisions of one scan: its config entry, the live checks, its eligibility source, its work.

``scan_repo`` reads the repos config through its cache (a cold failure falls back to
``BUILTIN_CONFIG``), looks the repo up by exact name, checks what GitHub reports for it
(``check_identity``: the exact canonical name, public, default branch ``main``: ``accepts_base``
judges bases against ``main``, so a repo on another default branch would get no reviews), and then
does the work ``repo_work`` gives the entry: the drain when its mode is ``off``; the review
(``review.run``), whole when served and only its safety work when safety-only. A ``gate`` entry that
is not off first runs the approval-backing check (``backs_approvals``, ``approval_backing``), its
safety work, which is all a safety-only one gets; an ``active`` one whose check could not read its
branch rules, or found GreenLight's gate not enforced, is not reviewed (``dispatch_refusal``). ``--pr``
runs no backing check. A refused or absent repo, or one that fails a live check, gets no work at all.
Every such problem, an unreadable config and a safety-only entry fail the scan, the last two after
the safety work ran. The config read, the dispatch and the drain's read of the review runs use the
dispatch token (``Config.dispatch_or_scan_token``): all three are on ``DISPATCH_REPO``. ``tick``
routes every configured repo at once through the same ``repo_work``, ``backs_approvals``,
``dispatch_refusal`` and ``check_identity``.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Literal, NamedTuple, NoReturn

from greenlight import approval_backing, drain, github_client, merge_authz, review, writers
from greenlight.constants import TARGET_BRANCH
from greenlight.guards import IterationTimeout
from greenlight.repo_config import BUILTIN_CONFIG, is_primary
from greenlight.scan_memory import ScanMemory
from greenlight.snapshot_cache import SnapshotCache

if TYPE_CHECKING:
    from collections.abc import Callable
    from typing import Unpack

    from github import Github

    from greenlight.approval_backing import BackingReport
    from greenlight.config import Config
    from greenlight.merge_authz import MergeRulesSnapshot
    from greenlight.quota import RequestMeter
    from greenlight.repo_config import Eligibility, RepoConfig, RepoEntry
    from greenlight.review import RunFn, ScanOptions
    from greenlight.review_finish import BuildClient

    EligibilityCaches = dict[tuple[str, Eligibility], SnapshotCache[Github, MergeRulesSnapshot]]

logger = logging.getLogger(__name__)

# An eligibility source may be served stale on a transient failure for this many TTLs; past that the
# repo's scan fails, as it would at once with no snapshot.
_ELIGIBILITY_MAX_STALE_TTLS = 3


class RepoUnavailable(Exception):
    """A repo's token cannot be had, or GitHub's report of it fails a live check: no work this scan."""


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


def check_identity(entry: RepoEntry, client: Github) -> None:
    """Raise ``RepoUnavailable`` when what GitHub reports for ``entry``'s repo fails a live check."""
    problem = identity_problem(entry, fetch_identity(client, entry.repo))
    if problem is not None:
        raise RepoUnavailable(problem)


class RepoWork(NamedTuple):
    """What a scan does for an entry: its ``kind`` of work, and whether its review goes past the safety work."""

    kind: Literal["drain", "review", "backing"]
    optional: bool


def repo_work(entry: RepoEntry, *, served: bool) -> RepoWork:
    """The work of ``entry``, served or safety-only, on either entry point (``scan_repo``, ``tick``).

    ``off`` drains. A ``pytorchbot`` entry, or a served ``gate`` one, is reviewed, past its safety work
    only when served. A safety-only ``gate`` entry gets its approval-backing check alone.
    """
    if entry.mode == "off":
        return RepoWork("drain", optional=False)
    if entry.safety == "pytorchbot" or served:
        return RepoWork("review", optional=served)
    return RepoWork("backing", optional=False)


def backs_approvals(entry: RepoEntry) -> bool:
    """Whether ``entry`` runs the approval-backing check as its safety work: a ``gate`` entry that is not off."""
    return entry.safety == "gate" and entry.mode != "off"


def dispatch_refusal(entry: RepoEntry, report: BackingReport | None) -> str | None:
    """Why ``entry`` may not be reviewed this tick, or None.

    Only an ``active`` gate entry is refused: when its backing ``report`` (None: the check did not finish)
    has no rules answer, or says GreenLight's gate is not enforced on it.
    """
    if entry.safety != "gate" or entry.mode != "active":
        return None
    rules = None if report is None else report.rules
    if rules is None:
        return "no dispatch this tick: the rules could not be read"
    if not rules.enforced:
        return f"no dispatch this tick: GreenLight's gate is not enforced on {entry.repo}: {'; '.join(rules.problems)}"
    return None


def eligibility_resolver(entry: RepoEntry) -> tuple[str, Callable[[Github], MergeRulesSnapshot]]:
    """How ``entry``'s eligibility source is named in the logs, and its fetch: its merge rules, or its
    writers as one rule."""
    if entry.eligibility == "write_permission":
        return f"writers of {entry.repo}", lambda client: writers.resolve_writers(client, entry.repo)
    return f"merge rules of {entry.repo}", lambda client: merge_authz.resolve_merge_rules(client, entry.repo)


def eligibility_client(entry: RepoEntry, token: str, *, meter: RequestMeter | None = None) -> Callable[[], Github]:
    """The primary's eligibility client (``build_authz_client``), else the fail-fast one.

    The primary's client rides out a short rate limit only on the unmetered single-repo path
    (``scan_repo``); inside the tick, ``meter`` counts and stops the client's requests and latches the
    tick on the first rate limit, without waiting it out (``quota``).
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
        label, fetch = eligibility_resolver(entry)
        cache = SnapshotCache(
            fetch,
            label=label,
            ttl_seconds=ttl_seconds,
            max_stale_seconds=_ELIGIBILITY_MAX_STALE_TTLS * ttl_seconds,
            stale_on_broken=False,
        )
        caches[key] = cache
    return cache


def eligibility_thunk(
    config: Config, entry: RepoEntry, caches: EligibilityCaches, token: str, *, meter: RequestMeter | None = None
) -> Callable[[], MergeRulesSnapshot]:
    """``entry``'s eligibility snapshot through its cache in ``caches``, read with ``token`` when due."""
    cache = eligibility_cache(caches, entry, config.merge_rules_ttl_seconds)
    build_client = eligibility_client(entry, token, meter=meter)
    return lambda: cache.snapshot(build_client)


def scanned_entries(repo_config: RepoConfig) -> tuple[tuple[RepoEntry, bool], ...]:
    """Every served ``(entry, True)`` and safety-only ``(entry, False)`` entry.

    The primary comes first, then the other served entries, then the other safety-only ones, each in
    file order.
    """
    found = [(entry, True) for entry in repo_config.served]
    found.extend((entry, False) for entry, _reason in repo_config.safety_only)
    return tuple(sorted(found, key=lambda item: not is_primary(item[0].repo)))


def drain_error(report: drain.DrainReport) -> str | None:
    """The scan error a drain slice reports, or None when it failed on no PR."""
    if not report.failed:
        return None
    return f"the drain failed on {len(report.failed)} PR(s): {list(report.failed)}"


def read_config(
    cache: SnapshotCache[Github, RepoConfig], build_client: Callable[[], Github], errors: list[str]
) -> RepoConfig:
    """The repos config through ``cache``, its problems added to ``errors``; a rate limit raises."""
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
    run_review: RunFn = review.run,
    run_drain: Callable[..., drain.DrainReport] = drain.drain,
    run_backing: Callable[..., BackingReport] = approval_backing.check,
    **review_kwargs: Unpack[ScanOptions],
) -> None:
    """Scan ``repo`` once as its config entry says.

    ``memories`` is None for ``--pr``; ``review_kwargs`` go to ``review.run``.
    """
    token = config.github_token
    if not token:
        raise ValueError("PYTORCH_GREENLIGHT_GITHUB_TOKEN is required to query GitHub")
    dispatch_token = config.dispatch_or_scan_token
    errors: list[str] = []
    repo_config = read_config(config_cache, lambda: build_github(dispatch_token), errors)
    found = repo_config.lookup(repo)
    if found is None:
        reasons = [reason for name, reason in repo_config.refused if name == repo]
        errors.append(f"refused: {reasons[0]}" if reasons else "it has no entry in the repos config")
        _raise(repo, errors)
    entry, served = found
    client = build_github(token)
    try:
        check_identity(entry, client)
    except RepoUnavailable as exc:
        errors.append(f"refused for this scan: {exc}")
        _raise(repo, errors)
    finally:
        github_client.close_client(client)
    if not served:
        errors.append(f"safety-only: {dict(repo_config.safety_only)[entry]}")
    memory = None if memories is None else memories.setdefault(repo, ScanMemory())
    work = repo_work(entry, served=served)
    if memory is not None and work.kind != "drain":
        memory.clear_drain()
    refusal = None
    if memory is not None and backs_approvals(entry):
        backing = run_backing(config, entry=entry, memory=memory, bot_login=bot_login, build_github=build_github)
        errors.extend(backing.errors)
        refusal = dispatch_refusal(entry, backing)
    if work.kind == "drain":
        if memory is None:
            logger.warning("%s is off: --pr reviews nothing", repo)
        else:
            report = run_drain(
                config,
                repo=repo,
                memory=memory,
                bot_login=bot_login,
                build_github=build_github,
                dispatch_token=dispatch_token,
            )
            if (problem := drain_error(report)) is not None:
                errors.append(problem)
    elif work.kind == "backing":
        if memory is None:
            logger.warning("%s: a safety-only gate entry is not reviewed: --pr does nothing", repo)
    elif refusal is not None:
        errors.append(refusal)
    else:
        run_review(
            config,
            entry=entry,
            optional=work.optional,
            pr=pr,
            bot_login=bot_login,
            build_github=build_github,
            resolve_merge_rules=eligibility_thunk(config, entry, eligibility_caches, token),
            memory=memory,
            dispatch_token=dispatch_token,
            **review_kwargs,
        )
    _raise_any(repo, errors)
