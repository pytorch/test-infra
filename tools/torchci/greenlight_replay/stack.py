"""A ghstack pull request's context, read back to the replayed verdict's cutoff.

The cutoff is the one the comment filter in :mod:`.inputs` uses. By replay time the pull
requests above a landed one have usually closed and ghstack has rewritten the listing,
so every input but the titles is read back to it:

* **The body** is the newest ``userContentEdits`` revision edited at or before the
  cutoff. It is read for every ghstack pull request under every policy, bar a declined
  diff and a control arm whose ``gh pr view`` failed, and replaces today's body in the
  metadata, so a control arm and the stack arm see one body.
* **The stack context** the workflow's step writes, reproduced across
  :mod:`.stack_step` and this module, is rebuilt only under a policy that runs the
  step. A sibling counts if it existed and was open at the cutoff, its head is its
  newest commit dated at or before it, and its diff compares that head with the final
  ``baseRefOid``, which is exact because a ghstack base only gains commits. SHAs rather
  than branch names, because pytorch deletes ``gh/*`` branches 30 days after a pull
  request closes.

**Where CI degrades, this raises.** The step is ``continue-on-error``. Here every fault
but its own two exits -- not a ghstack pull request, or not in its own listing --
removes whatever was written and raises, so the row lands in ``sweep.errors`` instead of
passing for a pull request CI reviewed without a stack.

:mod:`.inputs` imports this module, so its helpers are imported here at the call.
"""

from __future__ import annotations

import json
import logging
import shutil
from collections.abc import Hashable, Iterable, Mapping
from datetime import datetime
from pathlib import Path
from typing import Any, TypeVar

from torchci.greenlight_decisions.loc import _REPO_PATTERN
from torchci.greenlight_decisions.rows import to_utc_naive
from torchci.greenlight_replay.stack_step import (
    cap_diff,
    CI_STACK_DIR,
    GHSTACK_HEAD,
    listed_above,
    STACK_DIRNAME,
    STACK_FILENAME,
)


__all__ = ["STACK_DIRNAME", "STACK_FILENAME", "clear_stack", "read_back"]

logger = logging.getLogger(__name__)

COMMITS_READ = 100

_PULL_QUERY = """
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      title headRefName createdAt body
      userContentEdits(first: 100, after: $cursor) {
        nodes { editedAt deletedAt diff }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
"""

# filteredCount, not totalCount: totalCount ignores both itemTypes and since, and since
# counts only events strictly after it. Checked live 2026-09-26 on pytorch/pytorch
# #198722 (a force-push) and #195748 (a retarget).
_SIBLING_FIELDS = (
    "title createdAt closedAt headRefName baseRefOid "
    f"commits(last: {COMMITS_READ}) "
    "{ totalCount nodes { commit { oid committedDate } } } "
    "timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT, BASE_REF_CHANGED_EVENT, "
    "BASE_REF_FORCE_PUSHED_EVENT], since: $since) { filteredCount }"
)

_Value = TypeVar("_Value", bound=Hashable)


def clear_stack(run_dir: Path) -> None:
    """Remove both stack paths from ``run_dir``; neither needs to exist.

    One of three guarded deletions, with ``policy._clear_destination`` and
    ``workspace._clear_policy_half``. Like them it refuses a symlink: nothing here makes
    one, so one means something else has been writing to the run directory.
    """
    json_path, directory = run_dir / STACK_FILENAME, run_dir / STACK_DIRNAME
    for path in (json_path, directory):
        if path.is_symlink():
            raise ValueError(f"refusing to remove {path}: it is a symlink")
    json_path.unlink(missing_ok=True)
    if directory.exists():
        shutil.rmtree(directory)


def read_back(
    repo: str,
    pr_number: int,
    cutoff: datetime,
    run_dir: Path,
    *,
    head_ref: str | None,
    write_stack: bool,
) -> tuple[str | None, Path | None]:
    """``repo#pr_number``'s body as of ``cutoff``, and its stack context if asked for.

    Returns the body for a ghstack pull request, else None, and the stack JSON's path,
    or None unless ``write_stack`` and the step would have written one. ``head_ref`` is
    the head branch when the caller already has it: a non-ghstack one costs no call,
    and None costs one only when ``write_stack`` needs the answer. A naive ``cutoff`` is
    read as UTC; ``run_dir`` must hold neither stack path yet.
    """
    if not _REPO_PATTERN.fullmatch(repo):
        raise ValueError(f"refusing to read the ghstack context of repo {repo!r}")
    if head_ref is None and not write_stack:
        return None, None
    if head_ref is not None and GHSTACK_HEAD.fullmatch(head_ref) is None:
        return None, None
    try:
        return _read_back(repo, pr_number, to_utc_naive(cutoff), run_dir, write_stack)
    except BaseException:
        clear_stack(run_dir)
        raise


