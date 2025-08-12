# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "requests>=2.31.0",
#   "python-dotenv>=1.0.0",
# ]
# ///

"""
GitHub Organization Text Replacement Script
==========================================

Purpose:
--------
This script replaces all instances of "pytorch-labs" with "meta-pytorch" across all repositories
in a specified GitHub organization and creates pull requests for each repository with changes.

Key Features:
-------------
- Uses pre-defined list of files known to contain "pytorch-labs" mentions (optimized for performance). This list was obtained by running codesea
- Replaces all instances of "pytorch-labs" with "meta-pytorch" in target files.
- Creates a new branch and commits changes for each repository.
- Creates pull requests with descriptive titles and descriptions.
- Caches GitHub API responses for efficiency and rate limit avoidance.

How to Run:
-----------
1. Ensure you have Python 3.9+ and install dependencies (see below).
2. Set the following environment variable (can be in a .env file):
   - `GITHUB_TOKEN`: A GitHub personal access token with `repo` permissions.
3. Run the script:

   ```bash
   python remove_pytorch_labs.py [--org ORG_NAME] [--repos REPO_LIST] [--dry-run]
   ```
   - Use `--org` to specify the GitHub organization to analyze (defaults to 'pytorch').
   - Use `--repos` to specify a comma-separated list of repositories to process (e.g., 'pytorch,vision,tutorials').
   - Use `--dry-run` to preview changes without making them.


Output:
-------
- Logs all operations to console and file
- Creates pull requests for repositories with changes
- Summary report of operations performed

Notes:
------
- Only processes 72 pre-identified files that contain "pytorch-labs" mentions
- Skips binary files and files larger than 1MB
- Creates one PR per repository with changes
- Handles GitHub API rate limits automatically
- Significantly faster than scanning all files in all repositories
"""

import argparse
import base64
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import requests
from cache_manager import get_cache_stats, make_cached_request
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")
ORG_NAME = None  # Will be set by argparse
DRY_RUN = False  # Will be set by argparse

# GitHub API headers
HEADERS = {
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
}

BASE_URL = "https://api.github.com"

# Text to replace
OLD_TEXT = "pytorch-labs"
NEW_TEXT = "meta-pytorch"

# Maximum file size to process (1MB)
MAX_FILE_SIZE = 1024 * 1024

