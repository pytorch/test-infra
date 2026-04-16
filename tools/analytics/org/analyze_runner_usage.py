"""
GitHub Organization Runner Label Analyzer
=========================================

Purpose:
--------
This script analyzes the usage of GitHub Actions runner labels across all repositories in a specified GitHub organization. It collects data on which runner labels are used in workflows, which repositories use which runners, and highlights runners that are not defined in your scale-config.yml or are not standard GitHub-hosted runners.

Key Features:
-------------
- Fetches all non-archived repositories in a GitHub organization (excluding a configurable list).
- For each repository, fetches recent workflow runs and extracts the runner labels used in jobs.
- Aggregates runner label usage across repositories, including last usage and workflow file.
- Compares runner labels against those defined in scale-config.yml and standard GitHub runners.
- Outputs a YAML summary (reports/runner_labels_summary.yml) with detailed runner usage, repos by runner, and special groupings (e.g., runners not in scale-config, repos with zero workflow runs).
- Caches GitHub API responses for efficiency and rate limit avoidance.

How to Run:
-----------
1. Ensure you have Python 3.9+ and install dependencies (see below).
2. Set the following environment variable (can be in a .env file):
   - `GITHUB_TOKEN`: A GitHub personal access token with `repo` and `actions` read permissions.
3. (Optional) Edit the EXCLUDED_REPOS and GITHUB_RUNNER_LABELS lists in the script to customize exclusions.
4. (Optional) The script will automatically download `scale-config.yml` from a URL if not present locally. You can specify the URL with the `--scale-config-url` argument (defaults to the pytorch/test-infra main branch).
5. Run the script:

   ```bash
   python analyze_runner_usage.py [--org ORG_NAME] [--scale-config-url URL]
   ```
   - Use `--org` to specify the GitHub organization to analyze (defaults to 'pytorch').
   - Use `--scale-config-url` to specify a custom URL for scale-config.yml if needed.

Dependencies:
-------------
- requests
- pyyaml
- python-dotenv

Output:
-------
- `reports/runner_labels_summary.yml`: A YAML file containing:
    - `runners_used`: For each runner label, a list of repos, last usage, and workflow file.
    - `repo_runners`: For each repo, a list of runner labels it uses.
    - `repositories_with_zero_workflow_runs`: Repos with no workflow runs in the lookback period.
    - `runners_not_in_scale_config_or_github`: Runners used but not in scale-config or standard GitHub runners.
    - `repos_by_github_runner`: Which repos use each standard GitHub runner label.
- Caches API responses in the `cache/` directory for faster reruns.

Notes:
------
- The script looks back 180 days for workflow runs.
- The script is safe to rerun; it uses caching to avoid redundant API calls.
- For large orgs, the script may take a while on the first run due to API rate limits.

"""

import argparse
import logging
import os
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional

import requests
import yaml
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

# GitHub API headers
HEADERS = {
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
}

# List of repositories to exclude in the format 'org/repo'
EXCLUDED_REPOS = [
    "pytorch/pytorch",
    "pytorch/executorch",
    "pytorch/test-infra",
    "pytorch/ci-infra",
    "pytorch/pytorch-canary",
    "pytorch/tutorials",
    "pytorch/docs",
    "pytorch/cppdocs",
    "pytorch/pytorch.github.io",
    "pytorch/examples",
    # archived but not marked as such in github repo settings
    "pytorch/serve",
    # proposed
    "pytorch/builder",
    "pytorch/xla",
    "pytorch/benchmark",
    "pytorch/pytorch-integration-testing",
]