def _read_back(
    repo: str, pr_number: int, cutoff: datetime, run_dir: Path, write_stack: bool
) -> tuple[str | None, Path | None]:
    pull = _pull_page(repo, pr_number, cursor=None)
    head = GHSTACK_HEAD.fullmatch(pull["headRefName"])
    if head is None:
        logger.info("%s#%s is not a ghstack PR; no stack context", repo, pr_number)
        return None, None
    body = _body_at(pull, _edits(repo, pr_number, pull), cutoff)
    if not write_stack:
        return body, None
    above = listed_above(body, pr_number)
    if above is None:
        logger.info("%s#%s is not listed; no stack context", repo, pr_number)
        return body, None
    user = head.group(1)
    return body, _write_stack(repo, pr_number, cutoff, run_dir, user, pull, above)


def _write_stack(
    repo: str,
    pr_number: int,
    cutoff: datetime,
    run_dir: Path,
    user: str,
    pull: dict[str, Any],
    above: list[str],
) -> Path:
    from torchci.greenlight_replay.inputs import _fetch_diff

    siblings = _siblings(repo, above, cutoff) if above else {}
    directory = run_dir / STACK_DIRNAME
    directory.mkdir()
    entries: list[dict[str, Any]] = []
    for number in above:
        sibling = siblings[number]
        if not _open_ghstack_pr_of(user, sibling, cutoff):
            logger.info("skipping #%s: no open ghstack PR of %s then", number, user)
            continue
        head_sha = _head_at(number, sibling, cutoff)
        diff = _fetch_diff(repo, sibling["baseRefOid"], head_sha)
        (directory / f"{number}.diff").write_bytes(cap_diff(diff))
        path = f"{CI_STACK_DIR}/{number}.diff"
        entries.append(
            dict(number=int(number), title=sibling["title"], this=False, diff=path)
        )
    entries.append(dict(number=pr_number, title=pull["title"], this=True))

    # Written last, as the step writes it, and in jq's default rendering.
    stack_path = run_dir / STACK_FILENAME
    stack_path.write_text(
        json.dumps({"stack": entries}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    logger.info("wrote %s (PRs: %d)", stack_path, len(entries))
    return stack_path


def _pull_page(repo: str, pr_number: int, cursor: str | None) -> dict[str, Any]:
    variables = _repo_variables(repo, number=pr_number)
    if cursor is not None:
        variables["cursor"] = cursor
    return _graphql(_PULL_QUERY, variables)["repository"]["pullRequest"]


def _edits(
    repo: str, pr_number: int, first_page: dict[str, Any]
) -> list[dict[str, Any]]:
    """Every body revision, paged by cursor rather than ``gh --paginate``."""
    edits: list[dict[str, Any]] = []
    page, cursor = first_page, None
    while True:
        connection = page["userContentEdits"]
        edits += connection["nodes"]
        if not connection["pageInfo"]["hasNextPage"]:
            return edits
        following = connection["pageInfo"]["endCursor"]
        # A missing or repeated cursor would fetch the same page forever.
        if not isinstance(following, str) or following == cursor:
            raise RuntimeError(f"{repo}#{pr_number} edits stopped at {following!r}")
        cursor = following
        page = _pull_page(repo, pr_number, cursor)


def _body_at(
    pull: dict[str, Any], edits: list[dict[str, Any]], cutoff: datetime
) -> str:
    """The newest body revision edited at or before ``cutoff``.

    Node order is not trusted and duplicate nodes collapse. Two different revisions in
    the same second -- ghstack and pytorch-bot racing to edit a new pull request --
    leave the body at the cutoff unknowable, so that raises too.
    """
    if not edits:
        # No history means the body was never edited.
        if _instant(pull["createdAt"]) > cutoff:
            raise ValueError("the pull request was opened after the cutoff")
        body = pull["body"]
        if not isinstance(body, str):
            raise ValueError(f"the pull request body is {body!r}, not text")
        return body
    dated = ((_instant(e["editedAt"]), (e["deletedAt"], e["diff"])) for e in edits)
    found = _newest_at_or_before(cutoff, dated)
    if found is None:
        raise ValueError("no revision of the body was edited at or before the cutoff")
    edited_at, revisions = found
    if len(revisions) > 1:
        raise ValueError(f"{len(revisions)} body revisions at {edited_at}: ambiguous")
    deleted_at, text = revisions.pop()
    if deleted_at is not None:
        raise ValueError(f"the revision of the body edited at {edited_at} was deleted")
    # A live revision with no text is an emptied body, as on pytorch/pytorch#196788.
    return "" if text is None else text


def _siblings(
    repo: str, numbers: list[str], cutoff: datetime
) -> dict[str, dict[str, Any]]:
    """One aliased query for every pull request listed above."""
    # Numbers passed the listing row's [1-9][0-9]*, so none can carry query syntax.
    aliased = " ".join(
        f"pr{number}: pullRequest(number: {int(number)}) {{{_SIBLING_FIELDS}}}"
        for number in numbers
    )
    query = (
        "query($owner: String!, $name: String!, $since: DateTime!) "
        f"{{ repository(owner: $owner, name: $name) {{ {aliased} }} }}"
    )
    variables = _repo_variables(repo, since=f"{cutoff.isoformat()}Z")
    repository = _graphql(query, variables)["repository"]
    return {number: repository[f"pr{number}"] for number in numbers}


def _open_ghstack_pr_of(user: str, sibling: dict[str, Any], cutoff: datetime) -> bool:
    """The step's sibling filter, with open at the cutoff standing in for ``OPEN``."""
    head = GHSTACK_HEAD.fullmatch(sibling["headRefName"])
    closed_at = sibling["closedAt"]
    return (
        head is not None
        and head.group(1) == user
        and _instant(sibling["createdAt"]) <= cutoff
        and (closed_at is None or _instant(closed_at) > cutoff)
    )


def _head_at(number: str, sibling: dict[str, Any], cutoff: datetime) -> str:
    """The sibling's newest commit dated at or before ``cutoff``.

    A force-push of its head after the cutoff can drop the commits that stood then, and
    a retarget or a force-push of its base moves the base the diff is taken against, so
    any of them raises.
    """
    if sibling["timelineItems"]["filteredCount"]:
        raise ValueError(f"#{number}'s head or base was rewritten after the cutoff")
    commits = sibling["commits"]
    if commits["totalCount"] > COMMITS_READ:
        raise ValueError(f"#{number} has {commits['totalCount']} commits, too many")
    nodes = [node["commit"] for node in commits["nodes"]]
    dated = ((_instant(commit["committedDate"]), commit["oid"]) for commit in nodes)
    found = _newest_at_or_before(cutoff, dated)
    if found is None:
        raise ValueError(f"#{number} has no commit dated at or before the cutoff")
    committed_at, heads = found
    if len(heads) > 1:
        raise ValueError(f"#{number}: ambiguous head, {len(heads)} at {committed_at}")
    return heads.pop()


def _newest_at_or_before(
    cutoff: datetime, dated: Iterable[tuple[datetime, _Value]]
) -> tuple[datetime, set[_Value]] | None:
    """The latest time at or before ``cutoff`` and every distinct value dated then."""
    earlier = [(when, value) for when, value in dated if when <= cutoff]
    if not earlier:
        return None
    newest = max(when for when, _ in earlier)
    return newest, {value for when, value in earlier if when == newest}


def _instant(value: Any) -> datetime:
    """A GitHub timestamp as naive UTC, the form the harness compares cutoffs in."""
    from torchci.greenlight_replay.inputs import _normalize_utc_suffix

    if not isinstance(value, str):
        raise ValueError(f"expected a GitHub timestamp, got {value!r}")
    return to_utc_naive(datetime.fromisoformat(_normalize_utc_suffix(value)))


def _repo_variables(repo: str, **more: str | int) -> dict[str, str | int]:
    owner, name = repo.split("/")
    return {"owner": owner, "name": name, **more}


def _graphql(query: str, variables: Mapping[str, str | int]) -> dict[str, Any]:
    """One query through ``inputs._run``.

    ``gh api graphql`` exits non-zero whenever the response carries ``errors``, and a
    number that is not a pull request is one, so that fails here: checked live
    2026-09-26.
    """
    from torchci.greenlight_replay.inputs import _run

    argv = ["gh", "api", "graphql", "-f", f"query={query}"]
    for key, value in variables.items():
        # -F types an int; for a string it would also read "@<path>" as a file.
        argv += ["-F" if isinstance(value, int) else "-f", f"{key}={value}"]
    completed = _run(argv)
    if completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", "replace").strip()[:400]
        raise RuntimeError(f"gh api graphql exited {completed.returncode}: {stderr}")
    document = json.loads(completed.stdout)
    data = document.get("data") if isinstance(document, dict) else None
    if not isinstance(data, dict) or document.get("errors"):
        raise RuntimeError(f"gh api graphql returned no usable data: {document!r:.400}")
    return data