# Pre-defined list of files that contain "pytorch-labs" mentions
# This is based on search results and will significantly improve performance
TARGET_FILES = {
    "pytorch": [
        "android/README.md",
        "aten/src/ATen/native/cuda/int4mm.cu",
        "torch/testing/_internal/common_quantization.py"
    ],
    "vision": [
        "torchvision/io/image.py"
    ],
    "tutorials": [
        "index.rst",
        "docathon-leaderboard.md",
        "intermediate_source/transformer_building_blocks.py",
        "unstable_source/gpu_quantization_torchao_tutorial.py"
    ],
    "executorch": [
        "docs/source/index.md",
        "docs/source/getting-started.md",
        "backends/apple/mps/setup.md",
        "docs/source/backends-mps.md",
        "docs/source/llm/run-with-c-plus-plus.md",
        "docs/source/using-executorch-android.md",
        "docs/source/using-executorch-export.md",
        "docs/source/using-executorch-building-from-source.md",
        "docs/source/using-executorch-cpp.md",
        "examples/models/llama/experimental/generate.py",
        "scripts/test_ios.sh",
        ".ci/scripts/test_ios_ci.sh",
        "backends/test/facto/test_facto.py"
    ],
    "ao": [
        "scripts/download.py",
        "torchao/_models/llama/tokenizer.py",
        "scripts/convert_hf_checkpoint.py",
        "examples/sam2_amg_server/annotate_with_rle.py",
        "torchao/prototype/mx_formats/kernels.py",
        "torchao/_models/sam/README.md",
        "torchao/quantization/README.md",
        "test/integration/test_integration.py",
        ".github/workflows/dashboard_perf_test.yml"
    ],
    "benchmark": [
        "torchbenchmark/models/simple_gpt/origin",
        "torchbenchmark/models/sam_fast/requirements.txt"
    ],
    "torchtune": [
        "docs/source/tutorials/qlora_finetune.rst",
        "recipes/eleuther_eval.py",
        "docs/source/tutorials/e2e_flow.rst",
        "torchtune/generation/_generation.py",
        "docs/source/tutorials/llama3.rst",
        "README.md"
    ],
    "torchft": [
        "docs/source/protocol.rst",
        "docs/source/assumptions_and_recommendations.rst",
        "docs/source/conf.py",
        "docs/source/index.rst",
        "README.md"
    ],
    "torchchat": [
        "torchchat/usages/eval.py",
        "README.md"
    ],
    "rl": [
        "examples/rlhf/requirements.txt"
    ],
    "builder": [
        "CUDA_UPGRADE_GUIDE.MD"
    ],
    "helion": [
        "benchmarks/run.py",
        "benchmarks/README.md"
    ],
    "torchcodec": [
        "src/torchcodec/_core/SingleStreamDecoder.cpp"
    ],
    "test-infra": [
        "aws/lambda/README.md",
        "torchci/clickhouse_queries/queued_jobs_aggregate/query.sql",
        "tools/torchfix/README.md",
        ".github/workflows/trigger_nightly.yml"
    ],
    "ci-infra": [
        "arc-backup-2024/scripts/deployment.py"
    ],
    "oss-docathons": [
        "pytorch/h1-2024/leaderboard-pytorch-docathon-h1-2024.md",
        "pytorch/h1-2024/leaderboard-pytorch-docathon-h1-2024.csv",
        ".github/scripts/pytorch-docathon-h1-2024.py"
    ],
    "serve": [
        "examples/large_models/segment_anything_fast/install_segment_anything_fast.sh",
        "examples/large_models/gpt_fast/README.md",
        "examples/large_models/gpt_fast_mixtral_moe/README.md",
        "examples/large_models/diffusion_fast/README.md",
        "examples/large_models/segment_anything_fast/README.md",
        "kubernetes/kserve/examples/gpt_fast/README.md"
    ],
    "xla": [
        "torchax/test/llama/llama_model.py"
    ],
    "pytorch-canary": [
        "torch/testing/_internal/common_quantization.py"
    ],
    "pytorch-integration-testing": [
        ".github/scripts/generate_vllm_benchmark_matrix.py"
    ],
    "torcheval": [
        ".github/PULL_REQUEST_TEMPLATE.md",
        ".github/ISSUE_TEMPLATE/bug-report.yml"
    ]
}


def get_target_repos(org: str, filter_repos: Optional[List[str]] = None) -> List[str]:
    """Get only the repositories that have files with 'pytorch-labs' mentions."""
    if org not in TARGET_FILES:
        logging.info(f"[get_target_repos] No target files found for org: {org}")
        return []
    
    all_repos = list(TARGET_FILES.keys())
    
    if filter_repos:
        # Filter to only include repos that are in both the target files and the filter list
        repos = [repo for repo in all_repos if repo in filter_repos]
        logging.info(f"[get_target_repos] Filtered to {len(repos)} repositories from {len(all_repos)} available")
        
        # Log which repos were filtered out
        filtered_out = [repo for repo in filter_repos if repo not in all_repos]
        if filtered_out:
            logging.warning(f"[get_target_repos] Repositories not found in target files: {filtered_out}")
    else:
        repos = all_repos
        logging.info(f"[get_target_repos] Found {len(repos)} repositories with target files for org: {org}")
    
    return repos


def get_default_branch(org: str, repo: str) -> Optional[str]:
    """Get the default branch for a repository."""
    url = f"{BASE_URL}/repos/{org}/{repo}"
    data = make_cached_request(url, HEADERS)
    if data:
        return data.get("default_branch", "main")
    return None


def get_target_files_for_repo(org: str, repo: str) -> List[str]:
    """Get the list of target files for a specific repository."""
    if repo not in TARGET_FILES:
        logging.info(f"[get_target_files_for_repo] No target files found for {org}/{repo}")
        return []
    
    files = TARGET_FILES[repo]
    logging.info(f"[get_target_files_for_repo] Found {len(files)} target files for {org}/{repo}")
    return files


def get_file_content(org: str, repo: str, file_path: str) -> Optional[str]:
    """Get the content of a file from GitHub."""
    url = f"{BASE_URL}/repos/{org}/{repo}/contents/{file_path}"
    data = make_cached_request(url, HEADERS)
    if not data:
        return None
    
    # Check file size
    if data.get("size", 0) > MAX_FILE_SIZE:
        logging.warning(f"[get_file_content] File {file_path} too large ({data['size']} bytes), skipping")
        return None
    
    # Decode content
    try:
        content = base64.b64decode(data["content"]).decode("utf-8")
        return content
    except (UnicodeDecodeError, Exception) as e:
        logging.warning(f"[get_file_content] Failed to decode {file_path}: {e}")
        return None


