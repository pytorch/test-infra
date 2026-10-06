#!/usr/bin/env python3
"""Sync CRCR backend levels in pytorch/pytorch's allowlist with HUD.

HUD's /api/crcr/level-status says which backends should change level, by the
same criteria /crcr shows. This opens a pytorchbot PR that edits
.github/allowlist.yml and pings its oncalls, and it closes that PR again if the
backend recovers before the PR is merged. Merging is left to a human.
"""

import os
import re
import sys
import time
from dataclasses import dataclass
from typing import Any, Optional

import requests
import yaml
from github import Auth, Github, GithubException
from github.PullRequest import PullRequest
from github.Repository import Repository
from torchci.utils import get_hud_headers


UPSTREAM_REPO = "pytorch/pytorch"
BASE_BRANCH = "main"
ALLOWLIST_PATH = ".github/allowlist.yml"
HUD_URL = "https://hud.pytorch.org"
WORKFLOW_URL = (
    "https://github.com/pytorch/test-infra/blob/main/"
    ".github/workflows/crcr-sync-level.yml"
)
# The demotion PR of `org/repo` is on this branch, under this label.
BRANCH_PREFIX = "crcr-demotion/"
DEMOTION_LABEL = "crcr-auto-demotion"
EXTRA_LABELS = ["topic: not user facing"]
# Mentioned on every demotion PR, besides the repo's oncalls.
ALWAYS_CC = ["atalman"]


# ---- Allowlist editing ----
#
# This edits the text rather than dumping the parsed YAML again, so the PR's
# diff is just the moved entry. The result is parsed back and rejected unless
# it is exactly the intended change.


class AllowlistEditError(Exception):
    pass


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _is_content(line: str) -> bool:
    """Neither blank nor a comment."""
    stripped = line.strip()
    return bool(stripped) and not stripped.startswith("#")


def _section(lines: list[str], name: str) -> tuple[int, int]:
    """(header, end) line indexes of a top-level key and its block, which must
    be in block style."""
    headers = [i for i, line in enumerate(lines) if re.match(rf"{name}\s*:", line)]
    if len(headers) != 1:
        raise AllowlistEditError(f"expected one top-level {name} key")
    header = headers[0]
    if not re.match(rf"{name}\s*:\s*(#.*)?$", lines[header].rstrip("\n")):
        raise AllowlistEditError(f"{name} must be in block style")
    end = next(
        (
            i
            for i in range(header + 1, len(lines))
            if _is_content(lines[i]) and _indent(lines[i]) == 0
        ),
        len(lines),
    )
    return header, end


def _key_line(lines: list[str], start: int, end: int, key: str) -> int:
    """Index of the one line in [start, end) that opens the mapping key `key`,
    quoted or not."""
    pattern = rf"""\s+(["']?){re.escape(key)}\1\s*:(\s|$)"""
    found = [i for i in range(start, end) if re.match(pattern, lines[i])]
    if len(found) != 1:
        raise AllowlistEditError(f"expected one line for {key!r}, found {len(found)}")
    return found[0]


def _block_end(lines: list[str], start: int, end: int) -> int:
    """End (exclusive) of the entry that opens at lines[start]: the lines after
    it indented deeper than it, without trailing blank lines."""
    last = start
    for i in range(start + 1, end):
        if not lines[i].strip():
            continue
        if _indent(lines[i]) <= _indent(lines[start]):
            break
        last = i
    return last + 1


def _comments_above(lines: list[str], index: int, stop: int) -> int:
    """Start of the comment lines directly above lines[index] (and below
    lines[stop]) at its indentation -- the ones describing it."""
    start = index
    while (
        start - 1 > stop
        and lines[start - 1].strip().startswith("#")
        and _indent(lines[start - 1]) == _indent(lines[index])
    ):
        start -= 1
    return start


def _cut(lines: list[str], start: int, end: int) -> None:
    """Delete lines[start:end], and a blank line it would leave doubled."""
    del lines[start:end]
    if (
        0 < start < len(lines)
        and not lines[start - 1].strip()
        and not lines[start].strip()
    ):
        del lines[start]


def _without_empty_sections(data: dict) -> dict:
    # An emptied section parses back as None rather than {} or [].
    return {key: value for key, value in data.items() if value not in (None, {}, [])}


def _repo_name(key: Any) -> str:
    return str(key).strip().strip("/")


