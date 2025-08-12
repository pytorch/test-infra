# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "requests>=2.31.0",
#   "python-dotenv>=1.0.0",
# ]
# ///

"""
GitHub Code Search API Script
============================

Purpose:
--------
This script uses GitHub's Search API to perform code searches equivalent to the GitHub web interface.
It can search for code across organizations, repositories, and files with various filters.

Key Features:
-------------
- Search code across GitHub organizations
- Filter by repository, language, file extension, etc.
- Handle GitHub API rate limits
- Cache results for efficiency
- Export results to various formats

How to Run:
-----------
1. Ensure you have Python 3.10+ and install dependencies (see below).
2. Set the following environment variable (can be in a .env file):
   - `GITHUB_TOKEN`: A GitHub personal access token with appropriate permissions.
3. Run the script:

   ```bash
   python github_code_search.py --query "org:meta-pytorch pytorch-labs" [options]
   ```

Examples:
---------
```bash
# Search for "pytorch-labs" in meta-pytorch organization
python github_code_search.py --query "org:meta-pytorch pytorch-labs"

# Search for specific file types
python github_code_search.py --query "org:meta-pytorch filename:README.md"

# Search for code in specific language
python github_code_search.py --query "org:meta-pytorch language:python pytorch-labs"

# Export results to JSON
python github_code_search.py --query "org:meta-pytorch pytorch-labs" --output results.json
```

Output:
-------
- Console output with search results
- Optional JSON/CSV export
- Rate limit information
- Search statistics
"""

import argparse
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any, TypedDict, Union
from urllib.parse import quote_plus
from dataclasses import dataclass

import requests
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")

# GitHub API headers
HEADERS = {
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
}

BASE_URL = "https://api.github.com"
SEARCH_URL = f"{BASE_URL}/search/code"


# Type definitions for well-defined schema
class RepositoryInfo(TypedDict):
    """Repository information from GitHub search results."""
    id: int
    node_id: str
    name: str
    full_name: str
    private: bool
    owner: Dict[str, Any]  # GitHub user/org object
    html_url: str
    description: Optional[str]
    fork: bool
    url: str
    forks_url: str
    keys_url: str
    collaborators_url: str
    teams_url: str
    hooks_url: str
    issue_events_url: str
    events_url: str
    assignees_url: str
    branches_url: str
    tags_url: str
    blobs_url: str
    git_tags_url: str
    git_refs_url: str
    trees_url: str
    statuses_url: str
    languages_url: str
    stargazers_url: str
    contributors_url: str
    subscribers_url: str
    subscription_url: str
    commits_url: str
    git_commits_url: str
    comments_url: str
    issue_comment_url: str
    contents_url: str
    compare_url: str
    merges_url: str
    archive_url: str
    downloads_url: str
    issues_url: str
    pulls_url: str
    milestones_url: str
    notifications_url: str
    labels_url: str
    releases_url: str
    deployments_url: str
    created_at: str
    updated_at: str
    pushed_at: str
    git_url: str
    ssh_url: str
    clone_url: str
    svn_url: str
    homepage: Optional[str]
    size: int
    stargazers_count: int
    watchers_count: int
    language: Optional[str]
    has_issues: bool
    has_projects: bool
    has_downloads: bool
    has_wiki: bool
    has_pages: bool
    has_discussions: bool
    forks_count: int
    mirror_url: Optional[str]
    archived: bool
    disabled: bool
    open_issues_count: int
    license: Optional[Dict[str, Any]]
    allow_forking: bool
    is_template: bool
    web_commit_signoff_required: bool
    topics: List[str]
    visibility: str
    forks: int
    open_issues: int
    watchers: int
    default_branch: str
    score: float


class SearchResultItem(TypedDict):
    """Individual search result item from GitHub code search."""
    name: str
    path: str
    sha: str
    url: str
    git_url: str
    html_url: str
    repository: RepositoryInfo
    score: float
    file_size: Optional[int]
    language: Optional[str]
    last_modified_at: Optional[str]
    line_numbers: Optional[List[int]]
    text_matches: Optional[List[Dict[str, Any]]]


