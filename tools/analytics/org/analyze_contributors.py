"""
GitHub Organization Contributor Analyzer
========================================

Purpose:
--------
This script analyzes contributors across all repositories in a specified GitHub organization over the past 6 months.
It identifies frequent contributors and attempts to determine their company affiliations based on email addresses
and GitHub profile information.

Key Features:
-------------
- Fetches all non-archived repositories in a GitHub organization (excluding a configurable list).
- For each repository, analyzes commits from the past 6 months to identify contributors.
- Extracts contributor information including email addresses and GitHub profiles.
- Attempts to identify company affiliations from email domains and GitHub profile data.
- Aggregates contributor statistics across repositories.
- Outputs a YAML summary (reports/contributors_summary.yml) with detailed contributor analysis.
- Caches GitHub API responses for efficiency and rate limit avoidance.

How to Run:
-----------
1. Ensure you have Python 3.9+ and install dependencies (see below).
2. Set the following environment variable (can be in a .env file):
   - `GITHUB_TOKEN`: A GitHub personal access token with `repo` and `user` read permissions.
3. (Optional) Edit the EXCLUDED_REPOS list in the script to customize exclusions.
4. Run the script:

   ```bash
   python analyze_contributors.py [--org ORG_NAME]
   ```
   - Use `--org` to specify the GitHub organization to analyze (defaults to 'pytorch').

Dependencies:
-------------
- requests
- pyyaml
- python-dotenv

Output:
-------
- `reports/contributors_summary.yml`: A YAML file containing:
    - `contributors_by_frequency`: Contributors sorted by commit count across all repos.
    - `contributors_by_repo`: For each repo, list of contributors with their stats.
    - `company_analysis`: Contributors grouped by identified companies.
    - `unidentified_contributors`: Contributors without identifiable company affiliation.
- Caches API responses in the `cache/` directory for faster reruns.

Notes:
------
- The script looks back 6 months for commits.
- Company identification is based on email domains and GitHub profile information.
- The script is safe to rerun; it uses caching to avoid redundant API calls.
- For large orgs, the script may take a while on the first run due to API rate limits.

"""

import argparse
import logging
import os
import re
from collections import defaultdict
from datetime import datetime, timedelta
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

# Company domains mapping
COMPANY_DOMAINS = {
    "meta.com": "Meta",
    "fb.com": "Meta",
    "facebook.com": "Meta",
    "google.com": "Google",
    "microsoft.com": "Microsoft",
    "nvidia.com": "NVIDIA",
    "intel.com": "Intel",
    "amd.com": "AMD",
    "apple.com": "Apple",
    "amazon.com": "Amazon",
    "aws.com": "Amazon",
    "ibm.com": "IBM",
    "redhat.com": "Red Hat",
    "canonical.com": "Canonical",
    "huggingface.co": "Hugging Face",
    "openai.com": "OpenAI",
    "anthropic.com": "Anthropic",
    "deepmind.com": "DeepMind",
    "salesforce.com": "Salesforce",
    "uber.com": "Uber",
    "netflix.com": "Netflix",
    "airbnb.com": "Airbnb",
    "spotify.com": "Spotify",
    "tesla.com": "Tesla",
}

BASE_URL = "https://api.github.com"
COMMIT_LOOKBACK = (datetime.utcnow() - timedelta(days=180)).isoformat() + "Z"  # 6 months


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


def get_commits(org: str, repo: str) -> List[Dict]:
    """Get commits for a repository from the past 6 months."""
    logging.info(f"[get_commits] Start fetching commits for repo: {repo} in org: {org}")
    all_commits = []
    page = 1

    while True:
        url = f"{BASE_URL}/repos/{org}/{repo}/commits?per_page=100&page={page}&since={COMMIT_LOOKBACK}"
        logging.debug(f"[get_commits] Requesting URL: {url}")
        data = make_cached_request(url, HEADERS)
        if data is None:
            logging.error(f"[get_commits] Failed to fetch page {page} for repo: {repo}")
            break
        if not data:
            logging.info(f"[get_commits] No more commits found for repo: {repo} on page {page}")
            break
        logging.info(f"[get_commits] Page {page}: Found {len(data)} commits for repo: {repo}")
        all_commits.extend(data)
        page += 1

        # Limit to reasonable number of commits to avoid API rate limits
        if len(all_commits) >= 1000:
            logging.info(f"[get_commits] Limiting to 1000 commits for repo: {repo}")
            break

    logging.info(f"[get_commits] Finished fetching commits for repo: {repo}. Total: {len(all_commits)}")
    return all_commits


