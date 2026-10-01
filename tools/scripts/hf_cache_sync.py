#!/usr/bin/env python3
"""Seed the OSDC shared HuggingFace caches (``/mnt/hf_cache``).

Each OSDC cluster has its own private bucket
(``pytorch-hf-model-cache-<cluster>``, in the cluster's region), mounted
read-only on every runner node by the ci-infra ``hf-cache`` module. A job that
downloads a repo the mount does not already hold fails with::

    OSError: [Errno 30] Read-only file system:
        '/mnt/hf_cache/hub/models--<org>--<name>/...'

Because the buckets are per-cluster, a refresh that warms one region leaves the
others cold, and a job routed to the cold region breaks - typically on main,
after the PR went green somewhere warm. This script reconciles them.

Reads need no special role; writing needs credentials for the account owning
the buckets. Defaults to a dry-run, pass ``--apply`` to copy.

Examples::

    # What does each cluster hold, and where do they disagree?
    hf_cache_sync.py --diff

    # Seed one repo into the cluster that is missing it, from one that has it.
    hf_cache_sync.py --repo Qwen/Qwen3-0.6B --to meta-prod-aws-ue2 --apply

    # Datasets live under the same hub cache, prefixed.
    hf_cache_sync.py --repo datasets/kalomaze/alphabetic-arxiv-authors-it1 \\
        --to meta-prod-aws-ue2 --apply

    # Nothing has it yet (a brand new model): fetch from HuggingFace instead.
    hf_cache_sync.py --repo Qwen/Qwen3-8B --from-hub --to meta-prod-aws-ue1 --apply

    # Bring a whole cluster up to another's contents. Carries both top-level
    # prefixes -- the hub/ repos and the datasets/ cache -- which is what a
    # brand new region needs.
    hf_cache_sync.py --mirror --source meta-prod-aws-ue1 --to meta-prod-aws-uw1 --apply

A seeded repo is not necessarily visible to running jobs right away: the rclone
mount uses ``--dir-cache-time 1h --poll-interval 0``, so a node that has already
listed the parent directory keeps its cached listing for up to an hour. Nodes
that come up after the copy see it immediately.
"""

import argparse
import concurrent.futures
import functools
import os
import sys
import tempfile
from typing import Dict, Iterable, List, Optional, Set, Tuple


# Mirrors the clusters carrying the `hf-cache` module in ci-infra
# osdc/clusters.yaml. The lf-* clusters do not mount the cache.
CLUSTERS: Dict[str, str] = {
    "meta-prod-aws-ue1": "us-east-1",
    "meta-prod-aws-ue2": "us-east-2",
    "meta-prod-aws-uw1": "us-west-1",
    "meta-prod-aws-uw2": "us-west-2",
    "meta-staging-aws-ue1": "us-east-1",
    "meta-staging-aws-ue2": "us-east-2",
    "meta-staging-aws-uw1": "us-west-1",
}

PROD = [c for c in CLUSTERS if c.startswith("meta-prod-")]

# The mount serves the bucket as HF_HUB_CACHE, so every repo lives under hub/.
HUB = "hub"

# Second top-level prefix, and not repo-structured: it is the `datasets`
# library's arrow/lock cache, which linux_job_v3 copies into a writable
# HF_DATASETS_CACHE on every job. A cluster seeded with only hub/ fails in
# ways that do not obviously point at the cache, so a mirror has to carry it.
DATASETS = "datasets"

# Inside a repo: refs/<name> is a 40-byte commit sha, so it is the one
# thing in the cache whose size says nothing about whether it is current.
REFS = "refs"

MAX_WORKERS = 16


def bucket_of(cluster: str) -> str:
    return f"pytorch-hf-model-cache-{cluster}"


@functools.lru_cache(maxsize=None)
def client(cluster: str):
    """One S3 client per cluster.

    Memoized because the copy worker asks for the source client per object:
    boto3 caches the default session, not the client, so an unmemoized factory
    builds a signer, endpoint and connection pool per call, and builds them
    concurrently from the worker threads, which boto3 does not support.
    """
    # Imported here rather than at module scope so the pure logic above stays
    # importable (and unit-testable) without boto3 installed.
    import boto3  # type: ignore[import-untyped]

    return boto3.client("s3", region_name=CLUSTERS[cluster])


