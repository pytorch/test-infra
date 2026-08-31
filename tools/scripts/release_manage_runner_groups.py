#!/usr/bin/env python3
"""Reconcile PyTorch release self-hosted runner groups.

Keeps the prod release runner groups (e.g. ``lf-prod-aws-ue1-release-runners``;
staging clusters are excluded) in sync with a desired state computed from
``pytorch/pytorch``:

- ensure ``pytorch/pytorch`` is an allowed repository (add-only), and
- restrict allowed workflows to the release workflows discovered in
  ``pytorch/pytorch``, pinned to ``main``, ``nightly``, the release branches
  around the test-channel version (the ``release/X.Y`` anchor read from
  ``generate_binary_build_matrix.py`` plus the preceding protected release
  branch), and each pinned line's release tags (its newest ``v<version>`` and
  ``v<version>-rc<n>``, which is where the release binaries are actually built
  from).

Release workflows are discovered, not hardcoded, by the release runner label
they run on (the ``rel-`` marker, e.g. ``rel-l-x86iavx512-44-340``). A job counts
as running on a release runner when it names such a label inline, or when it
takes its runner from a ``_select-release-runner.yml`` caller's outputs. An entry
workflow has such a job; reusable workflows are then included only when a release
entry invokes them via ``uses:`` from one - this pulls in the build reusables
(``_binary-build-linux.yml``, ``_build-triton-wheel-linux.yml``) while leaving
test/upload reusables (which run on other runners) out.

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
        try:
            resp.raise_for_status()
        except requests.HTTPError as error:
            # Surface the API response body; GitHub explains which field was
            # rejected there, and raise_for_status() would otherwise drop it.
            raise requests.HTTPError(
                f"{error} - body: {resp.text}", response=resp
            ) from error
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


def release_lines(refs: Iterable[str]) -> List[Tuple[int, int]]:
    """The ``(major, minor)`` release lines among the selected branch refs."""
    lines = []
    for ref in refs:
        match = RELEASE_BRANCH_RE.match(ref.removeprefix("refs/heads/"))
        if match is not None:
            lines.append((int(match.group(1)), int(match.group(2))))
    return lines


def release_tag_re(line: Tuple[int, int]) -> "re.Pattern[str]":
    """Matches the GA and release-candidate tags on release line ``X.Y``.

    pytorch/pytorch tags releases as ``v<version>``, with candidates numbered
    ``v<version>-rc<n>``: ``v2.13.0``, ``v2.13.0-rc15``, ``v2.13.1-rc1``.
    """
    return re.compile(rf"^v{line[0]}\.{line[1]}\.(\d+)(?:-rc(\d+))?$")


def select_target_tags(tag_names: Iterable[str], line: Tuple[int, int]) -> List[str]:
    """The newest GA tag and the newest release-candidate tag on line ``X.Y``.

    Release binaries are built from tags, not branches: pushing ``v2.14.0-rc1``
    runs the build workflows at ``refs/tags/v2.14.0-rc1``. GitHub matches
    ``selected_workflows`` entries on the exact ref, so the
    ``@refs/heads/release/2.14`` entry does not authorize that run and the tag
    has to be pinned in its own right.

    Newest wins by ``(patch, rc)``, so a patch release supersedes the line's
    previous tags (``v2.13.1-rc1`` over ``v2.13.0-rc15``). Only one of each is
    kept: a new tag supersedes the last, and pinning every one would grow both
    the allow-list and the per-ref discovery cost by a workflow set per tag
    (2.13 reached rc15).
    """
    pattern = release_tag_re(line)
    ga: List[Tuple[int, str]] = []
    candidates: List[Tuple[Tuple[int, int], str]] = []
    for name in tag_names:
        match = pattern.match(name)
        if match is None:
            continue
        patch, number = int(match.group(1)), match.group(2)
        if number is None:
            ga.append((patch, name))
        else:
            candidates.append(((patch, int(number)), name))
    selected: List[str] = []
    if ga:
        selected.append(max(ga)[1])
    if candidates:
        selected.append(max(candidates)[1])
    return [f"refs/tags/{name}" for name in selected]


def get_release_tags(client: GitHubClient, line: Tuple[int, int]) -> List[str]:
    # matching-refs returns every ref under the prefix in a single request;
    # listing /tags would page through pytorch/pytorch's entire tag history. The
    # trailing dot keeps a v2.1. prefix off v2.14.0, and the names are still
    # filtered against the exact tag pattern.
    prefix = f"v{line[0]}.{line[1]}."
    refs = client.request(
        "GET", f"/repos/{TARGET_REPO}/git/matching-refs/tags/{prefix}"
    ).json()
    names = [str(ref["ref"]).removeprefix("refs/tags/") for ref in refs]
    return select_target_tags(names, line)


def get_target_refs(client: GitHubClient) -> List[str]:
    anchor = get_test_version_anchor()
    log(f"Test-channel version anchor: release/{anchor[0]}.{anchor[1]}")
    branches = client.paginate(
        f"/repos/{TARGET_REPO}/branches", params={"protected": "true"}
    )
    refs = select_target_refs((branch["name"] for branch in branches), anchor)
    # Every pinned release line gets its tags, not just the candidate's, so a
    # patch release on the preceding line keeps runner access too.
    tags = [
        tag for line in release_lines(refs) for tag in get_release_tags(client, line)
    ]
    if not tags:
        # Expected between a branch cut and the line's first RC tag.
        log("No release tags cut yet on the pinned release lines")
    return refs + tags


# --- Desired state: workflow discovery -------------------------------------


def uses_release_label(text: str) -> bool:
    return RELEASE_LABEL_RE.search(text) is not None


def local_uses(job: Any) -> Optional[str]:
    """The local (``./``) reusable-workflow path a job invokes, if any."""
    if not isinstance(job, dict):
        return None
    uses = job.get("uses")
    if isinstance(uses, str) and uses.startswith("./"):
        return uses.split("@", 1)[0].removeprefix("./")
    return None


def local_uses_paths(wf: "WorkflowFile") -> Set[str]:
    """The local reusable-workflow paths invoked by any of a workflow's jobs."""
    jobs = wf.doc.get("jobs")
    if not isinstance(jobs, dict):
        return set()
    return {local for local in map(local_uses, jobs.values()) if local is not None}