# List of runner labels to exclude from "runners not in scale-config" analysis
# These are typically GitHub-hosted runners or other known external runners
GITHUB_RUNNER_LABELS = [
    "ubuntu-latest",
    "ubuntu-22.04",
    "ubuntu-24.04",
    "ubuntu-20.04",
    "ubuntu-18.04",
    "windows-latest",
    "windows-2022",
    "macos-latest",
    "macos-14",
    "macos-14-xlarge",
    "macos-13",
    "macos-12",
    # Offered at Meta enterprise level
    "8-core-ubuntu",
    "4-core-ubuntu",
    "windows-8-core",
    "4-core-ubuntu-gpu-t4",
    "4-core-windows-gpu-t4",
    "32-core-ubuntu",
    "16-core-ubuntu",
    "2-core-ubuntu-arm",
    "4-core-ubuntu-arm",
    "8-core-ubuntu-22.04",
    "4-core-ubuntu-24.04",
    # needs special access
    "linux.24_04.4x",
    "linux.24_04.16x",
    "windows-11-arm64",
    # Add more runner labels to exclude here as needed
]

USELESS_RUNNER_LABELS = [
    "self-hosted",  # really, a useless label we want to ignore
    "linux.g5.4xlarge.nvidia.cpu",  # a nonexistent label used by a repo
]

BASE_URL = "https://api.github.com"
WORKFLOW_RUN_LOOKBACK = (datetime.utcnow() - timedelta(days=180)).isoformat() + "Z"


def get_repos(org: str) -> List[str]:
    logging.info(f"[get_repos] Start fetching repositories for org: {org}")
    repos = []
    page = 1
    while True:
        url = f"{BASE_URL}/orgs/{org}/repos?per_page=100&page={page}"
        logging.debug(f"[get_repos] Requesting URL: {url}")
        data = make_cached_request(url, HEADERS)
        if data is None:
            logging.error(f"[get_repos] Failed to fetch page {page} for org: {org}")
            break
        if not data:
            logging.info(
                f"[get_repos] No more repositories found on page {page} for org: {org}"
            )
            break
        logging.info(
            f"[get_repos] Page {page}: Found {len(data)} repositories for org: {org}"
        )
        # Filter out archived repositories
        non_archived_repos = [
            repo["name"] for repo in data if not repo.get("archived", False)
        ]
        repos.extend(non_archived_repos)
        logging.info(
            f"[get_repos] Page {page}: Excluded {len(data) - len(non_archived_repos)} archived repositories"
        )
        page += 1
    logging.info(
        f"[get_repos] Finished fetching repositories for org: {org}. Total: {len(repos)} (excluding archived)"
    )
    return repos


def get_workflow_runs(org: str, repo: str) -> List[Dict]:
    logging.info(
        f"[get_workflow_runs] Start fetching workflow runs for repo: {repo} in org: {org}"
    )
    all_runs = []
    page = 1
    while True:
        url = f"{BASE_URL}/repos/{org}/{repo}/actions/runs?per_page=100&page={page}&created=>={WORKFLOW_RUN_LOOKBACK}"
        logging.debug(f"[get_workflow_runs] Requesting URL: {url}")
        response_data = make_cached_request(url, HEADERS)
        if response_data is None:
            logging.error(
                f"[get_workflow_runs] Failed to fetch page {page} for repo: {repo}"
            )
            break
        data = response_data.get("workflow_runs", [])
        if not data:
            logging.info(
                f"[get_workflow_runs] No more workflow runs found for repo: {repo} on page {page}"
            )
            break
        logging.info(
            f"[get_workflow_runs] Page {page}: Found {len(data)} workflow runs for repo: {repo}"
        )
        all_runs.extend(data)
        page += 1

    # --- FILTERING LOGIC START ---
    filtered_runs = []
    for run in all_runs:
        repo_full_name = run.get("repository", {}).get("full_name", "")
        actor_login = run.get("actor", {}).get("login", "")
        triggering_actor_login = run.get("triggering_actor", {}).get("login", "")
        run_id = run.get("id")
        html_url = run.get("html_url")
        # Only runs on the original repo (not forks)
        if repo_full_name != f"{org}/{repo}":
            logging.info(
                f"[FILTERED] Reason: forked repo | Run ID: {run_id} | URL: {html_url}"
            )
            continue
        # Exclude dependabot runs
        if actor_login == "dependabot[bot]":
            logging.info(
                f"[FILTERED] Reason: dependabot actor | Run ID: {run_id} | URL: {html_url}"
            )
            continue
        if triggering_actor_login == "dependabot[bot]":
            logging.info(
                f"[FILTERED] Reason: dependabot triggering_actor | Run ID: {run_id} | URL: {html_url}"
            )
            continue
        filtered_runs.append(run)
    # --- FILTERING LOGIC END ---

    # Group runs by workflow path and keep only the latest run for each workflow
    workflow_latest_runs: Dict[str, Dict] = {}
    for run in filtered_runs:
        workflow_path = run.get("path", "unknown")
        created_at = run["created_at"]

        # Keep the run with the latest created_at timestamp for each workflow
        if (
            workflow_path not in workflow_latest_runs
            or created_at > workflow_latest_runs[workflow_path]["created_at"]
        ):
            workflow_latest_runs[workflow_path] = run

    # Convert back to list
    latest_runs = list(workflow_latest_runs.values())

    logging.info(
        f"[get_workflow_runs] Finished fetching workflow runs for repo: {repo}. Total runs fetched: {len(all_runs)}, unique workflows: {len(latest_runs)} (after filtering: {len(filtered_runs)})"
    )
    return latest_runs