class GitHubSearchResults(TypedDict):
    """Complete search results from GitHub Search API."""
    query: str
    total_count: int
    retrieved_count: int
    items: List[SearchResultItem]
    search_time: str
    rate_limit_remaining: Optional[int]
    rate_limit_reset: Optional[str]


@dataclass
class SearchOptions:
    """Options for GitHub code search."""
    per_page: int = 100
    max_results: Optional[int] = None
    verbose: bool = True


class GitHubCodeSearch:
    def __init__(self, token: str = None):
        """
        Initialize GitHub Code Search client.
        
        Args:
            token: GitHub personal access token. If None, will try to get from GITHUB_TOKEN env var.
        """
        self.token = token or GITHUB_TOKEN
        if not self.token:
            raise ValueError("GitHub token is required. Set GITHUB_TOKEN environment variable or pass token parameter.")
            
        self.headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
        }
        self.session = requests.Session()
        self.session.headers.update(self.headers)
        
    def search_code(self, query: str, per_page: int = 100, max_results: Optional[int] = None, 
                   verbose: bool = True) -> GitHubSearchResults:
        """
        Search for code using GitHub's Search API.
        
        Args:
            query: Search query string
            per_page: Number of results per page (max 100)
            max_results: Maximum number of results to return (None for all)
            verbose: Whether to log progress messages
            
        Returns:
            GitHubSearchResults: Well-defined structure containing:
                - query: The search query used
                - total_count: Total number of results available from GitHub
                - retrieved_count: Number of results actually retrieved
                - items: List of SearchResultItem objects with file details
                - search_time: ISO timestamp of when search was performed
                - rate_limit_remaining: Remaining API calls (if available)
                - rate_limit_reset: When rate limit resets (if available)
        """
        all_items = []
        page = 1
        total_count = 0
        
        if verbose:
            logging.info(f"Starting code search with query: {query}")
        
        while True:
            # Check rate limits
            rate_limit_info = self._check_rate_limit()
            if rate_limit_info['remaining'] == 0:
                reset_time = rate_limit_info['reset_time']
                wait_time = max(0, reset_time - time.time())
                if verbose:
                    logging.warning(f"Rate limit exceeded. Waiting {wait_time:.0f} seconds...")
                time.sleep(wait_time + 1)
            
            # Prepare request parameters
            params = {
                'q': query,
                'per_page': min(per_page, 100),
                'page': page
            }
            
            try:
                if verbose:
                    logging.info(f"Fetching page {page}...")
                response = self.session.get(SEARCH_URL, params=params)
                response.raise_for_status()
                
                data = response.json()
                
                # Update total count on first page
                if page == 1:
                    total_count = data.get('total_count', 0)
                    if verbose:
                        logging.info(f"Total results found: {total_count}")
                
                items = data.get('items', [])
                if not items:
                    break
                
                all_items.extend(items)
                if verbose:
                    logging.info(f"Retrieved {len(items)} items from page {page} (total: {len(all_items)})")
                
                # Check if we've reached the maximum results
                if max_results and len(all_items) >= max_results:
                    all_items = all_items[:max_results]
                    if verbose:
                        logging.info(f"Reached maximum results limit: {max_results}")
                    break
                
                # Check if there are more pages
                if len(items) < per_page:
                    break
                
                page += 1
                
                # Be respectful to the API
                time.sleep(1)
                
            except requests.exceptions.RequestException as e:
                logging.error(f"Error fetching page {page}: {e}")
                break
            except json.JSONDecodeError as e:
                logging.error(f"Error parsing JSON response from page {page}: {e}")
                break
        
        # Get rate limit info for the response
        rate_limit_info = self._check_rate_limit()
        
        return GitHubSearchResults(
            query=query,
            total_count=total_count,
            retrieved_count=len(all_items),
            items=all_items,
            search_time=datetime.now(timezone.utc).isoformat(),
            rate_limit_remaining=rate_limit_info.get('remaining'),
            rate_limit_reset=datetime.fromtimestamp(rate_limit_info.get('reset_time', 0)).isoformat() if rate_limit_info.get('reset_time') else None
        )
    
    def get_rate_limit(self) -> Dict[str, Any]:
        """Get GitHub API rate limit status."""
        return self._check_rate_limit()
    
    def _check_rate_limit(self) -> Dict[str, Any]:
        """Check GitHub API rate limit status."""
        try:
            response = self.session.get(f"{BASE_URL}/rate_limit")
            response.raise_for_status()
            data = response.json()
            
            search_limit = data.get('resources', {}).get('search', {})
            return {
                'limit': search_limit.get('limit', 0),
                'remaining': search_limit.get('remaining', 0),
                'reset_time': search_limit.get('reset', 0)
            }
        except Exception as e:
            logging.warning(f"Could not check rate limit: {e}")
            return {'limit': 0, 'remaining': 0, 'reset_time': 0}
    
    def format_results(self, results: GitHubSearchResults, format_type: str = 'console') -> str:
        """Format search results for different output types."""
        if format_type == 'json':
            return json.dumps(results, indent=2)
        
        elif format_type == 'console':
            output = []
            output.append(f"=== GitHub Code Search Results ===")
            output.append(f"Query: {results['query']}")
            output.append(f"Total results: {results['total_count']}")
            output.append(f"Retrieved: {results['retrieved_count']}")
            output.append(f"Search time: {results['search_time']}")
            output.append("")
            
            for i, item in enumerate(results['items'], 1):
                repo_name = item.get('repository', {}).get('full_name', 'Unknown')
                file_path = item.get('path', 'Unknown')
                file_url = item.get('html_url', '')
                score = item.get('score', 0)
                
                output.append(f"{i}. {repo_name}/{file_path}")
                output.append(f"   Score: {score}")
                output.append(f"   URL: {file_url}")
                output.append("")
            
            return "\n".join(output)
        
        elif format_type == 'csv':
            import csv
            import io
            
            output = io.StringIO()
            writer = csv.writer(output)
            
            # Write header
            writer.writerow(['Repository', 'File Path', 'Score', 'URL', 'Search Time'])
            
            # Write data
            for item in results['items']:
                repo_name = item.get('repository', {}).get('full_name', 'Unknown')
                file_path = item.get('path', 'Unknown')
                file_url = item.get('html_url', '')
                score = item.get('score', 0)
                
                writer.writerow([repo_name, file_path, score, file_url, results['search_time']])
            
            return output.getvalue()
        
        else:
            raise ValueError(f"Unsupported format type: {format_type}")
    
    def get_file_paths(self, results: GitHubSearchResults) -> List[str]:
        """Extract just the file paths from search results."""
        return [item.get('path', '') for item in results.get('items', [])]
    
    def get_repositories(self, results: GitHubSearchResults) -> List[str]:
        """Extract just the repository names from search results."""
        return [item.get('repository', {}).get('full_name', '') for item in results.get('items', [])]
    
    def get_unique_repositories(self, results: GitHubSearchResults) -> List[str]:
        """Extract unique repository names from search results."""
        repos = self.get_repositories(results)
        return list(set(repos))
    
    def filter_by_score(self, results: GitHubSearchResults, min_score: float = 0.0) -> GitHubSearchResults:
        """Filter results by minimum score."""
        filtered_items = [
            item for item in results.get('items', [])
            if item.get('score', 0) >= min_score
        ]
        
        return GitHubSearchResults(
            query=results['query'],
            total_count=results['total_count'],
            retrieved_count=len(filtered_items),
            items=filtered_items,
            search_time=results['search_time'],
            rate_limit_remaining=results.get('rate_limit_remaining'),
            rate_limit_reset=results.get('rate_limit_reset')
        )
    
    def filter_by_repository(self, results: GitHubSearchResults, repo_pattern: str) -> GitHubSearchResults:
        """Filter results by repository name pattern."""
        import re
        pattern = re.compile(repo_pattern)
        
        filtered_items = [
            item for item in results.get('items', [])
            if pattern.search(item.get('repository', {}).get('full_name', ''))
        ]
        
        return GitHubSearchResults(
            query=results['query'],
            total_count=results['total_count'],
            retrieved_count=len(filtered_items),
            items=filtered_items,
            search_time=results['search_time'],
            rate_limit_remaining=results.get('rate_limit_remaining'),
            rate_limit_reset=results.get('rate_limit_reset')
        )


