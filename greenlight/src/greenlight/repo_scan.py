"""The per-repo decisions of one scan: its config, the live checks, its eligibility source, its work.

``scan_repo`` (the CLI's ``review``) first checks what GitHub reports for the repo (``fetch_identity``)
and refuses a private or archived one before reading anything else of it. It then reads the repo's own
``.github/greenlight/config.yml`` through the config cache on the state store it is given
(``config_cache.revalidate`` and ``decide``, as the scan Lambda's planner does: an unreadable file serves
the last file read), stores the updated record, and checks the rest of GitHub's report against the entry
(``check_identity``: the exact canonical name, default branch ``main``: ``accepts_base`` judges bases
against ``main``, so a repo on another default branch would get no reviews). Then it does the work
``repo_work`` gives its entry: the drain when its mode is ``off``; the review (``review.run``), whole when
served and only its safety work when safety-only; or nothing for a safety-only ``gate`` entry, which has
no safety work yet. A repo whose settings give no entry (no file, a refused file, an unreadable one), or
one that fails a live check, gets no work at all. Every problem the settings carry fails the scan, after
the work they still allow ran. The dispatch and the drain's read of the review runs use the dispatch token
(``Config.dispatch_or_scan_token``): both are on ``DISPATCH_REPO``. A listing scan loads the repo's memory
from the store and saves it back, with no lease; each eligibility source is read through a
``SnapshotCache`` whose snapshot the store keeps. The scan Lambda (``fanout``, ``worker``, ``tick``)
routes every repo through the same ``repo_work``, ``identity_problem`` and eligibility caches.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Literal, NamedTuple, NoReturn

from greenlight import config_cache, drain, github_client, merge_authz, review, writers
from greenlight.constants import REPO_CONFIG_PATH, TARGET_BRANCH
from greenlight.guards import IterationTimeout
from greenlight.repo_config import is_primary
from greenlight.scan_memory import ScanMemory, decode_memory, save_memory
from greenlight.snapshot_cache import SnapshotCache
from greenlight.state_store import EligibilityKey, StoreError

if TYPE_CHECKING:
    from collections.abc import Callable
    from typing import Unpack

    from github import Github

    from greenlight.config import Config
    from greenlight.merge_authz import MergeRulesSnapshot
    from greenlight.quota import RequestMeter
    from greenlight.repo_config import RepoEntry, Settings
    from greenlight.review import RunFn, ScanOptions
    from greenlight.review_finish import BuildClient
    from greenlight.state_store import RepoItem, StateStore

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
    archived: bool = False


def fetch_identity(client: Github, repo: str) -> RepoIdentity:
    """What GitHub reports for ``repo`` (``GET /repos/{repo}``), its canonical name included."""
    _headers, data = client.requester.requestJsonAndCheck("GET", f"/repos/{repo}")
    full_name, private, default_branch = data.get("full_name"), data.get("private"), data.get("default_branch")
    archived = data.get("archived", False)
    if (
        not isinstance(full_name, str)
        or not isinstance(private, bool)
        or not isinstance(default_branch, str)
        or not isinstance(archived, bool)
    ):
        raise ValueError(f"GET /repos/{repo} returned an unexpected shape")
    return RepoIdentity(full_name, private, default_branch, archived)


def visibility_problem(identity: RepoIdentity) -> str | None:
    """Why GitHub's report keeps GreenLight from reading anything of the repo (private, archived), or None."""
    if identity.private:
        return "it is private"
    if identity.archived:
        return "it is archived"
    return None


def identity_problem(entry: RepoEntry, identity: RepoIdentity) -> str | None:
    """Why GitHub's report refuses ``entry`` for this scan, or None when it passes every live check."""
    if identity.full_name != entry.repo:
        return f"GitHub names it {identity.full_name!r}; scan it by that exact name"
    if (problem := visibility_problem(identity)) is not None:
        return problem
    if identity.default_branch != TARGET_BRANCH:
        return f"its default branch is {identity.default_branch!r}, not {TARGET_BRANCH!r}"
    return None