def demote_in_allowlist(text: str, repo: str) -> str:
    """Move `repo` from L3 to the end of L2 as a bare name: L2 entries have no
    oncalls or device."""
    data = yaml.safe_load(text) or {}
    found = [
        (device, key)
        for device, repos in (data.get("L3") or {}).items()
        for key in repos or {}
        if _repo_name(key) == repo
    ]
    if not found:
        raise AllowlistEditError(f"{repo} is not at L3")
    device, key = found[0]
    lines = text.splitlines(keepends=True)

    # Cut the entry, and any comment directly above it, out of L3. If nothing
    # else is left in its device group, the group goes too.
    l3, l3_end = _section(lines, "L3")
    group = _key_line(lines, l3 + 1, l3_end, device)
    group_end = _block_end(lines, group, l3_end)
    entry = _key_line(lines, group + 1, group_end, key)
    entry_start = _comments_above(lines, entry, group)
    entry_end = _block_end(lines, entry, group_end)
    comments = lines[entry_start:entry]
    if any(
        _is_content(lines[i])
        for i in range(group + 1, group_end)
        if not entry_start <= i < entry_end
    ):
        _cut(lines, entry_start, entry_end)
    else:
        _cut(lines, _comments_above(lines, group, l3), group_end)

    # Append it as the last L2 item, at the indentation the other items use,
    # with the comment that described it.
    l2, l2_end = _section(lines, "L2")
    dashes = [
        i
        for i in range(l2 + 1, l2_end)
        if _is_content(lines[i]) and re.match(r"\s*-(\s|$)", lines[i])
    ]
    item_indent = min((_indent(lines[i]) for i in dashes), default=2)
    items = [i for i in dashes if _indent(lines[i]) == item_indent]
    insert_at = _block_end(lines, items[-1], l2_end) if items else l2 + 1
    pad = " " * item_indent
    lines[insert_at:insert_at] = [pad + c.lstrip(" ") for c in comments] + [
        f"{pad}- {repo}\n"
    ]
    new_text = "".join(lines)

    # `data` is no longer needed as parsed: turn it into what the file should say.
    del data["L3"][device][key]
    if not data["L3"][device]:
        del data["L3"][device]
    data["L2"] = (data.get("L2") or []) + [repo]
    if _without_empty_sections(yaml.safe_load(new_text) or {}) != (
        _without_empty_sections(data)
    ):
        raise AllowlistEditError(f"moving {repo} changed more than its entry")
    return new_text


def _oncalls(metadata: Any) -> list[str]:
    raw = metadata.get("oncalls") if isinstance(metadata, dict) else metadata
    if isinstance(raw, str):
        return [oncall.strip() for oncall in raw.split(",") if oncall.strip()]
    if isinstance(raw, list):
        return [str(oncall).strip() for oncall in raw if str(oncall).strip()]
    return []


def l3_repos(data: dict) -> dict[str, list[str]]:
    """Every L3 repo in a parsed allowlist, with its oncalls."""
    return {
        _repo_name(key): _oncalls(metadata)
        for repos in (data.get("L3") or {}).values()
        for key, metadata in (repos or {}).items()
    }


# ---- Deciding what to do ----


@dataclass(frozen=True)
class DemotionPR:
    number: int
    conflicted: bool  # conflicts with main


@dataclass(frozen=True)
class Action:
    kind: str  # "open", "refresh" (rebuild a conflicted PR) or "close"
    repo: str
    reason: str = ""  # why a PR is closed


def repo_from_branch(ref: str) -> Optional[str]:
    """The repo a PR demotes, from its head branch, or None if the branch is not
    a demotion branch."""
    if not ref.startswith(BRANCH_PREFIX):
        return None
    repo = ref[len(BRANCH_PREFIX) :]
    owner, _, name = repo.partition("/")
    return repo if owner and name and "/" not in name else None


def plan(
    statuses: dict[str, dict],
    l3: dict[str, list[str]],
    open_prs: dict[str, DemotionPR],
) -> list[Action]:
    """The PRs to open, to refresh (an open one that conflicts with main) and to
    close. A repo HUD has no verdict for is left alone."""
    actions = []
    for repo in sorted(open_prs):
        if repo not in l3:
            reason = f"is no longer at L3 on `{BASE_BRANCH}`"
            actions.append(Action("close", repo, reason))
        elif repo in statuses and statuses[repo]["change"] != "demote":
            reason = "is back within its L3 targets"
            actions.append(Action("close", repo, reason))
    for repo in sorted(l3):
        status = statuses.get(repo)
        if not status or status["change"] != "demote":
            continue
        if repo not in open_prs:
            actions.append(Action("open", repo))
        elif open_prs[repo].conflicted:
            actions.append(Action("refresh", repo))
    return actions


def pr_title(repo: str) -> str:
    return f"[CRCR] Demote {repo} from L3 to L2"


def pr_body(repo: str, status: dict, oncalls: list[str]) -> str:
    hud_link = f"[`{repo}`]({HUD_URL}/crcr/{repo})"
    rows = "\n".join(
        f"| {c['criterion']} | {c['measured']} | {c['target']} |"
        for c in status["criteria"]
        if c["met"] is False
    )
    finding = (
        f"Over the last {status['windowDays']} days, {hud_link} missed these L3 "
        "targets:\n\n"
        "| Criterion | Measured | L3 target |\n| --- | --- | --- |\n"
        f"{rows}"
    )
    cc = "cc " + " ".join(f"@{name}" for name in [*oncalls, *ALWAYS_CC])
    if not oncalls:
        cc = f"No oncalls are listed for this repo in the allowlist.\n\n{cc}"
    return f"""{finding}

This moves it from L3 to L2 in `{ALLOWLIST_PATH}`. L2 entries have no oncalls or
device, so both are dropped.

{cc}

- If it gets back within its L3 targets before this is merged, this PR is closed automatically.
- Closing this PR does not cancel the demotion: a new one is opened while the repo misses its L3 targets.
- To discuss, comment here. To demote the repo, merge it.

---
Opened by the [CRCR sync level workflow]({WORKFLOW_URL}).
"""


