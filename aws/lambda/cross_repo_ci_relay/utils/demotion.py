"""Temporary demotion of an L3 repo while its demotion PR is open.

The sync level workflow (tools/torchci/crcr_sync_level.py) opens a PR that moves
an L3 repo to L2. While it is open the relay creates no new upstream check runs
for the repo, as if it were L2 already. Everything else carries on: PR events are
still dispatched to it, its results still reach HUD, and it is still stamped L3.
"""

import logging

from . import gh_helper, redis_helper
from .allowlist import AllowlistLevel, load_allowlist
from .config import RelayConfig


logger = logging.getLogger(__name__)

# The demotion PR of ``org/repo`` is on the branch ``crcr-demotion/org/repo``.
# Keep in sync with BRANCH_PREFIX in tools/torchci/crcr_sync_level.py.
DEMOTION_BRANCH_PREFIX = "crcr-demotion/"


def suppressed(
    config: RelayConfig,
    level: AllowlistLevel | None,
    repo: str,
    job_started_at: float | None = None,
) -> bool:
    """Whether new upstream check runs for ``repo`` are held back.

    A job that started (``job_started_at``) before the demotion still gets its
    check run finished, or the one already shown as in progress would hang.
    None means now: a job just starting, a label, a re-run request.
    """
    if level != AllowlistLevel.L3:
        return False
    since = redis_helper.get_demotion_since(config, repo)
    return since is not None and (job_started_at is None or job_started_at >= since)


def reconcile(config: RelayConfig) -> None:
    """Record which L3 repos have an open demotion PR, and forget the rest.

    The sweeper is the only caller, so a demotion starts and ends at the next
    sweep. A repo whose PRs cannot be listed is left as it is. After a merge the
    allowlist cache can still read L3 for up to ``allowlist_ttl_seconds``; that
    short window is accepted.
    """
    repos, _ = load_allowlist(config).get_level(AllowlistLevel.L3)
    if not repos:
        return
    token = gh_helper.get_repo_access_token(
        config.github_app_id, config.github_app_private_key, config.upstream_repo
    )
    # The demotion branches are in the upstream repo itself.
    head_owner = config.upstream_repo.split("/")[0]
    for repo in repos:
        try:
            demoted = gh_helper.has_open_pull(
                token=token,
                repo_full_name=config.upstream_repo,
                head=f"{head_owner}:{DEMOTION_BRANCH_PREFIX}{repo}",
            )
        except Exception:
            logger.exception("demotion reconcile: could not list the PRs of %s", repo)
            continue
        if demoted:
            redis_helper.set_demotion(config, repo)
        else:
            redis_helper.clear_demotion(config, repo)