def search_github_code(query: str, token: str = None, per_page: int = 100, 
                      max_results: Optional[int] = None, verbose: bool = True) -> GitHubSearchResults:
    """
    Convenience function to search GitHub code.
    
    Args:
        query: Search query string
        token: GitHub personal access token (optional, will use GITHUB_TOKEN env var if not provided)
        per_page: Number of results per page (max 100)
        max_results: Maximum number of results to return (None for all)
        verbose: Whether to log progress messages
        
    Returns:
        GitHubSearchResults: Well-defined structure containing search results with the following fields:
            - query: The search query used
            - total_count: Total number of results available from GitHub
            - retrieved_count: Number of results actually retrieved
            - items: List of SearchResultItem objects, each containing:
                - name: File name
                - path: File path in repository
                - sha: Git SHA of the file
                - url: API URL for the file
                - html_url: Web URL for the file
                - repository: RepositoryInfo object with full repo details
                - score: Relevance score (0-100)
                - file_size: File size in bytes (if available)
                - language: Programming language (if detected)
                - last_modified_at: Last modification time (if available)
                - line_numbers: Line numbers where matches were found (if available)
                - text_matches: Detailed text match information (if available)
            - search_time: ISO timestamp of when search was performed
            - rate_limit_remaining: Remaining API calls (if available)
            - rate_limit_reset: When rate limit resets (if available)
    """
    searcher = GitHubCodeSearch(token)
    return searcher.search_code(query, per_page, max_results, verbose)