def get_jobs_for_run(
    org: str,
    repo: str,
    run_id: int,
    run_index: Optional[int] = None,
    total_runs: Optional[int] = None,
) -> List[Dict]:
    run_info = (
        f"({run_index}/{total_runs})"
        if run_index is not None and total_runs is not None
        else ""
    )
    logging.info(
        f"[get_jobs_for_run] Start fetching jobs for run {run_id} in repo: {repo} (org: {org}) {run_info}"
    )
    url = f"{BASE_URL}/repos/{org}/{repo}/actions/runs/{run_id}/jobs"
    logging.debug(f"[get_jobs_for_run] Requesting URL: {url}")
    response_data = make_cached_request(url, HEADERS)
    if response_data is None:
        logging.error(
            f"[get_jobs_for_run] Failed to fetch jobs for run {run_id} in repo: {repo}"
        )
        return []
    jobs = response_data.get("jobs", [])
    logging.info(
        f"[get_jobs_for_run] Finished fetching jobs for run {run_id} in repo: {repo} {run_info}. Found: {len(jobs)} jobs."
    )
    return jobs


def get_all_repo_runs(
    org: str, repos: List[str]
) -> tuple[Dict[str, List[Dict]], List[str]]:
    """
    Step 1: Get all workflow runs for each repository.

    Args:
        org: The GitHub organization name
        repos: List of repository names

    Returns:
        Tuple of (Dictionary mapping repo names to their workflow runs, List of repos with zero runs)
    """
    logging.info(
        f"[get_all_repo_runs] Start fetching workflow runs for {len(repos)} repositories in org: {org}"
    )
    repo_runs = {}
    repos_with_zero_runs = []

    for repo in repos:
        logging.info(f"[get_all_repo_runs] Processing repo: {repo}")
        runs = get_workflow_runs(org, repo)
        repo_runs[repo] = runs
        if len(runs) == 0:
            repos_with_zero_runs.append(repo)
        logging.info(f"[get_all_repo_runs] Found {len(runs)} runs for repo: {repo}")

    logging.info(f"[get_all_repo_runs] Finished fetching workflow runs for org: {org}")
    logging.info(
        f"[get_all_repo_runs] Found {len(repos_with_zero_runs)} repositories with zero workflow runs"
    )
    return repo_runs, repos_with_zero_runs