def find_and_replace_in_file(org: str, repo: str, file_path: str) -> Optional[Tuple[str, str]]:
    """Find and replace text in a file. Returns (old_content, new_content) if changes needed."""
    content = get_file_content(org, repo, file_path)
    if content is None:
        return None
    
    # Check if file contains the target text
    if OLD_TEXT not in content:
        return None
    
    # Replace all instances
    new_content = content.replace(OLD_TEXT, NEW_TEXT)
    
    # Check if any changes were made
    if new_content == content:
        return None
    
    logging.info(f"[find_and_replace_in_file] Found {content.count(OLD_TEXT)} instances in {file_path}")
    return content, new_content


def create_branch(org: str, repo: str, base_branch: str, new_branch: str) -> bool:
    """Create a new branch from the base branch."""
    if DRY_RUN:
        logging.info(f"[create_branch] DRY RUN: Would create branch {new_branch} in {org}/{repo}")
        return True
    
    # Get the SHA of the base branch
    url = f"{BASE_URL}/repos/{org}/{repo}/branches/{base_branch}"
    branch_data = make_cached_request(url, HEADERS)
    if not branch_data:
        logging.error(f"[create_branch] Failed to get base branch {base_branch}")
        return False
    
    base_sha = branch_data["commit"]["sha"]
    
    # Create the new branch
    url = f"{BASE_URL}/repos/{org}/{repo}/git/refs"
    data = {
        "ref": f"refs/heads/{new_branch}",
        "sha": base_sha
    }
    
    response = requests.post(url, headers=HEADERS, json=data)
    if response.status_code == 201:
        logging.info(f"[create_branch] Created branch {new_branch} in {org}/{repo}")
        return True
    elif response.status_code == 422:  # Branch already exists
        logging.info(f"[create_branch] Branch {new_branch} already exists in {org}/{repo}")
        return True
    else:
        logging.error(f"[create_branch] Failed to create branch {new_branch}: {response.status_code} - {response.text}")
        return False


def create_file_commit(org: str, repo: str, file_path: str, content: str, branch: str, message: str) -> bool:
    """Create a commit to update a file."""
    if DRY_RUN:
        logging.info(f"[create_file_commit] DRY RUN: Would update {file_path} in {org}/{repo}")
        return True
    
    # First get the current file to get its SHA
    url = f"{BASE_URL}/repos/{org}/{repo}/contents/{file_path}"
    current_file_data = make_cached_request(url, HEADERS)
    if not current_file_data:
        logging.error(f"[create_file_commit] Failed to get current file data for {file_path}")
        return False
    
    current_sha = current_file_data.get("sha")
    if not current_sha:
        logging.error(f"[create_file_commit] No SHA found for {file_path}")
        return False
    
    # Update the file with the SHA
    data = {
        "message": message,
        "content": base64.b64encode(content.encode("utf-8")).decode("utf-8"),
        "sha": current_sha,
        "branch": branch
    }
    
    response = requests.put(url, headers=HEADERS, json=data)
    if response.status_code in [200, 201]:
        logging.info(f"[create_file_commit] Updated {file_path} in {org}/{repo}")
        return True
    else:
        logging.error(f"[create_file_commit] Failed to update {file_path}: {response.status_code} - {response.text}")
        return False


def check_existing_pr(org: str, repo: str, title: str) -> Optional[str]:
    """Check if there's already an open PR with the same title. Returns PR URL if found, None otherwise."""
    url = f"{BASE_URL}/repos/{org}/{repo}/pulls?state=open&per_page=100"
    
    # Don't use cache for PR checks since PR status can change quickly
    logging.info(f"[check_existing_pr] Making direct request to check PRs for {org}/{repo}")
    try:
        response = requests.get(url, headers=HEADERS)
        response.raise_for_status()
        data = response.json()
        
        for pr in data:
            if pr.get("title") == title:
                pr_url = pr['html_url']
                logging.info(f"[check_existing_pr] Found existing open PR with same title in {org}/{repo}: {pr_url}")
                return pr_url
        
        logging.info(f"[check_existing_pr] No existing PR found for {org}/{repo}")
        return None
        
    except requests.exceptions.RequestException as e:
        logging.warning(f"[check_existing_pr] Failed to get PRs for {org}/{repo}: {e}")
        return None
    except json.JSONDecodeError as e:
        logging.warning(f"[check_existing_pr] Failed to parse JSON response for {org}/{repo}: {e}")
        return None


