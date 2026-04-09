#!/usr/bin/env python
#
# index_tools.py - Tools for managing PyTorch package index integrity
#
# This script provides utilities for verifying and fixing PyTorch wheel
# package checksums and S3/R2 sync status. It complements manage_v2.py
# (which handles index HTML generation/upload) by focusing on:
#
#   - SHA256 checksum management: compute, verify, and set checksums
#     for wheel files stored on S3.
#   - S3/R2 sync verification: compare file content between AWS S3
#     (source of truth) and Cloudflare R2 to detect mismatches.
#   - S3→R2 sync repair: copy mismatched/missing files from S3 to R2.
#
# SHA256 checksum operations:
#   --set-checksum              Compute and set SHA256 metadata for a specific
#                               package/version (requires --package-name,
#                               --package-version).
#   --recompute-sha256-pattern  Compute SHA256 for .whl files matching a subdir
#                               pattern that are missing checksums.
#   --recompute-missing-sha256  Scan the entire prefix for .whl files missing
#                               x-amz-meta-checksum-sha256 and compute/set it.
#
# S3/R2 sync operations:
#   --check-r2-sync   Compare SHA256 of .whl and .whl.metadata files between
#                     S3 and R2 for a specific package/version. Reports
#                     mismatches and files missing on R2.
#   --fix-r2-sync     Same as --check-r2-sync but also copies mismatched or
#                     missing files from S3 to R2.
#
# Usage examples:
#   # Set checksum for a specific package and version:
#   python s3_management/index_tools.py whl/test --set-checksum \
#       --package-name torch --package-version 2.5.0+cu121
#
#   # Recompute missing SHA256 checksums for a channel:
#   python s3_management/index_tools.py whl/nightly --recompute-missing-sha256
#
#   # Recompute SHA256 for a specific subdir pattern:
#   python s3_management/index_tools.py whl/test --recompute-sha256-pattern rocm6.4
#
#   # Check S3/R2 sync for torch 2.9.0 (all variants):
#   python s3_management/index_tools.py whl --check-r2-sync \
#       --package-name torch --package-version 2.9.0
#
#   # Check S3/R2 sync for a specific CUDA variant:
#   python s3_management/index_tools.py whl --check-r2-sync \
#       --package-name torch --package-version 2.9.0+cu129
#
#   # Fix mismatches by copying S3→R2:
#   python s3_management/index_tools.py whl --fix-r2-sync \
#       --package-name torch --package-version 2.9.0+cu129

import argparse
import base64
import concurrent.futures
import hashlib
import json
import os
import sys
import urllib.request
import urllib.error
from os import path
from re import match
from typing import List, Optional

import boto3  # type: ignore[import]
import botocore  # type: ignore[import]


# ---------------------------------------------------------------------------
# S3 client (source of truth: pytorch bucket on download.pytorch.org)
# ---------------------------------------------------------------------------
S3 = boto3.resource("s3")
CLIENT = boto3.client("s3")
BUCKET = S3.Bucket("pytorch")

# ---------------------------------------------------------------------------
# Cloudflare R2 configuration
# Set env vars: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
# ---------------------------------------------------------------------------
R2_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET_NAME = os.environ.get("R2_BUCKET_NAME", "pytorch-downloads")

R2_CLIENT = None
R2_BUCKET = None
if R2_ACCOUNT_ID and R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY:
    R2_CLIENT = boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
    )
    R2_RESOURCE = boto3.resource(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
    )
    R2_BUCKET = R2_RESOURCE.Bucket(R2_BUCKET_NAME)

# ---------------------------------------------------------------------------
# Cloudflare CDN cache purge configuration
# Set env vars: CLOUDFLARE_ZONE_ID, CLOUDFLARE_API_TOKEN
# ---------------------------------------------------------------------------
CLOUDFLARE_ZONE_ID = os.environ.get("CLOUDFLARE_ZONE_ID", "")
CLOUDFLARE_API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
R2_CDN_BASE_URL = "https://download-r2.pytorch.org"

PREFIXES = [
    "whl",
    "whl/nightly",
    "whl/test",
    "libtorch",
    "libtorch/nightly",
    "whl/test/variant",
    "whl/variant",
    "whl/preview/forge",
    "source_code/test",
]


# ===================================================================
# Helpers
# ===================================================================

