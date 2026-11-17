"""``greenlight target``: validate the reviewer workflow's dispatch inputs and name what it needs.

The reviewer workflow (``greenlight-pr-review.yml``) and the manual recheck (``greenlight-review.yml``)
run this before a dispatch input reaches any token scope, path, URL or prompt, and use only what it
prints. An empty ``--repo`` is the primary repo; any other value must be, exactly, the name of an entry
of the local ``repos.yaml`` (served or safety-only), and never a spelling of the primary: the
workflow's concurrency group for the primary is chosen by an empty input, and GitHub compares group
names case-insensitively, so a ``PyTorch/PyTorch`` run would join and cancel the primary's.

On success it prints ``key=value`` lines for ``$GITHUB_OUTPUT``; on any failure it prints nothing to
stdout and exits non-zero. Logging is never configured here, since the service's handler writes to
stdout, which the workflow appends to its step outputs.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from greenlight import repo_config
from greenlight.constants import TARGET_REPO, validate_head_sha
from greenlight.exit_codes import EXIT_FAILURE, EXIT_OK

if TYPE_CHECKING:
    import argparse

    from greenlight.repo_config import RepoConfig

PRIMARY_CHECKOUT = "pytorch"
OTHER_CHECKOUT = "target"
POLICY_DIR = ".claude/skills/greenlight-review/repos"

_PR_RE = re.compile(r"[123456789][0123456789]*")


@dataclass(frozen=True)
class Target:
    repo: str
    name: str
    pr: str
    head_sha: str
    checkout: str
    policy: str
    policy_present: bool
    drci_poke: bool

    def outputs(self) -> str:
        """The ``key=value`` lines the workflow appends to ``$GITHUB_OUTPUT``."""
        values = {
            "repo": self.repo,
            "name": self.name,
            "pr": self.pr,
            "head_sha": self.head_sha,
            "checkout": self.checkout,
            "policy": self.policy,
            "policy_present": _flag(self.policy_present),
            "drci_poke": _flag(self.drci_poke),
        }
        return "".join(f"{key}={value}\n" for key, value in values.items())


def _flag(value: bool) -> str:
    return "true" if value else "false"


def checkout_dirname(repo: str) -> str:
    """The directory the reviewed repo is checked out into, relative to the workspace."""
    return PRIMARY_CHECKOUT if repo == TARGET_REPO else OTHER_CHECKOUT


def policy_path(repo: str) -> str:
    """The review policy file of ``repo`` (``pytorch/<name>``), relative to the test-infra root."""
    return f"{POLICY_DIR}/{repo.partition('/')[2]}.md"


def _default_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _canonical_repo(repo: str) -> str:
    if not repo:
        return TARGET_REPO
    if repo.lower() == TARGET_REPO.lower():
        raise ValueError(f"repo {repo!r} names {TARGET_REPO}, which is reached only through an empty repo")
    return repo


def resolve(repo: str, pr: str, head_sha: str, *, config: RepoConfig, root: Path) -> Target:
    """The validated target of one review; ``ValueError`` when any input is not acceptable."""
    canonical = _canonical_repo(repo)
    found = config.lookup(canonical)
    if found is None:
        raise ValueError(f"repo {canonical!r} is not a served or safety-only entry of greenlight/repos.yaml")
    name = canonical.partition("/")[2]
    if name in ("", ".", ".."):
        raise ValueError(f"repo {canonical!r} has no usable name")
    if not _PR_RE.fullmatch(pr):
        raise ValueError(f"pr must be a positive decimal number without leading zeros, got {pr!r}")
    if head_sha:
        validate_head_sha(head_sha)
    entry, served = found
    policy = policy_path(canonical)
    return Target(
        repo=canonical,
        name=name,
        pr=pr,
        head_sha=head_sha,
        checkout=checkout_dirname(canonical),
        policy=policy,
        policy_present=(root / policy).is_file(),
        drci_poke=served and entry.status_comment == "drci" and entry.mode == "active",
    )


def add_parser(subparsers: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    parser = subparsers.add_parser(
        "target",
        help="validate a review's repo, PR and head SHA and print the reviewer workflow's step outputs",
        description=(
            "Validate the reviewer workflow's dispatch inputs against greenlight/repos.yaml in this checkout "
            f"and print key=value lines for $GITHUB_OUTPUT. An empty --repo means {TARGET_REPO}; any other "
            "value must exactly name a served or safety-only entry other than that one."
        ),
    )
    parser.add_argument("--repo", default="", help=f"owner/name of the configured repo (empty for {TARGET_REPO})")
    parser.add_argument("--pr", required=True, help="pull-request number")
    parser.add_argument("--head-sha", default="", help="head commit SHA the review is pinned to")


def run(args: argparse.Namespace, *, config: RepoConfig | None = None, root: Path | None = None) -> int:
    try:
        target = resolve(
            args.repo,
            args.pr,
            args.head_sha,
            config=repo_config.load_local() if config is None else config,
            root=_default_root() if root is None else root,
        )
    except ValueError as exc:
        sys.stderr.write(f"greenlight target: {exc}\n")
        return EXIT_FAILURE
    sys.stdout.write(target.outputs())
    return EXIT_OK