def check_identity(entry: RepoEntry, identity: RepoIdentity) -> None:
    """Raise ``RepoUnavailable`` when GitHub's report ``identity`` of ``entry``'s repo fails a live check."""
    problem = identity_problem(entry, identity)
    if problem is not None:
        raise RepoUnavailable(problem)


class RepoWork(NamedTuple):
    """What a scan does for an entry: its ``kind`` of work, and whether its review goes past the safety work."""

    kind: Literal["drain", "review", "none"]
    optional: bool


def repo_work(entry: RepoEntry, *, served: bool) -> RepoWork:
    """The work of ``entry``, served or safety-only, on either entry point (``scan_repo``, ``tick``).

    ``off`` drains. A ``pytorchbot`` entry, or a served ``gate`` one, is reviewed, past its safety work
    only when served. A safety-only ``gate`` entry gets nothing: a gate repo has no safety work yet.
    """
    if entry.mode == "off":
        return RepoWork("drain", optional=False)
    if entry.safety == "pytorchbot" or served:
        return RepoWork("review", optional=served)
    return RepoWork("none", optional=False)


def has_work(work: RepoWork, *, drain_complete: bool) -> bool:
    """Whether a scan Lambda run of a repo with ``work`` has anything to do: an ``off`` repo whose stored drain
    is complete has not, until its settings stop saying ``off`` and a run forgets the drain
    (``ScanMemory.clear_drain``)."""
    return work.kind != "none" and not (work.kind == "drain" and drain_complete)


def eligibility_resolver(entry: RepoEntry) -> tuple[str, Callable[[Github], MergeRulesSnapshot]]:
    """How ``entry``'s eligibility source is named in the logs, and its fetch: its merge rules, or its
    minimum role's holders as one rule."""
    if entry.eligibility == "write_permission":
        return (
            f"{entry.minimum_role}-role writers of {entry.repo}",
            lambda client: writers.resolve_writers(client, entry.repo, minimum_role=entry.minimum_role),
        )
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


def _stored_snapshot(store: StateStore, key: EligibilityKey) -> tuple[MergeRulesSnapshot, float] | None:
    """The snapshot ``store`` keeps for ``key`` and when it was fetched; None, logged, when it cannot be had."""
    try:
        found = store.read_eligibility(key)
        return None if found is None else (merge_authz.decode_snapshot(found[0]), found[1])
    except IterationTimeout:
        raise
    except Exception:
        logger.error("cannot load the stored eligibility snapshot of %s; it is fetched instead", key, exc_info=True)
        return None


def _keep_snapshot(store: StateStore, key: EligibilityKey) -> Callable[[MergeRulesSnapshot, float], None]:
    def keep(snapshot: MergeRulesSnapshot, fetched_at: float) -> None:
        try:
            store.write_eligibility(key, merge_authz.encode_snapshot(snapshot), fetched_at)
        except StoreError:
            logger.error("cannot store the eligibility snapshot of %s", key, exc_info=True)

    return keep


def eligibility_cache(
    store: StateStore, entry: RepoEntry, ttl_seconds: float
) -> SnapshotCache[Github, MergeRulesSnapshot]:
    """``entry``'s cache, starting from the snapshot ``store`` keeps and keeping each fresh one there: TTL
    ``ttl_seconds``, stale for at most three TTLs."""
    key = EligibilityKey(entry.repo, entry.eligibility, entry.minimum_role)
    label, fetch = eligibility_resolver(entry)
    return SnapshotCache(
        fetch,
        label=label,
        ttl_seconds=ttl_seconds,
        max_stale_seconds=_ELIGIBILITY_MAX_STALE_TTLS * ttl_seconds,
        cached=_stored_snapshot(store, key),
        on_fetch=_keep_snapshot(store, key),
    )


def eligibility_thunk(
    config: Config, entry: RepoEntry, store: StateStore, token: str, *, meter: RequestMeter | None = None
) -> Callable[[], MergeRulesSnapshot]:
    """``entry``'s eligibility snapshot through its cache on ``store``, read with ``token`` when due."""
    build_client = eligibility_client(entry, token, meter=meter)
    return lambda: eligibility_cache(store, entry, config.merge_rules_ttl_seconds).snapshot(build_client)