def cache_dir(repo: str) -> str:
    """Repo id -> the directory name HuggingFace gives it in the hub cache.

    Accepts ``org/name`` (a model), ``datasets/org/name`` or ``dataset/org/name``
    (a dataset), a bare ``name`` for the legacy un-namespaced repos (``gpt2``,
    ``t5-base``, ``albert-base-v2``), and passes an already-encoded
    ``models--org--name`` through.

    The bare form is not a synonym for the namespaced one: ``gpt2`` caches as
    ``models--gpt2`` while ``openai-community/gpt2`` caches as
    ``models--openai-community--gpt2``, so a cache holding one still misses a
    job that asks for the other.
    """
    if repo.startswith(("models--", "datasets--", "spaces--")):
        return repo.rstrip("/")
    parts = repo.strip("/").split("/")
    kind = "models"
    if parts[0] in ("datasets", "dataset"):
        kind, parts = "datasets", parts[1:]
    if len(parts) == 1 and kind == "models" and parts[0]:
        return f"{kind}--{parts[0]}"
    if len(parts) != 2:
        raise ValueError(
            f"cannot parse repo id {repo!r}; expected org/name, a bare name, "
            "or datasets/org/name"
        )
    return f"{kind}--{parts[0]}--{parts[1]}"


def list_repos(cluster: str) -> Set[str]:
    """The repo directories a cluster's cache holds."""
    paginator = client(cluster).get_paginator("list_objects_v2")
    repos = set()
    for page in paginator.paginate(
        Bucket=bucket_of(cluster), Prefix=f"{HUB}/", Delimiter="/"
    ):
        for entry in page.get("CommonPrefixes", []):
            name = entry["Prefix"][len(HUB) + 1 :].rstrip("/")
            # hub/blobs and hub/.locks are not repos
            if name.startswith(("models--", "datasets--", "spaces--")):
                repos.add(name)
    return repos


def list_objects(cluster: str, prefix: str) -> Dict[str, int]:
    """key -> size for everything under a prefix."""
    paginator = client(cluster).get_paginator("list_objects_v2")
    out = {}
    for page in paginator.paginate(Bucket=bucket_of(cluster), Prefix=prefix):
        for obj in page.get("Contents", []):
            out[obj["Key"]] = obj["Size"]
    return out


def copy_prefix(
    source: str,
    dest: str,
    prefix: str,
    label: str,
    apply: bool,
    src_objects: Optional[Dict[str, int]] = None,
) -> Tuple[int, int]:
    """Copy everything under an S3 prefix. Returns (objects copied, bytes copied).

    Objects already present at the same size are skipped, so a re-run after a
    partial copy resumes rather than repeating it.
    """
    if src_objects is None:
        src_objects = list_objects(source, prefix)
    if not src_objects:
        print(f"  {label}: not in {source}, skipping")
        return 0, 0

    have = list_objects(dest, prefix)
    # refs/<name> holds a 40-byte commit sha, so size cannot tell a stale ref
    # from a current one. Always re-copy those; everything else is content
    # addressed and size is a sound proxy.
    todo = [
        k for k, size in src_objects.items() if have.get(k) != size or f"/{REFS}/" in k
    ]
    n_bytes = sum(src_objects[k] for k in todo)

    if not todo:
        print(f"  {label}: already complete in {dest} ({len(src_objects)} objects)")
        return 0, 0

    print(
        f"  {label}: {len(todo)} objects, {n_bytes / 1e6:.1f} MB "
        f"{source} -> {dest}" + ("" if apply else "  [dry-run]")
    )
    if not apply:
        return len(todo), n_bytes

    dest_client = client(dest)
    src_client = client(source)
    src_bucket = bucket_of(source)

    def one(key: str) -> None:
        dest_client.copy(
            {"Bucket": src_bucket, "Key": key},
            bucket_of(dest),
            key,
            SourceClient=src_client,
        )

    with concurrent.futures.ThreadPoolExecutor(MAX_WORKERS) as pool:
        for _ in pool.map(one, todo):
            pass
    return len(todo), n_bytes