def selector_job_names(wf: "WorkflowFile", label_files: Set[str]) -> Set[str]:
    """Names of ``wf``'s jobs that invoke a reusable carrying release labels.

    These are the ``select-runner`` style jobs: they hold no label themselves,
    they call ``_select-release-runner.yml`` and re-export its labels as outputs.
    """
    jobs = wf.doc.get("jobs")
    if not isinstance(jobs, dict):
        return set()
    names = set()
    for name, job in jobs.items():
        local = local_uses(job)
        if local is not None and local in label_files:
            names.add(str(name))
    return names


def selector_output_re(job_name: str) -> "re.Pattern[str]":
    """Matches a reference to ``job_name``'s outputs, in either accessor form
    (``needs.select-runner.outputs.x86`` / ``needs['select-runner'].outputs``)."""
    name = re.escape(job_name)
    return re.compile(rf"needs(?:\.{name}|\[['\"]{name}['\"]\])\.outputs\.")


def runs_on_release_runner(job: Any, selectors: Set[str]) -> bool:
    """Whether ``job`` runs on a release runner.

    Either it names a release label inline (the generated binary workflows still
    inline ``rel-l-x86iavx512-44-340`` in ``runs_on:``), or it takes its runner
    from a selector job's outputs -- which is how pytorch/pytorch#193378's
    ``build-triton-wheel.yml`` build jobs get theirs, with no label of their own:

        build-wheel-cuda:
          needs: select-runner
          uses: ./.github/workflows/_build-triton-wheel-linux.yml
          with:
            runs_on: ${{ needs.select-runner.outputs.x86 }}

    Sibling test/upload jobs gate out here: they depend on the build jobs, not on
    the selector's outputs, so they carry neither signal.
    """
    text = str(job)
    if uses_release_label(text):
        return True
    return any(selector_output_re(name).search(text) for name in selectors)


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