def get_user_profile(username: str) -> Optional[Dict]:
    """Get GitHub user profile information."""
    if not username:
        return None

    url = f"{BASE_URL}/users/{username}"
    logging.debug(f"[get_user_profile] Fetching profile for user: {username}")
    return make_cached_request(url, HEADERS)


def extract_company_from_email(email: str) -> Optional[str]:
    """Extract company name from email domain."""
    if not email or "@" not in email:
        return None

    domain = email.split("@")[1].lower()

    # Check direct domain matches
    if domain in COMPANY_DOMAINS:
        return COMPANY_DOMAINS[domain]

    # Check for subdomains
    for company_domain, company_name in COMPANY_DOMAINS.items():
        if domain.endswith(f".{company_domain}"):
            return company_name

    # Skip generic email providers
    generic_providers = {
        "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
        "protonmail.com", "tutanota.com", "hey.com", "fastmail.com",
        "users.noreply.github.com"  # GitHub's privacy-preserving email addresses
    }

    if domain in generic_providers:
        return None

    # For other domains, try to extract company name
    # Remove common TLDs and subdomains
    domain_parts = domain.replace(".com", "").replace(".org", "").replace(".net", "").split(".")
    if domain_parts and len(domain_parts[-1]) > 2:
        return domain_parts[-1].title()

    return None


def extract_company_from_profile(profile: Dict) -> Optional[str]:
    """Extract company name from GitHub profile."""
    if not profile:
        return None

    company = profile.get("company") or ""
    company = company.strip() if company else ""
    if not company:
        return None

    # Clean up company name
    company = re.sub(r'^@', '', company)  # Remove @ prefix
    company = company.strip()

    if not company:
        return None

    # Map common company variations
    company_mappings = {
        "meta": "Meta",
        "facebook": "Meta",
        "google": "Google",
        "microsoft": "Microsoft",
        "nvidia": "NVIDIA",
        "intel": "Intel",
        "amd": "AMD",
        "apple": "Apple",
        "amazon": "Amazon",
        "aws": "Amazon",
        "ibm": "IBM",
        "red hat": "Red Hat",
        "redhat": "Red Hat",
        "canonical": "Canonical",
        "hugging face": "Hugging Face",
        "huggingface": "Hugging Face",
        "openai": "OpenAI",
        "anthropic": "Anthropic",
        "deepmind": "DeepMind",
        "salesforce": "Salesforce",
        "uber": "Uber",
        "netflix": "Netflix",
        "airbnb": "Airbnb",
        "spotify": "Spotify",
        "tesla": "Tesla",
    }

    company_lower = company.lower()
    if company_lower in company_mappings:
        return company_mappings[company_lower]

    return company.title()


