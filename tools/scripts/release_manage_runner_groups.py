#!/usr/bin/env python3
"""Reconcile PyTorch release self-hosted runner groups.

Keeps the prod release runner groups (e.g. ``lf-prod-aws-ue1-release-runners``;
staging clusters are excluded) in sync with a desired state computed from
``pytorch/pytorch``:

- ensure ``pytorch/pytorch`` is an allowed repository (add-only), and
- restrict allowed workflows to the release workflows discovered in
  ``pytorch/pytorch``, pinned to ``main``, ``nightly`` and the release branches
  around the test-channel version (the ``release/X.Y`` anchor read from
  ``generate_binary_build_matrix.py`` plus the preceding protected release
  branch).

Release workflows are discovered, not hardcoded, by the release runner label
they run on (the ``rel-`` marker, e.g. ``rel-l-x86iavx512-44-340``). An entry
workflow references such a label directly; reusable workflows are then included
only when a release entry invokes them via ``uses:`` in a job that runs on a
release label - this pulls in the build reusable (``_binary-build-linux.yml``)
while leaving test/upload reusables (which run on other runners) out.

Reading and updating runner groups requires a token that can manage them.
Defaults to a dry-run; pass ``--apply`` to write changes.
"""

import argparse
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import requests  # type: ignore[import-untyped]
import yaml  # type: ignore[import-untyped]


GITHUB_API = "https://api.github.com"
API_VERSION = "2022-11-28"

ORG = "pytorch"
TARGET_REPO = "pytorch/pytorch"
WORKFLOWS_DIR = ".github/workflows"

# Only the prod release runner groups (e.g. lf-prod-aws-ue1-release-runners);
# staging and other clusters are intentionally excluded.
GROUP_NAME_RE = re.compile(r"-prod-.*-release-runners$")

# Number of most-recent protected release branches to keep pinned.
NUM_RELEASE_BRANCHES = 2

RELEASE_BRANCH_RE = re.compile(r"^release/(\d+)\.(\d+)$")

# Marker for a release runner label as it appears in a workflow's runs-on, e.g.
# rel-l-x86iavx512-44-340 or the mt-rel-... variant. A workflow that references
# such a label runs on the release runner groups.
RELEASE_LABEL_RE = re.compile(r"\brel-[a-z0-9]")


def log(message: str) -> None:
    print(message, flush=True)


class GitHubClient:
    def __init__(self, token: str) -> None:
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {token}",
                "X-GitHub-Api-Version": API_VERSION,
            }
        )

    def request(self, method: str, path: str, **kwargs: Any) -> "requests.Response":
        url = path if path.startswith("http") else f"{GITHUB_API}{path}"
        for attempt in range(5):
            resp = self.session.request(method, url, **kwargs)
            if resp.status_code in (429, 502, 503) and attempt < 4:
                retry_after = resp.headers.get("Retry-After", "")
                delay = int(retry_after) if retry_after.isdigit() else 2**attempt
                time.sleep(delay)
                continue
            break
        resp.raise_for_status()
        return resp

    def paginate(
        self, path: str, key: Optional[str] = None, **kwargs: Any
    ) -> List[Any]:
        params = dict(kwargs.pop("params", {}) or {})
        params.setdefault("per_page", 100)
        items: List[Any] = []
        url: Optional[str] = path
        while url:
            resp = self.request("GET", url, params=params, **kwargs)
            data = resp.json()
            items.extend(data[key] if key else data)
            next_link = resp.links.get("next")
            url = next_link["url"] if next_link else None
            params = {}  # the next link already carries the query string
        return items


# --- Desired state: target refs -------------------------------------------


def get_test_version_anchor() -> Tuple[int, int]:
    # The release runner groups serve the release-candidate builds, so anchor on
    # CURRENT_CANDIDATE_VERSION from generate_binary_build_matrix (the version
    # used for release builds, advanced deliberately at go-live) rather than
    # inferring it from a branch-name scan (which drifts: a release/X.Y branch is
    # cut weeks before it is the actual candidate).
    import generate_binary_build_matrix as gbm

    major, minor = gbm.CURRENT_CANDIDATE_VERSION.split(".")[:2]
    return int(major), int(minor)


def release_version(branch: str) -> Tuple[int, int]:
    match = RELEASE_BRANCH_RE.match(branch)
    return (int(match.group(1)), int(match.group(2)))  # type: ignore[union-attr]


