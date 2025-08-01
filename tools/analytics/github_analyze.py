#!/usr/bin/env python3

# mypy: disable-error-code="union-attr, call-arg, call-overload, var-annotated, return-value, import-untyped"

import enum
import json
import os
import re
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Union
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class IssueState(enum.Enum):
    OPEN = "open"
    CLOSED = "closed"
    ALL = "all"

    def __str__(self):
        return self.value


class GitCommit:
    commit_hash: str
    title: str
    body: str
    author: str
    author_date: datetime
    commit_date: Optional[datetime]
    pr_url: str

    def __init__(
        self,
        commit_hash: str,
        author: str,
        author_date: datetime,
        title: str,
        body: str,
        pr_url: str,
        commit_date: Optional[datetime] = None,
    ) -> None:
        self.commit_hash = commit_hash
        self.author = author
        self.author_date = author_date
        self.commit_date = commit_date
        self.title = title
        self.body = body
        self.pr_url = pr_url

    def __contains__(self, item: Any) -> bool:
        return item in self.body or item in self.title

    def is_issue_mentioned(self, issue_url: str) -> bool:
        if issue_url in self:
            return True
        if "/pull/" in issue_url:
            return False
        issue_hash = f"#{issue_url.split('issues/')[1]}"
        if "fixes" in self.title.lower() and issue_hash in self.title:
            return True
        return any(
            "fixes" in line.lower() and issue_hash in line
            for line in self.body.split("\n")
        )


def get_revert_revision(commit: GitCommit) -> Optional[str]:
    import re

    body_rc = re.search("Original Phabricator Diff: (D\\d+)", commit.body)

    if commit.title.startswith('Back out "') and body_rc is not None:
        return body_rc.group(1)

    rc = re.match("Revert (D\\d+):", commit.title)
    if rc is None:
        return None
    return rc.group(1)


def get_diff_revision(commit: GitCommit) -> Optional[str]:
    import re

    rc = re.search("\\s*Differential Revision: (D\\d+)", commit.body)
    if rc is None:
        return None
    return rc.group(1)


def get_ghf_revert_revision(commit: GitCommit) -> Optional[str]:
    import re

    rc = re.search("\\s*This reverts commit ([0-9a-f]+).", commit.body)
    if all(
        [
            commit.title.startswith("Revert"),
            commit.author
            == "PyTorch MergeBot <pytorchmergebot@users.noreply.github.com>",
            rc is not None,
        ]
    ):
        return rc.group(1)
    return None


def is_revert(commit: GitCommit) -> bool:
    return (
        get_revert_revision(commit) is not None
        or get_ghf_revert_revision(commit) is not None
    )


def parse_medium_format(lines: Union[str, List[str]]) -> GitCommit:
    """
    Expect commit message generated using `--format=medium --date=unix` format, i.e.:
        commit <sha1>
        Author: <author>
        Date:   <author date>

        <title line>

        <full commit message>

    """
    if isinstance(lines, str):
        lines = lines.split("\n")
    # TODO: Handle merge commits correctly
    if len(lines) > 1 and lines[1].startswith("Merge:"):
        del lines[1]
    assert len(lines) > 5
    assert lines[0].startswith("commit")
    assert lines[1].startswith("Author: ")
    assert lines[2].startswith("Date: ")
    assert len(lines[3]) == 0
    return GitCommit(
        commit_hash=lines[0].split()[1].strip(),
        author=lines[1].split(":", 1)[1].strip(),
        author_date=datetime.fromtimestamp(int(lines[2].split(":", 1)[1].strip())),
        title=lines[4].strip(),
        body="\n".join(lines[5:]),
    )