def copy_repo(
    source: str,
    dest: str,
    repo_dir: str,
    apply: bool,
    src_objects: Optional[Dict[str, int]] = None,
) -> Tuple[int, int]:
    """Copy one hub repo between clusters."""
    return copy_prefix(source, dest, f"{HUB}/{repo_dir}/", repo_dir, apply, src_objects)


def copy_datasets(source: str, dest: str, apply: bool) -> Tuple[int, int]:
    """Copy the top-level datasets/ cache between clusters."""
    return copy_prefix(source, dest, f"{DATASETS}/", f"{DATASETS}/", apply)


def download_from_hub(repo_dir: str, dest_dir: str) -> str:
    """Populate dest_dir with a hub-cache layout for repo_dir."""
    try:
        from huggingface_hub import snapshot_download  # type: ignore[import-untyped]
    except ImportError:
        sys.exit("--from-hub needs huggingface_hub: pip install huggingface_hub")

    kind, rest = repo_dir.split("--", 1)
    repo_type = {"models": "model", "datasets": "dataset", "spaces": "space"}[kind]
    # A legacy un-namespaced model is one segment ("models--gpt2"), everything
    # else is two ("models--openai--clip-vit-base-patch32").
    repo_id = rest.replace("--", "/", 1)
    print(f"  downloading {repo_id} ({repo_type}) from HuggingFace")
    snapshot_download(repo_id=repo_id, repo_type=repo_type, cache_dir=dest_dir)
    return os.path.join(dest_dir, repo_dir)


def upload_tree(
    local: str, cluster: str, repo_dir: str, apply: bool
) -> Tuple[int, int]:
    """Upload a local hub-cache directory, resolving symlinks.

    The hub cache symlinks snapshots/ at blobs/; the buckets are kept
    symlink-free so the rclone mount serves real files, which is also what
    `aws s3 sync` produces.
    """
    uploads = []
    for root, _, files in os.walk(local, followlinks=True):
        for f in files:
            path = os.path.join(root, f)
            key = f"{HUB}/{repo_dir}/{os.path.relpath(path, local)}"
            uploads.append((path, key, os.path.getsize(os.path.realpath(path))))

    # Same skip copy_prefix does, so an interrupted upload resumes instead of
    # re-sending a multi-GB repo.
    have = list_objects(cluster, f"{HUB}/{repo_dir}/")
    uploads = [u for u in uploads if have.get(u[1]) != u[2]]

    n_bytes = sum(size for _, _, size in uploads)
    if not uploads:
        print(f"  {repo_dir}: already complete in {cluster}")
        return 0, 0

    print(
        f"  {repo_dir}: {len(uploads)} objects, {n_bytes / 1e6:.1f} MB "
        f"hub -> {cluster}" + ("" if apply else "  [dry-run]")
    )
    if not apply:
        return len(uploads), n_bytes

    s3 = client(cluster)
    bucket = bucket_of(cluster)

    def one(item: Tuple[str, str, int]) -> None:
        path, key, _ = item
        s3.upload_file(os.path.realpath(path), bucket, key)

    with concurrent.futures.ThreadPoolExecutor(MAX_WORKERS) as pool:
        for _ in pool.map(one, uploads):
            pass
    return len(uploads), n_bytes


def show_diff(clusters: List[str], repos: Optional[List[str]]) -> None:
    holdings = {c: list_repos(c) for c in clusters}
    if repos:
        wanted = [cache_dir(r) for r in repos]
    else:
        wanted = sorted(set().union(*holdings.values()))

    width = max(len(r) for r in wanted) if wanted else 0
    print(f"{'repo':{width}}  " + "  ".join(f"{c:^22}" for c in clusters))
    drifted = 0
    for repo in wanted:
        marks = ["yes" if repo in holdings[c] else "NO" for c in clusters]
        if len(set(marks)) == 1 and not repos:
            continue  # everyone agrees, not interesting
        drifted += 1
        print(f"{repo:{width}}  " + "  ".join(f"{m:^22}" for m in marks))

    print()
    for c in clusters:
        print(f"  {c:24} {len(holdings[c])} repos")
    if not repos:
        print(f"  {drifted} repos are missing from at least one cluster")