def select_target_refs(
    branch_names: Iterable[str], anchor: Tuple[int, int]
) -> List[str]:
    """main, nightly, the test-version anchor release branch, and the preceding
    NUM_RELEASE_BRANCHES - 1 protected release branches below it (so the still
    patchable prior release keeps runner access)."""
    names = set(branch_names)
    selected = [fixed for fixed in ("main", "nightly") if fixed in names]
    preceding = [
        n for n in names if RELEASE_BRANCH_RE.match(n) and release_version(n) < anchor
    ]
    preceding.sort(key=release_version, reverse=True)
    releases = [f"release/{anchor[0]}.{anchor[1]}", *preceding]
    selected += releases[:NUM_RELEASE_BRANCHES]
    return [f"refs/heads/{name}" for name in selected]


def get_target_refs(client: GitHubClient) -> List[str]:
    anchor = get_test_version_anchor()
    log(f"Test-channel version anchor: release/{anchor[0]}.{anchor[1]}")
    branches = client.paginate(
        f"/repos/{TARGET_REPO}/branches", params={"protected": "true"}
    )
    return select_target_refs((branch["name"] for branch in branches), anchor)


# --- Desired state: workflow discovery -------------------------------------


def uses_release_label(text: str) -> bool:
    return RELEASE_LABEL_RE.search(text) is not None


@dataclass
class WorkflowFile:
    doc: Dict[str, Any]
    raw: str


WORKFLOW_TREE_QUERY = """
query($owner: String!, $name: String!, $expression: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $expression) {
      ... on Tree {
        entries {
          name
          type
          object {
            ... on Blob {
              text
            }
          }
        }
      }
    }
  }
}
"""


def fetch_workflow_files(client: GitHubClient) -> Dict[str, WorkflowFile]:
    # Fetch every workflow file's content in a single GraphQL request. Fetching
    # each file over its raw.githubusercontent.com download_url instead gets
    # rate-limited (HTTP 429) on repos with many workflows like pytorch/pytorch.
    owner, name = TARGET_REPO.split("/")
    resp = client.request(
        "POST",
        "/graphql",
        json={
            "query": WORKFLOW_TREE_QUERY,
            "variables": {
                "owner": owner,
                "name": name,
                "expression": f"main:{WORKFLOWS_DIR}",
            },
        },
    ).json()
    if resp.get("errors"):
        raise RuntimeError(f"GraphQL error fetching workflows: {resp['errors']}")
    tree = resp["data"]["repository"]["object"] or {}
    files: Dict[str, WorkflowFile] = {}
    for entry in tree.get("entries", []):
        if entry.get("type") != "blob":
            continue
        if not entry["name"].endswith((".yml", ".yaml")):
            continue
        raw = (entry.get("object") or {}).get("text")
        if not raw:
            continue
        try:
            doc = yaml.safe_load(raw)
        except yaml.YAMLError:
            continue
        if isinstance(doc, dict):
            files[f"{WORKFLOWS_DIR}/{entry['name']}"] = WorkflowFile(doc=doc, raw=raw)
    return files


def collect_release_workflow_paths(files: Dict[str, WorkflowFile]) -> Set[str]:
    """Discover the workflows that run on the release runner labels.

    Entry workflows reference a release label directly. From each, follow local
    ``uses:`` references, but only for jobs that themselves run on a release
    label, so the build reusable is included while sibling test/upload jobs
    (which run on other runners) are not.
    """
    entry_paths = {path for path, wf in files.items() if uses_release_label(wf.raw)}
    seen: Set[str] = set()
    queue = list(entry_paths)
    while queue:
        path = queue.pop()
        if path in seen:
            continue
        seen.add(path)
        wf = files.get(path)
        if wf is None:
            continue
        jobs = wf.doc.get("jobs")
        if not isinstance(jobs, dict):
            continue
        for job in jobs.values():
            if not isinstance(job, dict):
                continue
            uses = job.get("uses")
            if not (isinstance(uses, str) and uses.startswith("./")):
                continue
            if not uses_release_label(str(job)):
                continue
            local = uses.split("@", 1)[0][len("./") :]
            if local not in seen:
                queue.append(local)
    return seen


def discover_release_workflows(client: GitHubClient) -> Set[str]:
    files = fetch_workflow_files(client)
    paths = collect_release_workflow_paths(files)
    log(f"Discovered {len(paths)} release workflow(s) on {TARGET_REPO}@main:")
    for path in sorted(paths):
        log(f"  {path}")
    return paths


def build_desired_workflows(paths: Iterable[str], refs: Iterable[str]) -> Set[str]:
    refs = list(refs)
    return {f"{TARGET_REPO}/{path}@{ref}" for path in paths for ref in refs}


# --- Runner group reconciliation -------------------------------------------