def parse_fuller_format(lines: Union[str, List[str]]) -> GitCommit:
    """
    Expect commit message generated using `--format=fuller --date=unix` format, i.e.:
        commit <sha1>
        Author:     <author>
        AuthorDate: <author date>
        Commit:     <committer>
        CommitDate: <committer date>

        <title line>

        <full commit message>

    """
    if isinstance(lines, str):
        lines = lines.split("\n")
    # TODO: Handle merge commits correctly
    if len(lines) > 1 and lines[1].startswith("Merge:"):
        del lines[1]
    assert len(lines) > 7
    assert lines[0].startswith("commit")
    assert lines[1].startswith("Author: ")
    assert lines[2].startswith("AuthorDate: ")
    assert lines[3].startswith("Commit: ")
    assert lines[4].startswith("CommitDate: ")
    assert len(lines[5]) == 0

    prUrl = ""
    for line in lines:
        if "Pull Request resolved:" in line:
            prUrl = line.split("Pull Request resolved:")[1].strip()
            break

    return GitCommit(
        commit_hash=lines[0].split()[1].strip(),
        author=lines[1].split(":", 1)[1].strip(),
        author_date=datetime.fromtimestamp(int(lines[2].split(":", 1)[1].strip())),
        commit_date=datetime.fromtimestamp(int(lines[4].split(":", 1)[1].strip())),
        title=lines[6].strip(),
        body="\n".join(lines[7:]),
        pr_url=prUrl,
    )


def _check_output(items: List[str], encoding="utf-8") -> str:
    from subprocess import check_output

    return check_output(items).decode(encoding)


def get_git_remotes(path: str) -> Dict[str, str]:
    keys = _check_output(["git", "-C", path, "remote"]).strip().split("\n")
    return {
        key: _check_output(["git", "-C", path, "remote", "get-url", key]).strip()
        for key in keys
    }


class GitRepo:
    def __init__(self, path, remote="upstream"):
        self.repo_dir = path
        self.remote = remote

    def _run_git_cmd(self, *args) -> str:
        return _check_output(["git", "-C", self.repo_dir] + list(args))

    def _run_git_log(self, revision_range, additional_args=[]) -> List[GitCommit]:
        log = self._run_git_cmd(
            "log",
            "--format=fuller",
            "--date=unix",
            revision_range,
            *additional_args,
            "--",
            ".",
            *additional_args,
        ).split("\n")
        rc: List[GitCommit] = []
        cur_msg: List[str] = []
        for line in log:
            if line.startswith("commit"):
                if len(cur_msg) > 0:
                    rc.append(parse_fuller_format(cur_msg))
                    cur_msg = []
            cur_msg.append(line)
        if len(cur_msg) > 0:
            rc.append(parse_fuller_format(cur_msg))
        return rc

    def get_commit_list(self, from_ref, to_ref) -> List[GitCommit]:
        return self._run_git_log(f"{self.remote}/{from_ref}..{self.remote}/{to_ref}")

    def get_ghstack_orig_branches(self) -> List[str]:
        return [
            x.strip()
            for x in self._run_git_cmd(
                "branch", "--remotes", "--list", self.remote + "/gh/*/orig"
            )
            .strip()
            .split("\n")
        ]

    def show_ref(self, ref) -> str:
        return self._run_git_cmd("show-ref", ref).split(" ")[0]

    def merge_base(self, ref1, ref2) -> str:
        return self._run_git_cmd("merge-base", ref1, ref2).strip()

    def rev_list(self, ref):
        return (
            self._run_git_cmd("rev-list", f"{self.remote}/main..{ref}").strip().split()
        )


def build_commit_dict(commits: List[GitCommit]) -> Dict[str, GitCommit]:
    rc = {}
    for commit in commits:
        assert commit.commit_hash not in rc
        rc[commit.commit_hash] = commit
    return rc


def fetch_json(
    url: str, params: Optional[Dict[str, Any]] = None
) -> List[Dict[str, Any]]:
    headers = {"Accept": "application/vnd.github.v3+json"}
    token = os.environ.get("GITHUB_TOKEN")
    if token is not None and url.startswith("https://api.github.com/"):
        headers["Authorization"] = f"token {token}"
    if params is not None and len(params) > 0:
        url += "?" + "&".join(f"{name}={val}" for name, val in params.items())
    try:
        with urlopen(Request(url, headers=headers)) as data:
            return json.load(data)
    except HTTPError as err:
        if err.code == 403 and all(
            key in err.headers for key in ["X-RateLimit-Limit", "X-RateLimit-Used"]
        ):
            print(
                f"Rate limit exceeded: {err.headers['X-RateLimit-Used']}/{err.headers['X-RateLimit-Limit']}"
            )
        raise