# ---- GitHub ----
#
# `upstream` is the PyGithub Repository of pytorch/pytorch; `repo` is the
# backend a PR demotes.


def _conflicted(pull: PullRequest) -> bool:
    """Whether the PR conflicts with its base. GitHub works this out lazily, so
    ask again a few times if it does not know yet."""
    for _ in range(3):
        if pull.mergeable is not None:
            return not pull.mergeable
        time.sleep(2)
        pull.update()
    return pull.mergeable is False


def open_demotion_prs(upstream: Repository, bot: str) -> dict[str, DemotionPR]:
    """The bot's open demotion PRs, found by their label: {repo: PR}."""
    prs = {}
    for issue in upstream.get_issues(state="open", labels=[DEMOTION_LABEL]):
        if issue.pull_request is None or issue.user.login != bot:
            continue
        pull = issue.as_pull_request()
        repo = repo_from_branch(pull.head.ref)
        if repo is not None:
            prs[repo] = DemotionPR(issue.number, _conflicted(pull))
    return prs


def open_pr(
    upstream: Repository,
    repo: str,
    text: str,
    blob_sha: str,
    base_sha: str,
    body: str,
) -> PullRequest:
    branch = BRANCH_PREFIX + repo
    title = pr_title(repo)
    try:
        upstream.create_git_ref(f"refs/heads/{branch}", base_sha)
    except GithubException as e:
        if e.status != 422:
            raise
        # Left over from an earlier demotion PR, or the branch of one that now
        # conflicts with main: start it again from main's latest.
        upstream.get_git_ref(f"heads/{branch}").edit(base_sha, force=True)
    upstream.update_file(ALLOWLIST_PATH, title, text, blob_sha, branch=branch)
    try:
        pr = upstream.create_pull(base=BASE_BRANCH, head=branch, title=title, body=body)
    except GithubException:
        # Already open: a conflicted PR being refreshed, or one an earlier run
        # failed to label.
        owner = UPSTREAM_REPO.split("/")[0]
        existing = list(upstream.get_pulls(state="open", head=f"{owner}:{branch}"))
        if not existing:
            raise
        pr = existing[0]
    pr.add_to_labels(DEMOTION_LABEL, *EXTRA_LABELS)
    return pr


def close_pr(upstream: Repository, number: int, repo: str, reason: str) -> None:
    pull = upstream.get_pull(number)
    pull.create_issue_comment(
        f"`{repo}` {reason}, so this PR is no longer needed. Closing it."
    )
    pull.edit(state="closed")
    branch = BRANCH_PREFIX + repo
    try:
        upstream.get_git_ref(f"heads/{branch}").delete()
    except GithubException:
        print(f"{repo}: could not delete branch {branch}")


# ---- Main ----


def fetch_level_status() -> dict[str, dict]:
    """HUD's verdict for each repo it judges, by repo."""
    response = requests.get(
        f"{HUD_URL}/api/crcr/level-status", headers=get_hud_headers(), timeout=60
    )
    response.raise_for_status()
    return {status["repo"]: status for status in response.json()["repos"]}


def sync(upstream: Repository, bot: str, statuses: dict[str, dict]) -> bool:
    """Bring the demotion PRs in line with HUD. False if any action failed."""
    base_sha = upstream.get_branch(BASE_BRANCH).commit.sha
    allowlist = upstream.get_contents(ALLOWLIST_PATH, ref=base_sha)
    assert not isinstance(allowlist, list)
    text, blob_sha = allowlist.decoded_content.decode(), allowlist.sha
    l3 = l3_repos(yaml.safe_load(text) or {})
    open_prs = open_demotion_prs(upstream, bot)
    actions = plan(statuses, l3, open_prs)
    if not actions:
        print("Nothing to do")

    ok = True
    for action in actions:
        repo = action.repo
        try:
            if action.kind == "close":
                number = open_prs[repo].number
                print(f"Closing #{number}: {repo} {action.reason}")
                close_pr(upstream, number, repo, action.reason)
            else:
                refresh = action.kind == "refresh"
                print(f"{'Refreshing' if refresh else 'Opening'}: {pr_title(repo)}")
                new_text = demote_in_allowlist(text, repo)
                body = pr_body(repo, statuses[repo], l3[repo])
                pr = open_pr(upstream, repo, new_text, blob_sha, base_sha, body)
                print(f"{'Refreshed' if refresh else 'Opened'} {pr.html_url}")
        except (AllowlistEditError, GithubException, requests.RequestException) as e:
            print(f"Failed to {action.kind} the demotion PR for {repo}: {e}")
            ok = False
    return ok


def main() -> None:
    statuses = fetch_level_status()
    gh = Github(auth=Auth.Token(os.environ["GITHUB_TOKEN"]), timeout=30)
    upstream = gh.get_repo(UPSTREAM_REPO)
    if not sync(upstream, gh.get_user().login, statuses):
        sys.exit(1)


if __name__ == "__main__":
    main()
