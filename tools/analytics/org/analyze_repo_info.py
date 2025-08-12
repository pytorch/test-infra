"""
GitHub Organization Repository Information Analyzer
==================================================

Purpose:
--------
This script analyzes all repositories in a specified GitHub organization and outputs a CSV file with key repository information including visibility, archived status, and last commit date.

Key Features:
-------------
- Fetches all repositories in a GitHub organization (including archived ones).
- Collects repository metadata including visibility, archived status, and last commit date.
- Outputs a CSV file with repository information for easy analysis.
- Caches GitHub API responses for efficiency and rate limit avoidance.

How to Run:
-----------
1. Ensure you have Python 3.9+ and install dependencies (see below).
2. Set the following environment variable (can be in a .env file):
   - `GITHUB_TOKEN`: A GitHub personal access token with `repo` read permissions.
3. Run the script:

   ```bash
   python analyze_repo_info.py [--org ORG_NAME]
   ```
   - Use `--org` to specify the GitHub organization to analyze (defaults to 'pytorch').

Dependencies:
-------------
- requests
- python-dotenv
- csv (built-in)

Output:
-------
- `reports/repo_info_summary.csv`: A CSV file containing:
    - Repo name (in org/repo format)
    - Public (True if public, False if Private)
    - Archived (True if archived, else False)
    - Last commit date (date repo was last committed to, in YYYY-MM-DD format)
- Caches API responses in the `cache/` directory for faster reruns.

Notes:
------
- The script is safe to rerun; it uses caching to avoid redundant API calls.
- For large orgs, the script may take a while on the first run due to API rate limits.
"""

import argparse
import csv
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

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

# GitHub API headers
HEADERS = {
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
}

BASE_URL = "https://api.github.com"


def get_repos_with_info(org: str) -> List[Dict]:
    """
    Fetch all repositories for an organization with their metadata.
    
    Args:
        org: The GitHub organization name
        
    Returns:
        List of repository dictionaries with metadata
    """
    logging.info(f"[get_repos_with_info] Start fetching repositories for org: {org}")
    repos = []
    page = 1
    while True:
        url = f"{BASE_URL}/orgs/{org}/repos?per_page=100&page={page}"
        logging.debug(f"[get_repos_with_info] Requesting URL: {url}")
        data = make_cached_request(url, HEADERS)
        if data is None:
            logging.error(f"[get_repos_with_info] Failed to fetch page {page} for org: {org}")
            break
        if not data:
            logging.info(
                f"[get_repos_with_info] No more repositories found on page {page} for org: {org}"
            )
            break
        logging.info(
            f"[get_repos_with_info] Page {page}: Found {len(data)} repositories for org: {org}"
        )
        repos.extend(data)
        page += 1
    logging.info(
        f"[get_repos_with_info] Finished fetching repositories for org: {org}. Total: {len(repos)}"
    )
    return repos


def get_last_commit_date(org: str, repo: str) -> Optional[str]:
    """
    Get the date of the last commit for a repository.
    
    Args:
        org: The GitHub organization name
        repo: The repository name
        
    Returns:
        Date string in YYYY-MM-DD format of the last commit, or None if no commits found
    """
    logging.info(f"[get_last_commit_date] Getting last commit date for repo: {repo}")
    url = f"{BASE_URL}/repos/{org}/{repo}/commits?per_page=1"
    logging.debug(f"[get_last_commit_date] Requesting URL: {url}")
    data = make_cached_request(url, HEADERS)
    if data is None or not data:
        logging.warning(f"[get_last_commit_date] No commits found for repo: {repo}")
        return None
    
    if len(data) > 0:
        commit_date = data[0]["commit"]["author"]["date"]
        # Convert ISO format to YYYY-MM-DD format
        try:
            from datetime import datetime
            dt = datetime.fromisoformat(commit_date.replace('Z', '+00:00'))
            formatted_date = dt.strftime('%Y-%m-%d')
            logging.info(f"[get_last_commit_date] Last commit date for {repo}: {formatted_date}")
            return formatted_date
        except (ValueError, AttributeError) as e:
            logging.warning(f"[get_last_commit_date] Failed to parse date for {repo}: {e}")
            return None
    
    return None


def process_repo_data(org: str, repos: List[Dict]) -> List[Dict]:
    """
    Process repository data and add last commit date information.
    
    Args:
        org: The GitHub organization name
        repos: List of repository dictionaries from GitHub API
        
    Returns:
        List of processed repository data with all required fields
    """
    logging.info(f"[process_repo_data] Processing {len(repos)} repositories")
    processed_repos = []
    
    for i, repo in enumerate(repos, 1):
        repo_name = repo["name"]
        logging.info(f"[process_repo_data] Processing repo {i}/{len(repos)}: {repo_name}")
        
        # Get last commit date
        last_commit_date = get_last_commit_date(org, repo_name)
        
        processed_repo = {
            "repo_name": f"{org}/{repo_name}",
            "public": repo.get("private", True) == False,  # True if public, False if private
            "archived": repo.get("archived", False),
            "last_commit_date": last_commit_date
        }
        
        processed_repos.append(processed_repo)
    
    logging.info(f"[process_repo_data] Finished processing {len(processed_repos)} repositories")
    return processed_repos


def save_to_csv(data: List[Dict], filename: str = "repo_info_summary.csv"):
    """
    Save repository data to a CSV file.
    
    Args:
        data: List of repository dictionaries
        filename: Name of the CSV file to create
    """
    # Create reports directory if it doesn't exist
    reports_dir = "reports"
    os.makedirs(reports_dir, exist_ok=True)

    # Build full path with reports directory
    filepath = os.path.join(reports_dir, filename)
    logging.info(f"[save_to_csv] Saving repository data to {filepath}")

    # Define CSV headers
    fieldnames = ["repo_name", "public", "archived", "last_commit_date"]
    
    with open(filepath, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(data)
    
    logging.info(f"[save_to_csv] Data successfully saved to {filepath}")


def main():
    parser = argparse.ArgumentParser(
        description="Analyze GitHub org repository information."
    )
    parser.add_argument(
        "--org",
        type=str,
        default="pytorch",
        help="GitHub organization to analyze (default: pytorch)",
    )
    args = parser.parse_args()

    global ORG_NAME
    ORG_NAME = args.org

    if not GITHUB_TOKEN:
        logging.error("[main] Missing GITHUB_TOKEN in environment variables.")
        return

    logging.info(f"[main] Starting analysis for org: {ORG_NAME}")

    # Show cache stats at start
    cache_stats = get_cache_stats()
    logging.info(
        f"[main] Cache stats: {cache_stats['total_files']} files, {cache_stats['total_size_mb']} MB"
    )

    # Step 1: Get all repositories with their metadata
    repos = get_repos_with_info(ORG_NAME)
    
    # Step 2: Process repository data and add last commit dates
    processed_repos = process_repo_data(ORG_NAME, repos)
    
    # Step 3: Save to CSV
    save_to_csv(processed_repos)

    # Show final cache stats
    final_cache_stats = get_cache_stats()
    logging.info(
        f"[main] Final cache stats: {final_cache_stats['total_files']} files, {final_cache_stats['total_size_mb']} MB"
    )
    logging.info("[main] Script completed successfully.")


if __name__ == "__main__":
    main() 