def _get_excluded_prefixes(prefix: str) -> List[str]:
    """Return PREFIXES that are strict children of *prefix*.

    When listing S3 objects under ``whl/``, the results also include
    ``whl/nightly/…`` and ``whl/test/…``.  This helper returns the
    child prefixes so callers can skip them.
    """
    prefix_slash = prefix.rstrip("/") + "/"
    return [
        p.rstrip("/") + "/"
        for p in PREFIXES
        if p != prefix and p.startswith(prefix_slash)
    ]


def _key_in_prefix(key: str, prefix: str, excluded: List[str]) -> bool:
    """Return True if *key* belongs to *prefix* but not to any excluded child."""
    return not any(key.startswith(ex) for ex in excluded)


def _purge_cloudflare_cache(keys: List[str]) -> None:
    """Purge Cloudflare CDN cache for the given S3 keys.

    Uses the Cloudflare API to purge cached copies of files that were
    updated on R2, so that subsequent downloads serve the fresh version.
    Requires CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN env vars.

    The API accepts up to 30 files per request, so keys are batched.
    """
    if not CLOUDFLARE_ZONE_ID or not CLOUDFLARE_API_TOKEN:
        print(
            "WARNING: CLOUDFLARE_ZONE_ID or CLOUDFLARE_API_TOKEN not set, "
            "skipping CDN cache purge."
        )
        return

    urls = [f"{R2_CDN_BASE_URL}/{key}" for key in keys]
    api_url = (
        f"https://api.cloudflare.com/client/v4/zones/"
        f"{CLOUDFLARE_ZONE_ID}/purge_cache"
    )

    # Cloudflare allows up to 30 files per purge request
    batch_size = 30
    total_purged = 0

    for i in range(0, len(urls), batch_size):
        batch = urls[i : i + batch_size]
        payload = json.dumps({"files": batch}).encode("utf-8")

        req = urllib.request.Request(
            api_url,
            data=payload,
            headers={
                "Authorization": f"Bearer {CLOUDFLARE_API_TOKEN}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                if body.get("success"):
                    total_purged += len(batch)
                    print(
                        f"  Purged CDN cache for {len(batch)} URL(s) "
                        f"(batch {i // batch_size + 1})"
                    )
                else:
                    errors = body.get("errors", [])
                    print(f"  WARNING: CDN purge returned errors: {errors}")
        except urllib.error.HTTPError as exc:
            error_body = exc.read().decode("utf-8", errors="replace")
            print(
                f"  WARNING: CDN purge request failed "
                f"(HTTP {exc.code}): {error_body}"
            )
        except urllib.error.URLError as exc:
            print(f"  WARNING: CDN purge request failed: {exc.reason}")

    print(f"  CDN cache purge complete: {total_purged}/{len(urls)} URL(s) purged")


def _compute_sha256_from_stream(body) -> str:
    """Compute SHA256 by reading a streaming body in 8 KB chunks."""
    sha256_hash = hashlib.sha256()
    for chunk in iter(lambda: body.read(8192), b""):
        sha256_hash.update(chunk)
    return sha256_hash.hexdigest()


def _find_matching_objects(
    prefix: str,
    package_name: str,
    version: str,
    extensions: tuple = (".whl", ".whl.metadata"),
) -> List[str]:
    """Find objects under *prefix* matching *package_name*-*version*-…

    Handles URL-encoded ``+`` (``%2B``) in S3 keys.  When *version*
    contains no ``+``, also matches local-version variants such as
    ``2.9.0+cu129``.
    """
    normalized_package = package_name.lower().replace("-", "_")
    version_encoded = version.replace("+", "%2B").lower()
    version_lower = version.lower()
    excluded = _get_excluded_prefixes(prefix)

    matching: List[str] = []
    for obj in BUCKET.objects.filter(Prefix=prefix):
        key = obj.key
        if not _key_in_prefix(key, prefix, excluded):
            continue
        if not any(key.endswith(ext) for ext in extensions):
            continue

        basename = path.basename(key).lower()
        # Strip .metadata suffix for matching purposes
        match_name = (
            basename[: -len(".metadata")]
            if basename.endswith(".metadata")
            else basename
        )

        # Exact version match (with + or %2B)
        prefix1 = f"{normalized_package}-{version_encoded}-"
        prefix2 = f"{normalized_package}-{version_lower}-"
        if match_name.startswith(prefix1) or match_name.startswith(prefix2):
            matching.append(key)
            continue

        # When version has no +, also match local-version specifiers
        # e.g. version="2.9.0" matches "torch-2.9.0%2Bcu129-…"
        if "+" not in version:
            prefix3 = f"{normalized_package}-{version_lower}%2b"
            prefix4 = f"{normalized_package}-{version_lower}+"
            if match_name.startswith(prefix3) or match_name.startswith(prefix4):
                matching.append(key)

    return sorted(matching)


# ===================================================================
# SHA-256 checksum management  (moved from manage_v2.py)
# ===================================================================

def _compute_and_set_checksums(matching_objects: List[str]) -> None:
    """Compute and set SHA256 checksums for a list of S3 object keys.

    Skips objects that already have checksums.

    Args:
        matching_objects: List of S3 object keys to process
    """
    # 5GB limit for single CopyObject operation
    MULTIPART_THRESHOLD = 5 * 1024 * 1024 * 1024

    processed = 0
    skipped = 0
    for key in matching_objects:
        try:
            s3_obj = BUCKET.Object(key=key)

            # Check if checksum already exists
            head = CLIENT.head_object(
                Bucket=BUCKET.name, Key=key, ChecksumMode="Enabled"
            )
            existing_checksum = head.get("Metadata", {}).get("checksum-sha256")
            if not existing_checksum:
                existing_checksum = head.get("Metadata", {}).get(
                    "x-amz-meta-checksum-sha256"
                )
            if not existing_checksum:
                # Check for S3 native checksum
                raw = head.get("ChecksumSHA256")
                if raw and not match(r"^[A-Za-z0-9+/=]+=-[0-9]+$", raw):
                    existing_checksum = base64.b64decode(raw).hex()

            if existing_checksum:
                print(f"SKIP: {key} already has checksum: {existing_checksum}")
                skipped += 1
                continue

            content_length = head.get("ContentLength", 0)
            print(
                f"\nINFO: Processing {key} (size: {content_length / (1024 * 1024):.1f} MB)"
            )

            # Download and compute SHA256
            print(f"INFO: Downloading {key} to compute SHA256...")
            response = s3_obj.get()
            body = response["Body"]

            sha256 = _compute_sha256_from_stream(body)
            print(f"INFO: Computed SHA256: {sha256}")

            # Fetch existing metadata
            existing_metadata = s3_obj.metadata.copy()

            # Add/update the checksum metadata
            existing_metadata["checksum-sha256"] = sha256

            # Copy the object to itself with updated metadata
            if content_length >= MULTIPART_THRESHOLD:
                # Use multipart copy for files >= 5GB
                print(
                    f"INFO: Using multipart copy for large file ({content_length / (1024 * 1024 * 1024):.1f} GB)..."
                )
                copy_source = {"Bucket": BUCKET.name, "Key": key}
                s3_obj.copy(
                    CopySource=copy_source,
                    ExtraArgs={
                        "Metadata": existing_metadata,
                        "MetadataDirective": "REPLACE",
                        "ACL": "public-read",
                    },
                )
            else:
                # Use simple copy for smaller files
                s3_obj.copy_from(
                    CopySource={"Bucket": BUCKET.name, "Key": key},
                    Metadata=existing_metadata,
                    MetadataDirective="REPLACE",
                    ACL="public-read",
                )
            print(f"SUCCESS: Set x-amz-meta-checksum-sha256={sha256} for {key}")
            processed += 1

        except Exception as e:
            print(f"ERROR: Failed to process {key}: {e}")
            raise

    print(
        f"\nINFO: Summary - Processed: {processed}, Skipped (already had checksum): {skipped}"
    )


def set_checksum_metadata(prefix: str, package_name: str, version: str) -> None:
    """Compute and set x-amz-meta-checksum-sha256 for all .whl files matching package-version."""
    if not prefix.startswith("whl"):
        raise ValueError(f"Prefix must start with whl, got: {prefix}")

    matching_objects = _find_matching_objects(
        prefix, package_name, version, extensions=(".whl",)
    )

    if not matching_objects:
        print(
            f"WARNING: No matching objects found for {package_name}-{version} in {prefix}/"
        )
        return

    print(f"INFO: Found {len(matching_objects)} matching objects")
    _compute_and_set_checksums(matching_objects)


def recompute_sha256_for_pattern(
    prefix: str,
    pattern: str,
    package_name: Optional[str] = None,
    version: Optional[str] = None,
) -> None:
    """Compute SHA256 checksums for objects matching a pattern that don't have checksums.

    Args:
        prefix: The S3 prefix to search in (e.g., "whl/test")
        pattern: The pattern to match against object keys (e.g., "rocm6.4")
        package_name: Optional package name to filter (e.g., "torch", "torchvision")
        version: Optional version to filter (e.g., "2.5.0", "2.5.0+rocm7.1")
    """
    print(f"INFO: Searching in '{prefix}' for objects matching pattern '{pattern}'")
    normalized_package = None
    if package_name:
        print(f"INFO: Filtering by package name: '{package_name}'")
        normalized_package = package_name.lower().replace("-", "_")

    if version:
        print(f"INFO: Filtering by version: '{version}'")

    # Find all matching objects
    matching_objects = []

    # Construct the scan prefix by combining prefix and pattern
    scan_prefix = f"{prefix}/{pattern}/"
    print(f"INFO: Scanning prefix '{scan_prefix}'...")

    for obj in BUCKET.objects.filter(Prefix=scan_prefix):
        key = obj.key
        # Only process wheel files
        if key.endswith(".whl"):
            basename = path.basename(key).lower()
            # If package_name is specified, filter by it
            if normalized_package:
                if not basename.startswith(f"{normalized_package}-"):
                    continue

            # If version is specified, filter by it
            if version:
                version_encoded = version.replace("+", "%2B").lower()
                version_lower = version.lower()
                version_match = (
                    f"-{version_encoded}-" in basename
                    or f"-{version_lower}-" in basename
                    or f"-{version_encoded}+" in basename
                    or f"-{version_lower}+" in basename
                    or f"-{version_encoded}%2b" in basename
                    or f"-{version_lower}%2b" in basename
                )
                if not version_match:
                    continue

            matching_objects.append(key)

    if not matching_objects:
        filters = []
        if package_name:
            filters.append(f"package '{package_name}'")
        if version:
            filters.append(f"version '{version}'")
        filter_msg = f" for {', '.join(filters)}" if filters else ""
        print(f"WARNING: No matching objects found for pattern '{pattern}'{filter_msg}")
        return

    print(f"INFO: Found {len(matching_objects)} matching wheel files")
    _compute_and_set_checksums(matching_objects)


def recompute_missing_sha256(prefix: str) -> None:
    """Scan prefix for .whl files missing SHA256 checksums and compute/set them.

    This replaces the ``--recompute-missing-sha256`` flow that previously
    lived in manage_v2.py.  Objects that already have checksums are
    automatically skipped by ``_compute_and_set_checksums``.
    """
    print(f"INFO: Scanning '{prefix}' for .whl files...")
    excluded = _get_excluded_prefixes(prefix)
    matching: List[str] = []
    for obj in BUCKET.objects.filter(Prefix=prefix):
        if not _key_in_prefix(obj.key, prefix, excluded):
            continue
        if obj.key.endswith(".whl"):
            matching.append(obj.key)

    if not matching:
        print(f"WARNING: No .whl files found under {prefix}/")
        return

    print(
        f"INFO: Found {len(matching)} .whl files, checking for missing checksums..."
    )
    _compute_and_set_checksums(matching)


# ===================================================================
# S3 / R2 sync verification and repair
# ===================================================================

def _check_single_key(key: str) -> tuple:
    """Download a key from both S3 and R2, compute SHA256, return comparison.

    Returns:
        (key, s3_sha256, r2_sha256_or_None, status)
        status is one of "OK", "MISMATCH", "MISSING_ON_R2"
    """
    # Download from S3 and hash
    s3_response = BUCKET.Object(key=key).get()
    s3_sha256 = _compute_sha256_from_stream(s3_response["Body"])

    # Download from R2 and hash
    try:
        r2_response = R2_BUCKET.Object(key=key).get()
        r2_sha256 = _compute_sha256_from_stream(r2_response["Body"])
    except botocore.exceptions.ClientError as e:  # type: ignore[attr-defined]
        error_code = e.response.get("Error", {}).get("Code", "")
        if error_code in ("404", "NoSuchKey"):
            return (key, s3_sha256, None, "MISSING_ON_R2")
        raise

    if s3_sha256 == r2_sha256:
        return (key, s3_sha256, r2_sha256, "OK")
    return (key, s3_sha256, r2_sha256, "MISMATCH")


def _copy_s3_to_r2(key: str) -> None:
    """Copy a single object from S3 to R2."""
    head = CLIENT.head_object(Bucket=BUCKET.name, Key=key)
    content_length = head.get("ContentLength", 0)
    content_type = head.get("ContentType", "binary/octet-stream")

    print(
        f"  Copying {key} ({content_length / (1024 * 1024):.1f} MB) S3 -> R2 ..."
    )

    # Download from S3
    body = BUCKET.Object(key=key).get()["Body"].read()

    # Upload to R2
    R2_BUCKET.Object(key=key).put(
        Body=body,
        ContentType=content_type,
    )
    print(f"  SUCCESS: {key}")


def check_r2_sync(
    prefix: str, package_name: str, version: str, fix: bool = False
) -> None:
    """Compare SHA256 of files between S3 and R2 for a specific package/version.

    Downloads each matching .whl and .whl.metadata file from both S3 and
    R2, computes SHA256 from the actual content, and reports mismatches.

    When *fix* is True, mismatched or missing files are copied from S3
    (source of truth) to R2.

    Args:
        prefix: S3 prefix (e.g., "whl", "whl/test")
        package_name: Package name (e.g., "torch")
        version: Version string (e.g., "2.9.0" or "2.9.0+cu129").
                 If no ``+`` in version, all local-version variants are
                 matched (e.g., "2.9.0" matches cu129, cu124, cpu, …).
        fix: If True, copy mismatched/missing files from S3 to R2.
    """
    if not R2_BUCKET:
        print("ERROR: R2 credentials not configured. Set R2_ACCOUNT_ID, "
              "R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY environment variables.")
        sys.exit(1)

    matching_keys = _find_matching_objects(prefix, package_name, version)
    if not matching_keys:
        print(
            f"WARNING: No matching objects found for {package_name}-{version} in {prefix}/"
        )
        return

    print(
        f"INFO: Found {len(matching_keys)} objects to check for "
        f"{package_name}-{version} in {prefix}/"
    )
    print()

    # Check each key in parallel (limit concurrency to avoid overwhelming I/O)
    max_workers = min(6, len(matching_keys)) or 1
    results: list = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_key = {
            executor.submit(_check_single_key, key): key for key in matching_keys
        }
        for future in concurrent.futures.as_completed(future_to_key):
            key = future_to_key[future]
            try:
                result = future.result()
                results.append(result)

                _, s3_sha, r2_sha, status = result
                if status == "OK":
                    print(f"  OK          {key}")
                elif status == "MISMATCH":
                    print(f"  MISMATCH    {key}")
                    print(f"    S3:  {s3_sha}")
                    print(f"    R2:  {r2_sha}")
                else:
                    print(f"  MISSING_R2  {key}")
                    print(f"    S3:  {s3_sha}")
            except Exception as exc:
                print(f"  ERROR       {key}: {exc}")
                results.append((key, None, None, "ERROR"))

    # Summary
    ok_count = sum(1 for *_, s in results if s == "OK")
    mismatch_keys = [k for k, *_, s in results if s == "MISMATCH"]
    missing_keys = [k for k, *_, s in results if s == "MISSING_ON_R2"]
    error_count = sum(1 for *_, s in results if s == "ERROR")

    print(f"\n{'=' * 72}")
    print(
        f"Summary: {ok_count} OK, {len(mismatch_keys)} MISMATCH, "
        f"{len(missing_keys)} MISSING_ON_R2, {error_count} ERROR"
    )
    print(f"{'=' * 72}")

    to_fix = mismatch_keys + missing_keys
    if not to_fix:
        return

    if not fix:
        print(
            f"\nTo fix, re-run with --fix-r2-sync to copy {len(to_fix)} "
            "file(s) from S3 -> R2."
        )
        return

    # --- Fix: copy S3 → R2 ---
    print(f"\nCopying {len(to_fix)} file(s) from S3 -> R2 ...")
    copied_keys: List[str] = []
    for key in to_fix:
        try:
            _copy_s3_to_r2(key)
            copied_keys.append(key)
        except Exception as exc:
            print(f"  ERROR copying {key}: {exc}")

    # Purge Cloudflare CDN cache for copied files
    if copied_keys:
        print(f"\nPurging Cloudflare CDN cache for {len(copied_keys)} file(s)...")
        _purge_cloudflare_cache(copied_keys)

    print("\nDone. Re-run with --check-r2-sync to verify.")


# ===================================================================
# CLI
# ===================================================================

def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        "index_tools",
        description="Tools for managing PyTorch package index integrity: "
        "SHA256 checksums and S3/R2 sync.",
    )
    parser.add_argument(
        "prefix",
        type=str,
        choices=PREFIXES + ["all"],
        help="S3 prefix to operate on (e.g., whl, whl/nightly, whl/test).",
    )

    # -- SHA256 checksum commands --
    sha_group = parser.add_argument_group("SHA256 checksum management")
    sha_group.add_argument(
        "--set-checksum",
        action="store_true",
        help="Compute and set x-amz-meta-checksum-sha256 metadata for packages "
        "matching --package-name and --package-version.",
    )
    sha_group.add_argument(
        "--recompute-sha256-pattern",
        type=str,
        metavar="PATTERN",
        help="Compute SHA256 for .whl files under PREFIX/PATTERN/ that don't "
        "already have checksums (e.g., 'rocm6.4').",
    )
    sha_group.add_argument(
        "--recompute-missing-sha256",
        action="store_true",
        help="Scan PREFIX for .whl files missing x-amz-meta-checksum-sha256 "
        "and compute/set it. When prefix is 'all', processes every prefix.",
    )

    # -- S3/R2 sync commands --
    sync_group = parser.add_argument_group("S3/R2 sync verification")
    sync_group.add_argument(
        "--check-r2-sync",
        action="store_true",
        help="Compare SHA256 of .whl and .whl.metadata files between S3 and R2 "
        "for --package-name/--package-version.  Reports mismatches.",
    )
    sync_group.add_argument(
        "--fix-r2-sync",
        action="store_true",
        help="Same as --check-r2-sync but also copies mismatched/missing files "
        "from S3 (source of truth) to R2.",
    )

    # -- Shared filter options --
    filter_group = parser.add_argument_group("Filtering options")
    filter_group.add_argument(
        "--package-name",
        type=str,
        metavar="NAME",
        help="Package name to filter (e.g., torch, torchvision).",
    )
    filter_group.add_argument(
        "--package-version",
        type=str,
        metavar="VERSION",
        help="Package version to filter (e.g., 2.9.0, 2.9.0+cu129).",
    )

    return parser


def main() -> None:
    parser = create_parser()
    args = parser.parse_args()

    # --set-checksum
    if args.set_checksum:
        if not args.package_name:
            parser.error("--set-checksum requires --package-name")
        if not args.package_version:
            parser.error("--set-checksum requires --package-version")
        set_checksum_metadata(args.prefix, args.package_name, args.package_version)
        return

    # --recompute-sha256-pattern
    if args.recompute_sha256_pattern:
        recompute_sha256_for_pattern(
            args.prefix,
            args.recompute_sha256_pattern,
            args.package_name,
            args.package_version,
        )
        return

    # --recompute-missing-sha256
    if args.recompute_missing_sha256:
        prefixes = PREFIXES if args.prefix == "all" else [args.prefix]
        for pfx in prefixes:
            recompute_missing_sha256(pfx)
        return

    # --check-r2-sync / --fix-r2-sync
    if args.check_r2_sync or args.fix_r2_sync:
        if not args.package_name:
            parser.error("--check-r2-sync/--fix-r2-sync requires --package-name")
        if not args.package_version:
            parser.error("--check-r2-sync/--fix-r2-sync requires --package-version")
        check_r2_sync(
            args.prefix,
            args.package_name,
            args.package_version,
            fix=args.fix_r2_sync,
        )
        return

    parser.print_help()
    print(
        "\nERROR: No action specified. Use one of: --set-checksum, "
        "--recompute-sha256-pattern, --recompute-missing-sha256, "
        "--check-r2-sync, --fix-r2-sync"
    )
    sys.exit(1)


if __name__ == "__main__":
    main()