def fetch_multipage_json(
    url: str, params: Optional[Dict[str, Any]] = None
) -> List[Dict[str, Any]]:
    if params is None:
        params = {}
    assert "page" not in params
    page_idx, rc, prev_len, params = 1, [], -1, params.copy()
    while len(rc) > prev_len:
        prev_len = len(rc)
        params["page"] = page_idx
        page_idx += 1
        rc += fetch_json(url, params)
    return rc


def gh_get_milestones(
    org="pytorch", project="pytorch", state: IssueState = IssueState.OPEN
) -> List[Dict[str, Any]]:
    url = f"https://api.github.com/repos/{org}/{project}/milestones"
    return fetch_multipage_json(url, {"state": state})


def gh_get_milestone_issues(
    org: str, project: str, milestone_idx: int, state: IssueState = IssueState.OPEN
):
    url = f"https://api.github.com/repos/{org}/{project}/issues"
    return fetch_multipage_json(url, {"milestone": milestone_idx, "state": state})


def gh_get_ref_statuses(org: str, project: str, ref: str) -> Dict[str, Any]:
    url = f"https://api.github.com/repos/{org}/{project}/commits/{ref}/status"
    params = {"page": 1, "per_page": 100}
    nrc = rc = fetch_json(url, params)
    while "statuses" in nrc and len(nrc["statuses"]) == 100:
        params["page"] += 1
        nrc = fetch_json(url, params)
        if "statuses" in nrc:
            rc["statuses"] += nrc["statuses"]
    return rc


def get_issue_comments(org: str, project: str, issue_number: int):
    url = f"https://api.github.com/repos/{org}/{project}/issues/{issue_number}/comments"

    return fetch_multipage_json(url)


def extract_statuses_map(json: Dict[str, Any]):
    return {s["context"]: s["state"] for s in json["statuses"]}


class PeriodStats:
    commits: int
    reverts: int
    authors: int
    date: datetime

    def __init__(
        self, date: datetime, commits: int, reverts: int, authors: int
    ) -> None:
        self.date = date
        self.commits = commits
        self.reverts = reverts
        self.authors = authors


def get_monthly_stats(commits: List[GitCommit]) -> Iterable[PeriodStats]:
    y, m, total, reverts, authors = None, None, 0, 0, set()
    for commit in commits:
        commit_date = (
            commit.commit_date if commit.commit_date is not None else commit.author_date
        )
        if y != commit_date.year or m != commit_date.month:
            if y is not None:
                yield PeriodStats(datetime(y, m, 1), total, reverts, len(authors))
            y, m, total, reverts, authors = (
                commit_date.year,
                commit_date.month,
                0,
                0,
                set(),
            )
        if is_revert(commit):
            reverts += 1
        total += 1
        authors.add(commit.author)


def print_monthly_stats(commits: List[GitCommit]) -> None:
    stats = list(get_monthly_stats(commits))
    for idx, stat in enumerate(stats):
        y = stat.date.year
        m = stat.date.month
        total, reverts, authors = stat.commits, stat.reverts, stat.authors
        reverts_ratio = 100.0 * reverts / total
        if idx + 1 < len(stats):
            commits_growth = 100.0 * (stat.commits / stats[idx + 1].commits - 1)
        else:
            commits_growth = float("nan")
        print(
            f"{y}-{m:02d}: commits {total} ({commits_growth:+.1f}%)  reverts {reverts} ({reverts_ratio:.1f}%) authors {authors}"
        )


def print_reverts(commits: List[GitCommit]) -> None:
    for commit in commits:
        if not is_revert(commit):
            continue
        print(f"{commit.commit_date} {commit.title} {commit.commit_hash} {commit.body}")