def drain_error(report: drain.DrainReport) -> str | None:
    """The scan error a drain slice reports, or None when it failed on no PR."""
    if not report.failed:
        return None
    return f"the drain failed on {len(report.failed)} PR(s): {list(report.failed)}"


def _raise(repo: str, errors: list[str]) -> NoReturn:
    raise RuntimeError(f"{repo}: " + "; ".join(errors))


def _raise_any(repo: str, errors: list[str]) -> None:
    if errors:
        _raise(repo, errors)


def scan_repo(
    config: Config,
    *,
    repo: str,
    store: StateStore,
    keep_memory: bool,
    pr: int | None = None,
    bot_login: str = "",
    build_github: BuildClient = github_client.build_client,
    run_review: RunFn = review.run,
    run_drain: Callable[..., drain.DrainReport] = drain.drain,
    clock: Callable[[], float] = time.time,
    **review_kwargs: Unpack[ScanOptions],
) -> None:
    """Scan ``repo`` once as its config says.

    ``keep_memory`` is False for ``--pr``, which neither loads nor saves the repo's memory; ``review_kwargs``
    go to ``review.run``.
    """
    token = config.github_token
    if not token:
        raise ValueError("PYTORCH_GREENLIGHT_GITHUB_TOKEN is required to query GitHub")
    item = store.read_repo(repo)
    memory = decode_memory(item.memory, repo) if keep_memory else None
    try:
        _scan(
            config,
            repo=repo,
            token=token,
            store=store,
            item=item,
            memory=memory,
            pr=pr,
            bot_login=bot_login,
            build_github=build_github,
            run_review=run_review,
            run_drain=run_drain,
            clock=clock,
            **review_kwargs,
        )
    finally:
        if memory is not None:
            save_memory(store, repo, memory, owner=None, now=clock(), tick=None)


def _settings(client: Github, store: StateStore, item: RepoItem, *, now: float) -> Settings:
    """``item``'s repo's settings through the config cache on ``store``, the updated record stored."""
    repo = item.repo
    record, unreadable = config_cache.revalidate(item.config, client, repo, now=now)
    decision = config_cache.decide(
        repo, record, unreadable=unreadable, reachable=True, drain_complete=item.drain_complete
    )
    if decision.record != item.config:
        store.write_config(repo, decision.record)
    return decision.settings


def _scan(
    config: Config,
    *,
    repo: str,
    token: str,
    store: StateStore,
    item: RepoItem,
    memory: ScanMemory | None,
    pr: int | None,
    bot_login: str,
    build_github: BuildClient,
    run_review: RunFn,
    run_drain: Callable[..., drain.DrainReport],
    clock: Callable[[], float],
    **review_kwargs: Unpack[ScanOptions],
) -> None:
    dispatch_token = config.dispatch_or_scan_token
    client = build_github(token)
    try:
        identity = fetch_identity(client, repo)
        if (hidden := visibility_problem(identity)) is not None:
            _raise(repo, [f"refused for this scan: {hidden}"])
        settings = _settings(client, store, item, now=clock())
        if settings.entry is None:
            if settings.problem is None:
                raise RuntimeError(f"{repo} has no GreenLight config at {REPO_CONFIG_PATH}")
            _raise(repo, [settings.problem])
        entry = settings.entry
        errors: list[str] = [] if settings.problem is None else [settings.problem]
        try:
            check_identity(entry, identity)
        except RepoUnavailable as exc:
            errors.append(f"refused for this scan: {exc}")
            _raise(repo, errors)
    finally:
        github_client.close_client(client)
    work = repo_work(entry, served=settings.served)
    if memory is not None and work.kind != "drain":
        memory.clear_drain()
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
    elif work.kind == "none":
        logger.warning("%s: a safety-only gate entry has no safety work yet; nothing runs for it", repo)
    else:
        run_review(
            config,
            entry=entry,
            optional=work.optional,
            pr=pr,
            bot_login=bot_login,
            build_github=build_github,
            resolve_merge_rules=eligibility_thunk(config, entry, store, token),
            memory=memory,
            dispatch_token=dispatch_token,
            **review_kwargs,
        )
    _raise_any(repo, errors)