def cache_to_disk(func):
    """
    A decorator that caches the result of a function to disk.
    The cache key is generated from the function name, its arguments, and today's date.
    Handles complex types like lists and dictionaries properly.
    """
    import hashlib
    import json
    import os
    from datetime import date
    from functools import wraps

    def make_hashable(obj):
        """Convert a container to a frozen/hashable form for reliable caching."""
        if isinstance(obj, dict):
            return tuple(sorted((k, make_hashable(v)) for k, v in obj.items()))
        elif isinstance(obj, (list, tuple)):
            return tuple(make_hashable(x) for x in obj)
        # For sets, convert to sorted tuples
        elif isinstance(obj, set):
            return tuple(sorted(make_hashable(x) for x in obj))
        # Handle string representation for other objects that might not be JSON serializable
        elif not isinstance(obj, (str, int, float, bool, type(None))):
            return str(obj)
        return obj

    @wraps(func)
    def wrapper(*args, **kwargs):
        # Create cache directory if it doesn't exist
        cache_dir = "cache"
        os.makedirs(cache_dir, exist_ok=True)

        # Generate a cache key based on function name and args
        func_name = func.__name__
        # Create a function-specific subdirectory for better organization
        func_cache_dir = os.path.join(cache_dir, func_name)
        os.makedirs(func_cache_dir, exist_ok=True)

        # Get today's date for cache versioning
        today = date.today().isoformat()  # Format: YYYY-MM-DD

        # Make args and kwargs hashable before serializing
        hashable_args = tuple(make_hashable(arg) for arg in args)
        hashable_kwargs = {k: make_hashable(v) for k, v in kwargs.items()}

        try:
            # Try to serialize with standard JSON, including today's date
            arg_representation = {
                "date": today,
                "args": hashable_args,
                "kwargs": sorted(hashable_kwargs.items())
            }
            serialized_args = json.dumps(arg_representation, sort_keys=True)
        except (TypeError, ValueError):
            # If serialization fails, use string representation as fallback
            serialized_args = today + str(hashable_args) + str(sorted(hashable_kwargs.items()))

        arg_hash = hashlib.sha256(serialized_args.encode()).hexdigest()
        key = f"{func_name}_{today}_{arg_hash}"

        # Check if cached result exists
        filepath = os.path.join(func_cache_dir, f"{today}_{arg_hash}.json")
        if os.path.exists(filepath):
            logging.debug(f"Cache hit for function: {func_name} (cached on {today})")
            with open(filepath, "r") as f:
                return json.load(f)

        # If not cached, call the function
        result = func(*args, **kwargs)

        # Cache the result
        with open(filepath, "w") as f:
            json.dump(result, f)
        logging.debug(f"Cached result for function: {func_name}, saved to: {filepath} (date: {today})")

        return result

    return wrapper


@cache_to_disk
def analyze_contributors(org: str, repos: List[str]) -> Dict:
    """Analyze contributors across all repositories."""
    logging.info(f"[analyze_contributors] Start analyzing contributors for {len(repos)} repositories in org: {org}")

    # Track contributors across all repos
    global_contributors = defaultdict(lambda: {
        "total_commits": 0,
        "repos": set(),
        "emails": set(),
        "username": None,
        "company": None,
        "profile": None
    })

    # Track contributors by repo
    repo_contributors = {}

    for repo in repos:
        logging.info(f"[analyze_contributors] Processing repo: {repo}")
        commits = get_commits(org, repo)
        repo_contributor_stats = defaultdict(lambda: {
            "commits": 0,
            "emails": set(),
            "username": None
        })

        for commit in commits:
            author = commit.get("commit", {}).get("author", {})
            github_author = commit.get("author")

            author_name = author.get("name", "Unknown")
            author_email = author.get("email", "")
            username = github_author.get("login") if github_author else None

            # Since we can assume GitHub username info is always there, use it as the primary key
            contributor_key = username
            if not contributor_key:
                raise ValueError(f"Commit {commit['sha']} in repo {repo} has no identifiable contributor information.")

            # Update repo-specific stats
            repo_contributor_stats[contributor_key]["commits"] += 1
            if author_email:
                repo_contributor_stats[contributor_key]["emails"].add(author_email)
            if username:
                repo_contributor_stats[contributor_key]["username"] = username

            # Update global stats
            global_contributors[contributor_key]["total_commits"] += 1
            global_contributors[contributor_key]["repos"].add(repo)
            if author_email:
                global_contributors[contributor_key]["emails"].add(author_email)
            if username:
                global_contributors[contributor_key]["username"] = username

        # Convert sets to lists for YAML serialization
        repo_contributors[repo] = []
        for contributor_key, stats in repo_contributor_stats.items():
            repo_contributors[repo].append({
                "contributor": contributor_key,
                "commits": stats["commits"],
                "emails": list(stats["emails"]),
                "username": stats["username"]
            })

        # Sort by commit count
        repo_contributors[repo].sort(key=lambda x: x["commits"], reverse=True)

        logging.info(f"[analyze_contributors] Found {len(repo_contributors[repo])} contributors for repo: {repo}")

    # Enhance global contributors with profile and company information
    logging.info(f"[analyze_contributors] Enhancing contributor information with profiles and companies")
    for contributor_key, stats in global_contributors.items():
        # First, try to extract company from email addresses (prioritize this)
        if stats["emails"]:
            for email in stats["emails"]:
                company_from_email = extract_company_from_email(email)
                if company_from_email:
                    stats["company"] = company_from_email
                    break

        # Only if email didn't provide a clear company mapping, try GitHub profile
        if not stats["company"] and stats["username"]:
            profile = get_user_profile(stats["username"])
            stats["profile"] = profile

            # Try to extract company from profile
            company_from_profile = extract_company_from_profile(profile)
            if company_from_profile:
                stats["company"] = company_from_profile

        # Convert sets to lists for YAML serialization
        stats["repos"] = list(stats["repos"])
        stats["emails"] = list(stats["emails"])

    logging.info(f"[analyze_contributors] Finished analyzing contributors for org: {org}")
    return global_contributors, repo_contributors