def analyze_reverts(commits: List[GitCommit]):
    for idx, commit in enumerate(commits):
        revert_id = get_revert_revision(commit)
        if revert_id is None:
            continue
        orig_commit = None
        for i in range(1, 100):
            orig_commit = commits[idx + i]
            if get_diff_revision(orig_commit) == revert_id:
                break
        if orig_commit is None:
            print(f"Failed to find original commit for {commit.title}")
            continue
        print(
            f"{commit.commit_hash} is a revert of {orig_commit.commit_hash}: {orig_commit.title}"
        )
        revert_statuses = gh_get_ref_statuses("pytorch", "pytorch", commit.commit_hash)
        orig_statuses = gh_get_ref_statuses(
            "pytorch", "pytorch", orig_commit.commit_hash
        )
        orig_sm = extract_statuses_map(orig_statuses)
        revert_sm = extract_statuses_map(revert_statuses)
        for k in revert_sm.keys():
            if k not in orig_sm:
                continue
            if orig_sm[k] != revert_sm[k]:
                print(f"{k} {orig_sm[k]}->{revert_sm[k]}")


def print_contributor_stats(commits, delta: Optional[timedelta] = None) -> None:
    authors: Dict[str, int] = {}
    now = datetime.now()
    # Default delta is one non-leap year
    if delta is None:
        delta = timedelta(days=365)
    for commit in commits:
        date, author = commit.commit_date, commit.author
        if now - date > delta:
            break
        if author not in authors:
            authors[author] = 0
        authors[author] += 1

    print(
        f"{len(authors)} contributors made {sum(authors.values())} commits in last {delta.days} days"
    )
    for count, author in sorted(
        ((commit, author) for author, commit in authors.items()), reverse=True
    ):
        print(f"{author}: {count}")


def commits_missing_in_branch(
    repo: GitRepo, branch: str, orig_branch: str, milestone_idx: int
) -> None:
    def get_commits_dict(x, y):
        return build_commit_dict(repo.get_commit_list(x, y))

    main_commits = get_commits_dict(orig_branch, "main")
    release_commits = get_commits_dict(orig_branch, branch)
    print(f"len(main_commits)={len(main_commits)}")
    print(f"len(release_commits)={len(release_commits)}")
    print("URL;Title;Status")
    for issue in gh_get_milestone_issues(
        "pytorch", "pytorch", milestone_idx, IssueState.ALL
    ):
        issue_url, state = issue["html_url"], issue["state"]
        # Skip closed states if they were landed before merge date
        if state == "closed":
            mentioned_after_cut = any(
                commit.is_issue_mentioned(issue_url) for commit in main_commits.values()
            )
            # If issue is not mentioned after cut, that it must be present in release branch
            if not mentioned_after_cut:
                continue
            mentioned_in_release = any(
                commit.is_issue_mentioned(issue_url)
                for commit in release_commits.values()
            )
            # if Issue is mentioned is release branch, than it was picked already
            if mentioned_in_release:
                continue
        print(f'{issue_url};{issue["title"]};{state}')


def commits_missing_in_release(
    repo: GitRepo,
    branch: str,
    orig_branch: str,
    minor_release: str,
    milestone_idx: int,
    cut_off_date: datetime,
    issue_num: int,
) -> None:
    def get_commits_dict(x, y):
        return build_commit_dict(repo.get_commit_list(x, y))

    main_commits = get_commits_dict(minor_release, "main")
    prev_release_commits = get_commits_dict(orig_branch, branch)
    current_issue_comments = get_issue_comments(
        "pytorch", "pytorch", issue_num
    )  # issue comments for the release tracker as cherry picks
    print(f"len(main_commits)={len(main_commits)}")
    print(f"len(prev_release_commits)={len(prev_release_commits)}")
    print(f"len(current_issue_comments)={len(current_issue_comments)}")
    print(f"issue_num: {issue_num}, len(issue_comments)={len(current_issue_comments)}")
    print("URL;Title;Status")

    # Iterate over the previous release branch to find potentially missing cherry picks in the current issue.
    for commit in prev_release_commits.values():
        not_cherry_picked_in_current_issue = any(
            commit.pr_url not in issue_comment["body"]
            for issue_comment in current_issue_comments
        )
        for main_commit in main_commits.values():
            if main_commit.pr_url == commit.pr_url:
                mentioned_after_cut_off_date = cut_off_date < main_commit.commit_date
                if not_cherry_picked_in_current_issue and mentioned_after_cut_off_date:
                    # Commits that are release only, which exist in previous release branch and not in main.
                    print(f"{commit.pr_url};{commit.title};{commit.commit_date}")
                break


