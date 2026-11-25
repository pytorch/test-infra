"""``greenlight target``: validate the reviewer workflow's dispatch inputs and name what it needs.

The reviewer workflow (``greenlight-pr-review.yml``) runs this before a dispatch input reaches any
token scope, path, URL or prompt, and uses only what it prints. Two modes:

- ``--strict`` checks the shapes offline: an empty ``--repo`` is the primary repo; any other value must
  be ``pytorch/<name>`` and never a spelling of the primary (the workflow's concurrency group for the
  primary is chosen by an empty input, and GitHub compares group names case-insensitively, so a
  ``PyTorch/PyTorch`` run would join and cancel the primary's). For any repo but the primary it then
  reads, with the job's read-only token (``GITHUB_TOKEN`` or ``GH_TOKEN``), what GitHub reports for the
  repo and its ``.github/greenlight/config.yml``: the repo must pass the scan's live checks
  (``repo_scan.identity_problem``) and its settings must give a served or safety-only entry. The
  primary makes no read: its ``drci_poke`` comes from ``BUILTIN_PYTORCH``.
- ``--from-review`` takes the repo and ``drci_poke`` the review job's strict run exported and checks them
  again with no read, the repo against the dispatch's own ``repo`` input (``--input-repo``): the record
  job uses it on the path that can dismiss an approval, so no network failure stands between the review
  and the verdict's dismissal.

Both modes require the head SHA.

On success it prints ``key=value`` lines for ``$GITHUB_OUTPUT``; on any failure it prints nothing to
stdout and exits non-zero. Logging is never configured here, since the service's handler writes to
stdout, which the workflow appends to its step outputs.
"""

from __future__ import annotations

import os
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING

from greenlight import github_client, repo_config, repo_scan
from greenlight.constants import TARGET_REPO, validate_head_sha
from greenlight.exit_codes import EXIT_FAILURE, EXIT_OK

if TYPE_CHECKING:
    import argparse

    from github import Github

    from greenlight.repo_config import RepoEntry

PRIMARY_CHECKOUT = "pytorch"
OTHER_CHECKOUT = "target"
REPO_NAME_RE = re.compile(r"pytorch/[A-Za-z0-9._-]+")
TOKEN_VARIABLES = ("GITHUB_TOKEN", "GH_TOKEN")

_PR_RE = re.compile(r"[123456789][0123456789]*")
_FLAGS = {"true": True, "false": False}

BuildClient = Callable[[], "Github"]


@dataclass(frozen=True)
class Target:
    repo: str
    name: str
    pr: str
    head_sha: str
    checkout: str
    drci_poke: bool

    def outputs(self) -> str:
        """The ``key=value`` lines the workflow appends to ``$GITHUB_OUTPUT``."""
        values = {
            "repo": self.repo,
            "name": self.name,
            "pr": self.pr,
            "head_sha": self.head_sha,
            "checkout": self.checkout,
            "drci_poke": "true" if self.drci_poke else "false",
        }
        return "".join(f"{key}={value}\n" for key, value in values.items())


def checkout_dirname(repo: str) -> str:
    """The directory the reviewed repo is checked out into, relative to the workspace."""
    return PRIMARY_CHECKOUT if repo == TARGET_REPO else OTHER_CHECKOUT


def is_repo_name(repo: str) -> bool:
    """Whether ``repo`` is ``pytorch/<name>`` (``REPO_NAME_RE``) with a name other than ``.`` or ``..``."""
    return REPO_NAME_RE.fullmatch(repo) is not None and repo.partition("/")[2] not in (".", "..")


def _require_repo(repo: str) -> str:
    """``repo``, canonical and of the expected shape: ``pytorch/<name>``, the primary only exactly."""
    if not is_repo_name(repo):
        raise ValueError(f"repo {repo!r} is not pytorch/<name>")
    if repo != TARGET_REPO and repo.lower() == TARGET_REPO.lower():
        raise ValueError(f"repo {repo!r} is a different spelling of {TARGET_REPO}")
    return repo


def _input_repo(repo: str) -> str:
    """The canonical repo a dispatch's ``repo`` input names: empty is the primary, which nothing else names."""
    if not repo:
        return TARGET_REPO
    if repo == TARGET_REPO:
        raise ValueError(f"repo {repo!r} is reached only through an empty repo")
    return _require_repo(repo)


def _require_pr_and_head(pr: str, head_sha: str) -> None:
    if not _PR_RE.fullmatch(pr):
        raise ValueError(f"pr must be a positive decimal number without leading zeros, got {pr!r}")
    validate_head_sha(head_sha)