def create_pull_request(org: str, repo: str, branch: str, base_branch: str) -> Optional[str]:
    """Create a pull request and return the PR URL."""
    if DRY_RUN:
        logging.info(f"[create_pull_request] DRY RUN: Would create PR for {org}/{repo}")
        return "DRY_RUN_PR_URL"
    
    url = f"{BASE_URL}/repos/{org}/{repo}/pulls"
    data = {
        "title": f"[EZ] Replace `pytorch-labs` with `meta-pytorch`",
        "body": f"""This PR replaces all instances of `pytorch-labs` with `meta-pytorch` in this repository now that the `pytorch-labs` org has been renamed to `meta-pytorch`

## Changes Made
- Replaced all occurrences of `pytorch-labs` with `meta-pytorch`
- Only modified files with extensions: .py, .md, .sh, .rst, .cpp, .h, .txt, .yml
- Skipped binary files and files larger than 1MB due to GitHub api payload limits in the script to cover all repos in this org. Will do a more manual second pass later to cover any larger files

## Files Modified
This PR updates files that contained the target text.

Generated by automated script on {datetime.now(timezone.utc).isoformat()}Z""",
        "head": branch,
        "base": base_branch
    }
    
    response = requests.post(url, headers=HEADERS, json=data)
    if response.status_code == 201:
        pr_data = response.json()
        pr_url = pr_data["html_url"]
        logging.info(f"[create_pull_request] Created PR: {pr_url}")
        return pr_url
    else:
        logging.error(f"[create_pull_request] Failed to create PR: {response.status_code} - {response.text}")
        return None


def process_repository(org: str, repo: str) -> Dict:
    """Process a single repository for text replacement."""
    logging.info(f"[process_repository] Processing repository: {org}/{repo}")
    
    result = {
        "repo": repo,
        "status": "skipped",
        "files_changed": 0,
        "pr_url": None,
        "error": None
    }
    
    try:
        # Check for existing PR first (before doing any work)
        pr_title = f"[EZ] Replace `pytorch-labs` with `meta-pytorch`"
        existing_pr_url = check_existing_pr(org, repo, pr_title)
        if existing_pr_url:
            result["status"] = "skipped_existing_pr"
            result["pr_url"] = existing_pr_url
            result["error"] = "Existing open PR with same title found"
            logging.info(f"[process_repository] Skipping {org}/{repo} - existing open PR found: {existing_pr_url}")
            return result
        
        # Get default branch
        default_branch = get_default_branch(org, repo)
        if not default_branch:
            result["error"] = "Failed to get default branch"
            return result
        
        # Get target files for this repository
        target_files = get_target_files_for_repo(org, repo)
        if not target_files:
            logging.info(f"[process_repository] No target files found for {org}/{repo}")
            return result
        
        # Check each target file for replacements
        changes = []
        for file_path in target_files:
            replacement = find_and_replace_in_file(org, repo, file_path)
            if replacement:
                old_content, new_content = replacement
                changes.append({
                    "path": file_path,
                    "old_content": old_content,
                    "new_content": new_content
                })
        
        if not changes:
            logging.info(f"[process_repository] No changes needed in {org}/{repo}")
            return result
        
        result["files_changed"] = len(changes)
        logging.info(f"[process_repository] Found {len(changes)} files to update in {org}/{repo}")
        
        if DRY_RUN:
            result["status"] = "dry_run"
            logging.info(f"[process_repository] DRY RUN: Would update {len(changes)} files in {org}/{repo}")
            return result
        
        # Create new branch
        branch_name = f"replace-pytorch-labs-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
        if not create_branch(org, repo, default_branch, branch_name):
            result["error"] = "Failed to create branch"
            return result
        
        # Commit changes
        commit_message = f"Replace 'pytorch-labs' with 'meta-pytorch' in {len(changes)} files"
        all_success = True
        
        for change in changes:
            if not create_file_commit(org, repo, change["path"], change["new_content"], branch_name, commit_message):
                all_success = False
                break
        
        if not all_success:
            result["error"] = "Failed to commit some files"
            return result
        
        # Create pull request
        pr_url = create_pull_request(org, repo, branch_name, default_branch)
        if pr_url:
            result["pr_url"] = pr_url
            result["status"] = "success"
        else:
            result["error"] = "Failed to create pull request"
        
    except Exception as e:
        logging.error(f"[process_repository] Error processing {org}/{repo}: {e}")
        result["error"] = str(e)
    
    return result