def analyze_stacks(repo: GitRepo) -> None:
    from tqdm.contrib.concurrent import thread_map

    branches = repo.get_ghstack_orig_branches()
    stacks_by_author: Dict[str, List[int]] = {}
    for branch, rv_commits in thread_map(
        lambda x: (x, repo.rev_list(x)), branches, max_workers=10
    ):
        author = branch.split("/")[2]
        if author not in stacks_by_author:
            stacks_by_author[author] = []
        stacks_by_author[author].append(len(rv_commits))
    for author, slen in sorted(
        stacks_by_author.items(), key=lambda x: len(x[1]), reverse=True
    ):
        if len(slen) == 1:
            print(f"{author} has 1 stack of depth {slen[0]}")
            continue
        print(
            f"{author} has {len(slen)} stacks max depth is {max(slen)} avg depth is {sum(slen)/len(slen):.2f} mean is {slen[len(slen)//2]}"
        )


def extract_commit_hash_from_revert(text):
    """
    Extract commit hash from a revert commit message.

    Args:
        text (str): The revert commit message

    Returns:
        str or None: The extracted commit hash, or None if not found
    """
    # Pattern to match "This reverts commit <hash>."
    pattern = r"This reverts commit ([0-9a-f]+)\."

    match = re.search(pattern, text)
    if match:
        return match.group(1)
    return None


def analyze_reverts_missing_from_branch(repo: GitRepo, branch: str) -> None:
    """
    Analyze reverts applied to main branch but not applied to specified branch.
    This identifies potential missing revert commits that may need to be cherry-picked
    to the release branch. Also detects if reverted commits from main were cherry-picked
    to the branch.
    """
    # Get commits from main that are not in the specified branch
    main_only_commits = build_commit_dict(repo.get_commit_list(branch, "main"))

    # Get commits from the specified branch that are not in main
    branch_only_commits = build_commit_dict(repo.get_commit_list("main", branch))
    branch_only_reverts = set()

    print(f"Analyzing reverts in main branch not present in {branch} branch")
    print(f"Total commits in main but not in {branch}: {len(main_only_commits)}")
    print(f"Total commits in {branch} but not in main: {len(branch_only_commits)}")
    print()

    for commit_hash, commit in branch_only_commits.items():
        revert_hash = extract_commit_hash_from_revert(commit.body)
        if revert_hash != None:
            branch_only_reverts.add(revert_hash)
        if is_revert(commit):
            branch_only_reverts.add(commit_hash)

    # Find reverts in main that are not in the specified branch
    reverts_missing_from_branch = []

    for commit_hash, commit in main_only_commits.items():
        if is_revert(commit):
            reverts_missing_from_branch.append(commit)

    if not reverts_missing_from_branch:
        print(f"No reverts found in main branch that are missing from {branch} branch.")
        return

    print(
        f"Found {len(reverts_missing_from_branch)} revert(s) in main branch not present in {branch} branch:"
    )
    print("=" * 80)

    for commit in reverts_missing_from_branch:
        # Try to identify what was reverted
        revert_revision = get_revert_revision(commit)
        ghf_revert_revision = get_ghf_revert_revision(commit)

        reverted_commit_hash = None
        if revert_revision:
            print(f"Reverted Phabricator Diff: {revert_revision}")
        elif ghf_revert_revision:
            print(f"Reverted GitHub Commit: {ghf_revert_revision}")
            reverted_commit_hash = ghf_revert_revision

        # Check if the reverted commit was cherry-picked to the branch
        cherry_picked_to_branch = False
        if reverted_commit_hash:
            if reverted_commit_hash in branch_only_reverts:
                cherry_picked_to_branch = True
                print(
                    f"✅  DETECTED: The reverted commit {reverted_commit_hash} was cherry-picked to {branch}"
                )

        print(f"Commit Hash: {commit.commit_hash}")
        print(f"Author: {commit.author}")
        print(f"Date: {commit.commit_date or commit.author_date}")
        print(f"Title: {commit.title}")
        if commit.pr_url:
            print(f"PR URL: {commit.pr_url}")

        if not cherry_picked_to_branch:
            print(
                f"⚠️ STATUS: The reverted commit does not appear to be in {branch}, so this revert may not be needed."
            )

        print(
            f"Body Preview: {commit.body[:200]}{'...' if len(commit.body) > 200 else ''}"
        )
        print("-" * 80)