def pick_source(repo_dir: str, clusters: Iterable[str]) -> Optional[str]:
    for c in clusters:
        if repo_dir in list_repos(c):
            return c
    return None


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--repo",
        action="append",
        default=[],
        metavar="ID",
        help="HF repo to seed: org/name, or datasets/org/name. Repeatable.",
    )
    parser.add_argument(
        "--to",
        action="append",
        default=[],
        metavar="CLUSTER",
        help="cluster to seed; defaults to every prod cluster",
    )
    parser.add_argument(
        "--source",
        metavar="CLUSTER",
        help="cluster to copy from; defaults to any prod cluster that has it",
    )
    parser.add_argument(
        "--from-hub",
        action="store_true",
        help="download from HuggingFace rather than another cluster",
    )
    parser.add_argument(
        "--mirror",
        action="store_true",
        help="seed every repo --source holds that a target is missing",
    )
    parser.add_argument("--diff", action="store_true", help="report drift and exit")
    parser.add_argument("--apply", action="store_true", help="copy (default: dry-run)")
    args = parser.parse_args()

    for c in args.to + ([args.source] if args.source else []):
        if c not in CLUSTERS:
            parser.error(f"unknown cluster {c!r}; known: {', '.join(CLUSTERS)}")

    if args.diff:
        show_diff(args.to or list(CLUSTERS), args.repo or None)
        return

    if not args.repo and not args.mirror:
        parser.error("nothing to do: pass --repo, --mirror or --diff")
    if args.mirror and not args.source:
        parser.error("--mirror needs --source")
    if args.from_hub and args.mirror:
        parser.error("--from-hub and --mirror are mutually exclusive")
    if args.repo and args.mirror:
        parser.error("--repo and --mirror are mutually exclusive")

    if args.mirror:
        repo_dirs = sorted(list_repos(args.source))
        print(f"{args.source} holds {len(repo_dirs)} repos")
    else:
        repo_dirs = [cache_dir(r) for r in args.repo]

    targets = args.to or PROD
    total_objects = total_bytes = 0

    for repo_dir in repo_dirs:
        # Every target, and let copy_prefix decide per object. Filtering here on
        # whether the destination already lists the repo would skip one that is
        # present but only half copied -- the exact state an interrupted run
        # leaves behind, and the one a re-run exists to repair. It is also the
        # cheaper call: a narrow per-repo listing instead of a full bucket scan.
        dests = targets

        if args.from_hub:
            with tempfile.TemporaryDirectory() as tmp:
                local = download_from_hub(repo_dir, tmp)
                for dest in dests:
                    n, b = upload_tree(local, dest, repo_dir, args.apply)
                    total_objects, total_bytes = total_objects + n, total_bytes + b
            continue

        # Candidates are every prod cluster that holds it; the loop below
        # skips the one we would be copying to itself. Narrowing this to
        # `PROD - missing` left nothing to pick from when --to was omitted.
        source = args.source or pick_source(repo_dir, PROD)
        if not source:
            print(f"  {repo_dir}: no cluster has it; re-run with --from-hub")
            continue
        # Identical for every destination, so list it once.
        src_objects = list_objects(source, f"{HUB}/{repo_dir}/")
        for dest in dests:
            if dest == source:
                continue
            n, b = copy_repo(source, dest, repo_dir, args.apply, src_objects)
            total_objects, total_bytes = total_objects + n, total_bytes + b

    if args.mirror:
        # Not a repo, so it falls outside the loop above entirely.
        for dest in targets:
            if dest == args.source:
                continue
            n, b = copy_datasets(args.source, dest, args.apply)
            total_objects, total_bytes = total_objects + n, total_bytes + b

    verb = "copied" if args.apply else "would copy"
    print(f"\n{verb} {total_objects} objects, {total_bytes / 1e6:.1f} MB")
    if not args.apply and total_objects:
        print("re-run with --apply to perform the copy")


if __name__ == "__main__":
    from botocore.exceptions import ClientError  # type: ignore[import-untyped]

    try:
        main()
    except ClientError as e:
        sys.exit(f"AWS error: {e}")