def process_repo_runs(
    org: str, repo_runs: Dict[str, List[Dict]]
) -> Dict[str, List[Dict]]:
    """
    Step 2: Process workflow runs and collect runner labels.

    Args:
        org: The GitHub organization name
        repo_runs: Dictionary mapping repo names to their workflow runs

    Returns:
        Dictionary mapping runner labels to their usage information
    """
    logging.info(
        f"[process_repo_runs] Start processing workflow runs for {len(repo_runs)} repositories in org: {org}"
    )
    label_map: defaultdict[str, List[Dict]] = defaultdict(list)

    for repo, runs in repo_runs.items():
        logging.info(
            f"[process_repo_runs] Processing {len(runs)} runs for repo: {repo}"
        )
        total_runs = len(runs)

        for run_index, run in enumerate(runs, 1):
            run_id = run["id"]
            created_at = run["created_at"]
            workflow_name = run.get("path", "unknown")

            try:
                jobs = get_jobs_for_run(org, repo, run_id, run_index, total_runs)
                for job in jobs:
                    for label in job.get("labels", []):
                        existing = next(
                            (item for item in label_map[label] if item["repo"] == repo),
                            None,
                        )
                        if existing:
                            if created_at > existing["last_used"]:
                                logging.debug(
                                    f"[process_repo_runs] Updating last_used for label '{label}' in repo '{repo}' to {created_at} (was {existing['last_used']})"
                                )
                                existing["last_used"] = created_at
                                existing["workflow_file"] = workflow_name
                        else:
                            logging.debug(
                                f"[process_repo_runs] Adding new label '{label}' for repo '{repo}' (created_at: {created_at}, workflow: {workflow_name})"
                            )
                            label_map[label].append(
                                {
                                    "repo": repo,
                                    "last_used": created_at,
                                    "workflow_file": workflow_name,
                                }
                            )
            except Exception as e:
                logging.error(
                    f"[process_repo_runs] Failed to fetch jobs for run {run_id} in {repo}: {e}"
                )

    logging.info(
        f"[process_repo_runs] Finished processing workflow runs for org: {org}"
    )
    return label_map


def save_to_yaml(data: Dict, filename: str = "runner_labels_summary.yml"):
    # Create reports directory if it doesn't exist
    reports_dir = "reports"
    os.makedirs(reports_dir, exist_ok=True)

    # Build full path with reports directory
    filepath = os.path.join(reports_dir, filename)
    logging.info(f"[save_to_yaml] Saving runner label data to {filepath}")

    # Convert defaultdict to regular dict to avoid YAML serialization issues
    if hasattr(data, "default_factory"):
        data = dict(data)
    with open(filepath, "w") as f:
        yaml.dump(data, f, sort_keys=False)
    logging.info(f"[save_to_yaml] Data successfully saved to {filepath}")


def download_scale_config(url: str, dest: str = "scale-config.yml") -> bool:
    """Download scale-config.yml from the given URL if it does not exist locally."""
    if os.path.exists(dest):
        logging.info(
            f"[download_scale_config] {dest} already exists, skipping download."
        )
        return True
    try:
        logging.info(f"[download_scale_config] Downloading scale-config.yml from {url}")
        response = requests.get(url)
        response.raise_for_status()
        with open(dest, "w") as f:
            f.write(response.text)
        logging.info(
            f"[download_scale_config] Successfully downloaded scale-config.yml to {dest}"
        )
        return True
    except Exception as e:
        logging.error(
            f"[download_scale_config] Failed to download scale-config.yml: {e}"
        )
        return False