def main():
    parser = argparse.ArgumentParser(
        description="Search GitHub code using the GitHub Search API"
    )
    parser.add_argument(
        "--query",
        type=str,
        required=True,
        help="Search query (e.g., 'org:meta-pytorch pytorch-labs')",
    )
    parser.add_argument(
        "--per-page",
        type=int,
        default=100,
        help="Number of results per page (max 100, default: 100)",
    )
    parser.add_argument(
        "--max-results",
        type=int,
        help="Maximum number of results to retrieve (default: all)",
    )
    parser.add_argument(
        "--output",
        type=str,
        help="Output file path (e.g., 'results.json' or 'results.csv')",
    )
    parser.add_argument(
        "--format",
        type=str,
        choices=['console', 'json', 'csv'],
        default='console',
        help="Output format (default: console)",
    )
    parser.add_argument(
        "--show-rate-limit",
        action="store_true",
        help="Show rate limit information before searching",
    )
    
    args = parser.parse_args()

    if not GITHUB_TOKEN:
        logging.error("Missing GITHUB_TOKEN in environment variables.")
        return

    # Create search instance
    searcher = GitHubCodeSearch()
    
    # Show rate limit if requested
    if args.show_rate_limit:
        rate_limit = searcher.get_rate_limit()
        print(f"Rate limit: {rate_limit['remaining']}/{rate_limit['limit']} remaining")
        if rate_limit['remaining'] == 0:
            reset_time = datetime.fromtimestamp(rate_limit['reset_time'])
            print(f"Rate limit resets at: {reset_time}")
        print()

    # Perform search
    results = searcher.search_code(
        query=args.query,
        per_page=args.per_page,
        max_results=args.max_results
    )

    # Format and output results
    if args.output:
        # Determine format from file extension
        if args.output.endswith('.json'):
            output_format = 'json'
        elif args.output.endswith('.csv'):
            output_format = 'csv'
        else:
            output_format = args.format
        
        formatted_output = searcher.format_results(results, output_format)
        
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(formatted_output)
        
        print(f"Results saved to: {args.output}")
        
        # Also show console summary
        console_output = searcher.format_results(results, 'console')
        print(console_output)
    else:
        # Just show console output
        formatted_output = searcher.format_results(results, args.format)
        print(formatted_output)


if __name__ == "__main__":
    main() 