def drci_poke(entry: RepoEntry, *, served: bool) -> bool:
    """Whether Dr. CI renders the repo's status from the rows: a served, active ``status_comment: drci`` entry."""
    return served and entry.status_comment == "drci" and entry.mode == "active"


def live_entry(client: Github, repo: str) -> tuple[RepoEntry, bool]:
    """The entry of a non-primary ``repo`` and whether it is served, after the scan's live checks."""
    identity = repo_scan.fetch_identity(client, repo)
    if (problem := repo_scan.visibility_problem(identity)) is not None:
        raise ValueError(f"repo {repo!r} cannot be reviewed: {problem}")
    settings = repo_config.read_settings(client, repo)
    if settings.entry is None or settings.kind == "unreadable":
        why = settings.problem or "no GreenLight config"
        raise ValueError(f"repo {repo!r} is neither served nor safety-only ({why})")
    if (problem := repo_scan.identity_problem(settings.entry, identity)) is not None:
        raise ValueError(f"repo {repo!r} cannot be reviewed: {problem}")
    return settings.entry, settings.served


def _client_from_env() -> Github:
    token = next((value for name in TOKEN_VARIABLES if (value := os.environ.get(name, ""))), "")
    if not token:
        raise ValueError(f"reading another repo's settings needs one of {list(TOKEN_VARIABLES)}")
    return github_client.build_authz_client(token)


def strict(repo: str, pr: str, head_sha: str, *, build_client: BuildClient = _client_from_env) -> Target:
    """The validated target of a dispatch; ``ValueError`` (or GitHub's error) when it is not acceptable."""
    canonical = _input_repo(repo)
    _require_pr_and_head(pr, head_sha)
    if repo_config.is_primary(canonical):
        entry, served = repo_config.BUILTIN_PYTORCH, True
    else:
        client = build_client()
        try:
            entry, served = live_entry(client, canonical)
        finally:
            github_client.close_client(client)
    return Target(
        repo=canonical,
        name=canonical.partition("/")[2],
        pr=pr,
        head_sha=head_sha,
        checkout=checkout_dirname(canonical),
        drci_poke=drci_poke(entry, served=served),
    )


def from_review(input_repo: str, repo: str, poke: str, pr: str, head_sha: str) -> Target:
    """The target the review job exported, re-checked offline against the dispatch's own ``repo`` input."""
    expected = _input_repo(input_repo)
    if _require_repo(repo) != expected:
        raise ValueError(f"the review's repo {repo!r} is not the dispatch's {expected!r}")
    if poke not in _FLAGS:
        raise ValueError(f"drci_poke must be true or false, got {poke!r}")
    _require_pr_and_head(pr, head_sha)
    return Target(repo, repo.partition("/")[2], pr, head_sha, checkout_dirname(repo), _FLAGS[poke])


def add_parser(subparsers: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    parser = subparsers.add_parser(
        "target",
        help="validate a review's repo, PR and head SHA and print the reviewer workflow's step outputs",
        description=(
            "Validate the reviewer workflow's dispatch inputs and print key=value lines for $GITHUB_OUTPUT. "
            f"--strict: an empty --repo means {TARGET_REPO}; any other value must be another pytorch/<name> "
            "whose GreenLight config gives a served or safety-only entry and that passes the scan's live "
            "checks (read with GITHUB_TOKEN or GH_TOKEN). --from-review: re-check, with no read, the --repo and "
            "--drci-poke a strict run exported, the repo against the dispatch's --input-repo."
        ),
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--strict", action="store_true", help="validate the dispatch inputs, reading GitHub")
    mode.add_argument("--from-review", action="store_true", help="re-check the review job's outputs offline")
    parser.add_argument(
        "--repo", default="", help=f"--strict: the dispatch's repo input (empty for {TARGET_REPO}); else the review's"
    )
    parser.add_argument("--input-repo", default="", help="--from-review: the dispatch's repo input")
    parser.add_argument("--pr", required=True, help="pull-request number")
    parser.add_argument("--head-sha", required=True, help="head commit SHA the review is pinned to")
    parser.add_argument("--drci-poke", default="", help="--from-review: the drci_poke the review exported")


def run(args: argparse.Namespace, *, build_client: BuildClient = _client_from_env) -> int:
    try:
        if args.from_review:
            target = from_review(args.input_repo, args.repo, args.drci_poke, args.pr, args.head_sha)
        else:
            target = strict(args.repo, args.pr, args.head_sha, build_client=build_client)
    except Exception as exc:
        sys.stderr.write(f"greenlight target: {type(exc).__name__}: {exc}\n")
        return EXIT_FAILURE
    sys.stdout.write(target.outputs())
    return EXIT_OK