def main():
    parser = argparse.ArgumentParser(
        description="Analyze GitHub org runner label usage."
    )
    parser.add_argument(
        "--org",
        type=str,
        default="pytorch",
        help="GitHub organization to analyze (default: pytorch)",
    )
    parser.add_argument(
        "--scale-config-url",
        type=str,
        default="https://raw.githubusercontent.com/pytorch/test-infra/refs/heads/main/.github/scale-config.yml",
        help="URL to download scale-config.yml if not present locally.",
    )
    args = parser.parse_args()

    global ORG_NAME
    ORG_NAME = args.org
    scale_config_url = args.scale_config_url
    download_scale_config(scale_config_url)

    if not GITHUB_TOKEN:
        logging.error("[main] Missing GITHUB_TOKEN in environment variables.")
        return

    logging.info(f"[main] Starting analysis for org: {ORG_NAME}")

    # Show cache stats at start
    cache_stats = get_cache_stats()
    logging.info(
        f"[main] Cache stats: {cache_stats['total_files']} files, {cache_stats['total_size_mb']} MB"
    )

    repos = get_repos(ORG_NAME)
    # Exclude repositories listed in EXCLUDED_REPOS before any further processing
    print(f"Repos found: {repos}")
    filtered_repos = [
        repo for repo in repos if f"{ORG_NAME}/{repo}" not in EXCLUDED_REPOS
    ]

    # Step 1: Get all runs for each repo
    repo_runs, repos_with_zero_runs = get_all_repo_runs(ORG_NAME, filtered_repos)

    # Step 2: Process the runs and collect labels
    label_data = process_repo_runs(ORG_NAME, repo_runs)

    # Create repo_runners section (inverse of label_data)
    repo_runners = defaultdict(list)
    for runner_label, repos_info in label_data.items():
        for repo_info in repos_info:
            repo_name = repo_info["repo"]
            if runner_label not in repo_runners[repo_name]:
                repo_runners[repo_name].append(runner_label)

    # Check for runners not in scale-config.yml
    scale_config_runners = set()
    try:
        with open("scale-config.yml", "r") as f:
            scale_config = yaml.safe_load(f)
            if scale_config and "runner_types" in scale_config:
                scale_config_runners = set(scale_config["runner_types"].keys())
    except (FileNotFoundError, yaml.YAMLError) as e:
        logging.warning(f"[main] Could not read scale-config.yml: {e}")

    # Find runners not in scale-config (excluding known external runners)
    all_runner_labels = set(label_data.keys())
    runners_not_in_scale_config_or_github = (
        all_runner_labels
        - scale_config_runners
        - set(GITHUB_RUNNER_LABELS)
        - set(USELESS_RUNNER_LABELS)
    )

    # Group repos by runners not in scale-config
    repos_by_undefined_runner = defaultdict(list)
    for runner_label in runners_not_in_scale_config_or_github:
        for repo_info in label_data[runner_label]:
            repo_name = repo_info["repo"]
            if repo_name not in repos_by_undefined_runner[runner_label]:
                repos_by_undefined_runner[runner_label].append(repo_name)

    github_runners = set(GITHUB_RUNNER_LABELS)
    # Group repos by github runners
    repos_by_github_runner = defaultdict(list)
    for runner_label in github_runners:
        for repo_info in label_data[runner_label]:
            repo_name = repo_info["repo"]
            if repo_name not in repos_by_github_runner[runner_label]:
                repos_by_github_runner[runner_label].append(repo_name)

        # Restructure the data for better YAML organization
        output_data = {
            "runners_used": dict(label_data),
            "repo_runners": dict(repo_runners),
        }

        # Add repositories with zero workflow runs to the output
        if repos_with_zero_runs:
            output_data["repositories_with_zero_workflow_runs"] = repos_with_zero_runs

        # Add runners not in scale-config to the output
        if repos_by_undefined_runner:
            output_data["runners_not_in_scale_config_or_github"] = dict(
                repos_by_undefined_runner
            )

        if repos_by_github_runner:
            output_data["repos_by_github_runner"] = dict(repos_by_github_runner)

        # --- SORT OUTPUT ALPHABETICALLY FOR CONSISTENCY (except top-level keys) ---
        def deep_sort(obj, sort_keys=True):
            if isinstance(obj, dict):
                keys = sorted(obj) if sort_keys else obj.keys()
                return {k: deep_sort(obj[k]) for k in keys}
            elif isinstance(obj, list):
                # If list of dicts with 'repo' key, sort by 'repo', else sort normally
                if obj and isinstance(obj[0], dict) and "repo" in obj[0]:
                    return sorted([deep_sort(x) for x in obj], key=lambda x: x["repo"])
                return sorted(deep_sort(x) for x in obj)
            else:
                return obj

        output_data = deep_sort(output_data, sort_keys=False)
        save_to_yaml(output_data)

        # Show final cache stats
        final_cache_stats = get_cache_stats()
        logging.info(
            f"[main] Final cache stats: {final_cache_stats['total_files']} files, {final_cache_stats['total_size_mb']} MB"
        )
        logging.info("[main] Script completed successfully.")


if __name__ == "__main__":
    main()