def main():
    parser = argparse.ArgumentParser(
        description="Replace 'pytorch-labs' with 'meta-pytorch' across GitHub organization repositories."
    )
    parser.add_argument(
        "--org",
        type=str,
        default="pytorch",
        help="GitHub organization to process (default: pytorch)",
    )
    parser.add_argument(
        "--repos",
        type=str,
        help="Comma-separated list of repositories to process (e.g., 'pytorch,vision,tutorials'). If not specified, processes all repositories with target files.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview changes without making them",
    )
    args = parser.parse_args()

    global ORG_NAME, DRY_RUN
    ORG_NAME = args.org
    DRY_RUN = args.dry_run

    # Parse repos filter if provided
    filter_repos = None
    if args.repos:
        filter_repos = [repo.strip() for repo in args.repos.split(",")]
        logging.info(f"[main] Repository filter applied: {filter_repos}")

    if not GITHUB_TOKEN:
        logging.error("[main] Missing GITHUB_TOKEN in environment variables.")
        return

    logging.info(f"[main] Starting text replacement for org: {ORG_NAME}")
    if DRY_RUN:
        logging.info("[main] DRY RUN MODE - No changes will be made")

    # Show cache stats at start
    cache_stats = get_cache_stats()
    logging.info(
        f"[main] Cache stats: {cache_stats['total_files']} files, {cache_stats['total_size_mb']} MB"
    )

    # Get target repositories (only those with files containing "pytorch-labs")
    repos = get_target_repos(ORG_NAME, filter_repos)
    logging.info(f"[main] Processing {len(repos)} repositories with target files")

    # Process each repository
    results = []
    for i, repo in enumerate(repos, 1):
        logging.info(f"[main] Processing repository {i}/{len(repos)}: {repo}")
        result = process_repository(ORG_NAME, repo)
        results.append(result)
        
        # Add a small delay to be respectful to the API
        import time
        time.sleep(1)

    # Generate summary
    successful = [r for r in results if r["status"] == "success"]
    dry_run = [r for r in results if r["status"] == "dry_run"]
    skipped = [r for r in results if r["status"] == "skipped"]
    skipped_existing_pr = [r for r in results if r["status"] == "skipped_existing_pr"]
    errors = [r for r in results if r["error"] and r["status"] not in ["skipped_existing_pr"]]

    print(f"\n=== SUMMARY ===")
    print(f"Organization: {ORG_NAME}")
    print(f"Total repositories: {len(repos)}")
    print(f"Successful PRs created: {len(successful)}")
    print(f"Dry run (would create): {len(dry_run)}")
    print(f"Skipped (no changes): {len(skipped)}")
    print(f"Skipped (existing PR): {len(skipped_existing_pr)}")
    print(f"Errors: {len(errors)}")
    print("\n")
    
    if skipped_existing_pr:
        print(f"=== SKIPPED (existing PRs) ===")
        for result in skipped_existing_pr:
            print(f"- {result['repo']}: {result['files_changed']} files would be updated, but existing PR found: {result['pr_url']}")
        print("\n")

    if successful:
        print(f"=== SUCCESSFUL PRs ===")
        for result in successful:
            print(f"- {result['repo']}: {result['pr_url']} ({result['files_changed']} files)")
        print("\n")

    if dry_run:
        print(f"=== DRY RUN (would create PRs) ===")
        for result in dry_run:
            print(f"- {result['repo']}: {result['files_changed']} files would be updated")
        print("\n")

    if errors:
        print(f"=== ERRORS ===")
        for result in errors:
            print(f"- {result['repo']}: {result['error']}")
        print("\n")

    # Show final cache stats
    final_cache_stats = get_cache_stats()
    logging.info(
        f"[main] Final cache stats: {final_cache_stats['total_files']} files, {final_cache_stats['total_size_mb']} MB"
    )

    logging.info("[main] Script completed successfully.")


if __name__ == "__main__":
    main() 