def save_to_yaml(data: Dict, filename: str = "contributors_summary.yml"):
    """Save data to YAML file."""
    # Create reports directory if it doesn't exist
    reports_dir = "reports"
    os.makedirs(reports_dir, exist_ok=True)

    # Build full path with reports directory
    filepath = os.path.join(reports_dir, filename)
    logging.info(f"[save_to_yaml] Saving contributor data to {filepath}")

    # Convert defaultdict to regular dict to avoid YAML serialization issues
    if hasattr(data, "default_factory"):
        data = dict(data)

    with open(filepath, "w") as f:
        yaml.dump(data, f, sort_keys=False, default_flow_style=False)

    logging.info(f"[save_to_yaml] Data successfully saved to {filepath}")


def main():
    parser = argparse.ArgumentParser(
        description="Analyze GitHub org contributor patterns and company affiliations."
    )
    parser.add_argument(
        "--org",
        type=str,
        default="pytorch-labs",
        help="GitHub organization to analyze (default: pytorch-labs)",
    )
    args = parser.parse_args()

    global ORG_NAME
    ORG_NAME = args.org

    if not GITHUB_TOKEN:
        logging.error("[main] Missing GITHUB_TOKEN in environment variables.")
        return

    logging.info(f"[main] Starting contributor analysis for org: {ORG_NAME}")

    # Show cache stats at start
    cache_stats = get_cache_stats()
    logging.info(
        f"[main] Cache stats: {cache_stats['total_files']} files, {cache_stats['total_size_mb']} MB"
    )

    # Get repositories
    repos = get_repos(ORG_NAME)
    filtered_repos = [
        repo for repo in repos if f"{ORG_NAME}/{repo}" not in EXCLUDED_REPOS
    ]

    logging.info(f"[main] Analyzing {len(filtered_repos)} repositories (excluded {len(repos) - len(filtered_repos)})")

    # Analyze contributors
    global_contributors, repo_contributors = analyze_contributors(ORG_NAME, filtered_repos)

    # Sort contributors by frequency
    contributors_by_frequency = []
    for contributor_key, stats in global_contributors.items():
        contributors_by_frequency.append({
            "contributor": contributor_key,
            "total_commits": stats["total_commits"],
            "repos_count": len(stats["repos"]),
            "repos": stats["repos"],
            "emails": stats["emails"],
            "username": stats["username"],
            "company": stats["company"]
        })

    contributors_by_frequency.sort(key=lambda x: x["total_commits"], reverse=True)

    # Group contributors by company
    company_analysis = defaultdict(list)
    unidentified_contributors = []

    for contributor in contributors_by_frequency:
        if contributor["company"]:
            company_analysis[contributor["company"]].append({
                "contributor": contributor["contributor"],
                "total_commits": contributor["total_commits"],
                "repos_count": contributor["repos_count"],
                "username": contributor["username"]
            })
        else:
            unidentified_contributors.append({
                "contributor": contributor["contributor"],
                "total_commits": contributor["total_commits"],
                "repos_count": contributor["repos_count"],
                "username": contributor["username"],
                "emails": contributor["emails"]
            })

    # Sort company contributors by commit count
    for company in company_analysis:
        company_analysis[company].sort(key=lambda x: x["total_commits"], reverse=True)

    # Prepare output data
    output_data = {
        "analysis_metadata": {
            "organization": ORG_NAME,
            "analysis_date": datetime.utcnow().isoformat() + "Z",
            "lookback_period_days": 180,
            "repositories_analyzed": len(filtered_repos),
            "total_contributors": len(contributors_by_frequency),
            "contributors_with_company": len(contributors_by_frequency) - len(unidentified_contributors),
            "contributors_without_company": len(unidentified_contributors)
        },
        "contributors_by_frequency": contributors_by_frequency[:50],  # Top 50 contributors
        "company_analysis": dict(company_analysis),
        "unidentified_contributors": unidentified_contributors[:20],  # Top 20 unidentified
        "contributors_by_repo": repo_contributors
    }

    # Sort output for consistency
    def deep_sort(obj, sort_keys=True):
        if isinstance(obj, dict):
            keys = sorted(obj) if sort_keys else obj.keys()
            return {k: deep_sort(obj[k]) for k in keys}
        elif isinstance(obj, list):
            return [deep_sort(x) for x in obj]
        else:
            return obj

    # Don't sort top-level keys to maintain logical order
    for key in ["company_analysis", "contributors_by_repo"]:
        if key in output_data:
            output_data[key] = deep_sort(output_data[key])

    save_to_yaml(output_data)

    # Show final cache stats
    final_cache_stats = get_cache_stats()
    logging.info(
        f"[main] Final cache stats: {final_cache_stats['total_files']} files, {final_cache_stats['total_size_mb']} MB"
    )

    # Print summary
    print(f"\nAnalysis Summary:")
    print(f"- Organization: {ORG_NAME}")
    print(f"- Repositories analyzed: {len(filtered_repos)}")
    print(f"- Total contributors: {len(contributors_by_frequency)}")
    print(f"- Contributors with identified companies: {len(contributors_by_frequency) - len(unidentified_contributors)}")
    print(f"- Top companies by contributor count:")

    # Show top companies
    company_contributor_count = [(company, len(contributors)) for company, contributors in company_analysis.items()]
    company_contributor_count.sort(key=lambda x: x[1], reverse=True)

    for company, count in company_contributor_count[:20]:
        total_commits = sum(c["total_commits"] for c in company_analysis[company])
        print(f"  - {company}: {count} contributors, {total_commits} total commits")

    # Show top contributors (>7 commits) with their repository breakdown
    print(f"\nTop contributors (>7 commits):")
    top_contributors = [c for c in contributors_by_frequency if c["total_commits"] > 7]

    for contributor in top_contributors:
        contributor_key = contributor["contributor"]

        # Get repo-specific commit counts for this contributor
        repo_commits = []
        for repo in contributor["repos"]:
            # Find this contributor in the repo's contributor list
            for repo_contrib in repo_contributors.get(repo, []):
                if repo_contrib["contributor"] == contributor_key:
                    repo_commits.append(f"{repo}({repo_contrib['commits']})")
                    break

        # Sort by commit count (descending)
        repo_commits.sort(key=lambda x: int(x.split('(')[1].split(')')[0]), reverse=True)

        # Format the contributor name (use username if available, otherwise email/name)
        display_name = contributor["username"] if contributor["username"] else contributor_key

        print(f"- {display_name}, {', '.join(repo_commits)}")

    logging.info("[main] Script completed successfully.")


if __name__ == "__main__":
    main()