def parse_arguments():
    from argparse import ArgumentParser

    parser = ArgumentParser(description="Print GitHub repo stats")
    parser.add_argument(
        "--repo-path",
        type=str,
        help="Path to PyTorch git checkout",
        default=os.path.expanduser("~/git/pytorch/pytorch"),
    )
    parser.add_argument("--milestone-id", type=str)
    parser.add_argument("--branch", type=str)
    parser.add_argument("--minor-release", type=str)
    parser.add_argument("--remote", type=str, help="Remote to base off of", default="")
    parser.add_argument("--analyze-reverts", action="store_true")
    parser.add_argument("--print-reverts", action="store_true")
    parser.add_argument("--contributor-stats", action="store_true")
    parser.add_argument("--missing-in-branch", action="store_true")
    parser.add_argument("--missing-in-release", action="store_true")
    parser.add_argument("--analyze-stacks", action="store_true")
    parser.add_argument(
        "--analyze-missing-reverts-from-branch",
        action="store_true",
        help="Analyze reverts applied to main branch but not applied to specified branch",
    )
    parser.add_argument("--date", type=lambda d: datetime.strptime(d, "%Y-%m-%d"))
    parser.add_argument("--issue-num", type=int)
    return parser.parse_args()


def main():
    import time

    args = parse_arguments()
    remote = args.remote
    if not remote:
        remotes = get_git_remotes(args.repo_path)
        # Pick best remote
        remote = next(iter(remotes.keys()))
        for key in remotes:
            if remotes[key].endswith("github.com/pytorch/pytorch"):
                remote = key

    repo = GitRepo(args.repo_path, remote)

    if args.analyze_stacks:
        analyze_stacks(repo)
        return

    if args.analyze_missing_reverts_from_branch:
        if not args.branch:
            print(
                "Error: --branch argument is required for --analyze-missing-reverts-from-branch"
            )
            return
        analyze_reverts_missing_from_branch(repo, args.branch)
        return

    # Use milestone idx or search it along milestone titles
    try:
        milestone_idx = int(args.milestone_id)
    except ValueError:
        milestone_idx = -1
        milestones = gh_get_milestones()
        for milestone in milestones:
            if milestone.get("title", "") == args.milestone_id:
                milestone_idx = int(milestone.get("number", "-2"))
        if milestone_idx < 0:
            print(f"Could not find milestone {args.milestone_id}")
            return

    if args.missing_in_branch:
        commits_missing_in_branch(
            repo, args.branch, f"orig/{args.branch}", milestone_idx
        )
        return

    if args.missing_in_release:
        commits_missing_in_release(
            repo,
            args.branch,
            f"orig/{args.branch}",
            args.minor_release,
            milestone_idx,
            args.date,
            args.issue_num,
        )
        return

    print(f"Parsing git history with remote {remote}...", end="", flush=True)
    start_time = time.time()
    x = repo._run_git_log(f"{remote}/main")
    print(f"done in {time.time()-start_time:.1f} sec")
    if args.analyze_reverts:
        analyze_reverts(x)
    elif args.contributor_stats:
        print_contributor_stats(x)
    elif args.print_reverts:
        print_reverts(x[: 2**9])
    else:
        print_monthly_stats(x)


if __name__ == "__main__":
    main()