def fetch_workflow_files(
    client: GitHubClient, rev: str = "main"
) -> Dict[str, WorkflowFile]:
    # Fetch every workflow file's content at ``rev`` in a single GraphQL request.
    # Fetching each file over its raw.githubusercontent.com download_url instead
    # gets rate-limited (HTTP 429) on repos with many workflows like
    # pytorch/pytorch.
    owner, name = TARGET_REPO.split("/")
    resp = client.request(
        "POST",
        "/graphql",
        json={
            "query": WORKFLOW_TREE_QUERY,
            "variables": {
                "owner": owner,
                "name": name,
                "expression": f"{rev}:{WORKFLOWS_DIR}",
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

    An entry workflow either references a release label directly, or invokes a
    local reusable that does (pytorch/pytorch#190619 centralized the labels into
    ``_select-release-runner.yml``, whose callers get their runner from its
    outputs and so carry no label of their own) -- the release-label signal is
    propagated up the ``uses:`` graph rather than matching a hardcoded filename.
    From each entry, follow local ``uses:`` references, but only for jobs that
    themselves run on a release runner, so the build reusable is included while
    sibling test/upload jobs (which run on other runners) are not.

    Both steps use the same notion of "runs on a release runner" -- an inline
    label *or* a selector job's outputs. They used to disagree, and the edge test
    accepting only inline labels silently dropped
    ``_build-triton-wheel-linux.yml`` when pytorch/pytorch#193378 split it out of
    ``build-triton-wheel.yml``: the entry was still discovered via its
    ``select-runner`` job, but the reusable that actually consumes the runner was
    not, so its builds hung unassigned.
    """
    label_files = {path for path, wf in files.items() if uses_release_label(wf.raw)}
    entry_paths = {
        path
        for path, wf in files.items()
        if path in label_files or local_uses_paths(wf) & label_files
    }
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
        selectors = selector_job_names(wf, label_files)
        for job in jobs.values():
            local = local_uses(job)
            if local is None:
                continue
            if not runs_on_release_runner(job, selectors):
                continue
            queue.append(local)
    return seen


def discover_release_workflows(
    client: GitHubClient, refs: Iterable[str]
) -> Dict[str, Set[str]]:
    """Discover release workflows independently at each target ref.

    Refs diverge: a workflow present on ``main`` (e.g. the newly added
    ``_select-release-runner.yml``) may be absent on an older release branch, and
    GitHub rejects the whole allow-list PATCH if any ``selected_workflows`` entry
    does not exist at its ref. So discovery is per-ref rather than a main-only
    scan cross-producted onto every ref.
    """
    paths_by_ref: Dict[str, Set[str]] = {}
    for ref in refs:
        rev = ref.removeprefix("refs/heads/").removeprefix("refs/tags/")
        paths = collect_release_workflow_paths(fetch_workflow_files(client, rev))
        log(f"Discovered {len(paths)} release workflow(s) on {TARGET_REPO}@{rev}:")
        for path in sorted(paths):
            log(f"  {path}")
        paths_by_ref[ref] = paths
    return paths_by_ref


def build_desired_workflows(paths_by_ref: Dict[str, Set[str]]) -> Set[str]:
    return {
        f"{TARGET_REPO}/{path}@{ref}"
        for ref, paths in paths_by_ref.items()
        for path in paths
    }


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


def resolve_token(explicit: Optional[str]) -> Tuple[str, str]:
    """Return (token, where it came from) so errors can name the missing input."""
    if explicit:
        return explicit, "--token"
    token = os.getenv("RUNNER_GROUP_TOKEN")
    if token:
        return token, "RUNNER_GROUP_TOKEN"
    return os.getenv("GITHUB_TOKEN", ""), "GITHUB_TOKEN"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--token",
        type=str,
        default=None,
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
    token, token_source = resolve_token(args.token)
    if not token:
        raise SystemExit(
            "A GitHub token is required (--token, RUNNER_GROUP_TOKEN or GITHUB_TOKEN)"
        )
    # Managing runner groups hits /orgs/{org}/actions/runner-groups, which needs
    # admin:org. The Actions-provided GITHUB_TOKEN is repo-scoped and can never
    # have it, so --apply with that token always 403s. Fail here rather than
    # after the discovery pass, and before any mutation has been attempted.
    if args.apply and token_source == "GITHUB_TOKEN":
        raise SystemExit(
            "--apply needs a token with admin:org, but RUNNER_GROUP_TOKEN is "
            "unset so the repo-scoped GITHUB_TOKEN was used, which cannot "
            f"manage /orgs/{ORG}/actions/runner-groups. Check that the "
            "RUNNER_GROUP_TOKEN secret exists in the 'runner-group' environment "
            "and has not expired."
        )
    client = GitHubClient(token)

    refs = get_target_refs(client)
    log(f"Target refs: {refs}")
    paths_by_ref = discover_release_workflows(client, refs)
    desired = build_desired_workflows(paths_by_ref)
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
        if status == 403:
            raise SystemExit(
                f"403 reading /orgs/{ORG}/actions/runner-groups with the token "
                f"from {token_source}. That token lacks admin:org -- if it is "
                "RUNNER_GROUP_TOKEN, the secret is likely expired or was "
                "re-issued without the scope."
            ) from error
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