def get_release_runner_groups(client: GitHubClient) -> List[Dict[str, Any]]:
    groups = client.paginate(f"/orgs/{ORG}/actions/runner-groups", key="runner_groups")
    return [g for g in groups if GROUP_NAME_RE.search(str(g["name"]))]


def get_repo_id(client: GitHubClient) -> int:
    return int(client.request("GET", f"/repos/{TARGET_REPO}").json()["id"])


def reconcile_workflows(
    client: GitHubClient,
    group: Dict[str, Any],
    desired: Set[str],
    apply: bool,
) -> bool:
    """Reconcile the group's allowed-workflows list. Returns True if it changed
    (or would change in a dry-run)."""
    if not desired:
        log("  workflows: refusing to apply an empty allow-list, skipping")
        return False
    current = set(group.get("selected_workflows") or [])
    if current == desired and group.get("restricted_to_workflows"):
        log(f"  workflows: up to date ({len(current)} entries)")
        return False
    to_add = sorted(desired - current)
    to_remove = sorted(current - desired)
    log(
        f"  workflows: {len(to_add)} to add, {len(to_remove)} to remove "
        f"({len(current)} -> {len(desired)} entries)"
    )
    for entry in to_add:
        log(f"    + {entry}")
    for entry in to_remove:
        log(f"    - {entry}")
    if apply:
        client.request(
            "PATCH",
            f"/orgs/{ORG}/actions/runner-groups/{group['id']}",
            json={
                "restricted_to_workflows": True,
                "selected_workflows": sorted(desired),
            },
        )
        log("  workflows: applied")
    return True


def reconcile_repo_access(
    client: GitHubClient,
    group: Dict[str, Any],
    repo_id: int,
    apply: bool,
) -> bool:
    """Ensure the target repo is allowed (add-only). Returns True if it changed
    (or would change in a dry-run)."""
    if group.get("visibility") != "selected":
        log(
            f"  repos: visibility={group.get('visibility')}, "
            "no per-repo restriction to update"
        )
        return False
    repos = client.paginate(
        f"/orgs/{ORG}/actions/runner-groups/{group['id']}/repositories",
        key="repositories",
    )
    if any(int(repo["id"]) == repo_id for repo in repos):
        log(f"  repos: {TARGET_REPO} already allowed ({len(repos)} repos)")
        return False
    log(f"  repos: + {TARGET_REPO} ({len(repos)} -> {len(repos) + 1} repos)")
    if apply:
        client.request(
            "PUT",
            f"/orgs/{ORG}/actions/runner-groups/{group['id']}/repositories/{repo_id}",
        )
        log("  repos: applied")
    return True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--token",
        type=str,
        default=os.getenv("RUNNER_GROUP_TOKEN") or os.getenv("GITHUB_TOKEN", ""),
        help="GitHub token for managing runner groups (or RUNNER_GROUP_TOKEN/GITHUB_TOKEN)",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply changes. Without it the script only prints the diff (dry-run)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.token:
        raise SystemExit(
            "A GitHub token is required (--token, RUNNER_GROUP_TOKEN or GITHUB_TOKEN)"
        )
    client = GitHubClient(args.token)

    refs = get_target_refs(client)
    log(f"Target refs: {refs}")
    paths = discover_release_workflows(client)
    desired = build_desired_workflows(paths, refs)
    log(f"Desired allow-list ({len(desired)} references):")
    for entry in sorted(desired):
        log(f"  {entry}")

    try:
        groups = get_release_runner_groups(client)
    except requests.HTTPError as error:
        status = error.response.status_code if error.response is not None else None
        if status == 403 and not args.apply:
            log("No access to runner groups; discovery-only run")
            return
        raise

    repo_id = get_repo_id(client)
    if not groups:
        log(f"No runner groups matching {GROUP_NAME_RE.pattern!r} found")
        return
    log(
        f"Found {len(groups)} release runner group(s): "
        f"{', '.join(sorted(g['name'] for g in groups))}"
    )

    changed_groups: List[str] = []
    for group in groups:
        log(
            f"Group {group['name']} (id={group['id']}, "
            f"visibility={group.get('visibility')}):"
        )
        wf_changed = reconcile_workflows(client, group, desired, args.apply)
        repo_changed = reconcile_repo_access(client, group, repo_id, args.apply)
        if wf_changed or repo_changed:
            changed_groups.append(group["name"])

    verb = "Updated" if args.apply else "Would update"
    if changed_groups:
        log(f"{verb} {len(changed_groups)} group(s): {', '.join(changed_groups)}")
    else:
        log("All release runner groups already up to date")
    if not args.apply:
        log("Dry-run complete; re-run with --apply to write changes")


if __name__ == "__main__":
    main()
