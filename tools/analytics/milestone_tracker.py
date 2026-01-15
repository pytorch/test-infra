#!/usr/bin/env python3

"""
Script to gather all issues and PRs from a GitHub milestone and format them
as a markdown checklist for insertion into a GitHub issue description.

Usage:
    python milestone_tracker.py --milestone "2.9.1"
    python milestone_tracker.py --milestone-id 57
    python milestone_tracker.py --milestone "2.9.1" --output report.md

Environment Variables:
    GITHUB_TOKEN: GitHub token for authentication (recommended for rate limits)
"""

import argparse
import json
import os
import re
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def fetch_json(
    url: str, params: Optional[Dict[str, Any]] = None
) -> Any:
    """Fetch JSON data from a URL with optional parameters."""
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
    """Fetch all pages of JSON data from a paginated API endpoint."""
    if params is None:
        params = {}
    assert "page" not in params
    page_idx, rc, prev_len, params = 1, [], -1, params.copy()
    params["per_page"] = 100
    while len(rc) > prev_len:
        prev_len = len(rc)
        params["page"] = page_idx
        page_idx += 1
        rc += fetch_json(url, params)
    return rc


def get_milestones(
    org: str = "pytorch", project: str = "pytorch", state: str = "all"
) -> List[Dict[str, Any]]:
    """Get all milestones for a repository."""
    url = f"https://api.github.com/repos/{org}/{project}/milestones"
    return fetch_multipage_json(url, {"state": state})


def get_milestone_by_title(
    org: str, project: str, milestone_title: str
) -> Optional[Dict[str, Any]]:
    """Find a milestone by its title."""
    milestones = get_milestones(org, project)
    for milestone in milestones:
        if milestone.get("title", "") == milestone_title:
            return milestone
    return None


def get_milestone_issues(
    org: str, project: str, milestone_number: int, state: str = "all"
) -> List[Dict[str, Any]]:
    """Get all issues (including PRs) from a milestone."""
    url = f"https://api.github.com/repos/{org}/{project}/issues"
    return fetch_multipage_json(url, {"milestone": milestone_number, "state": state})


def get_pr_details(org: str, project: str, pr_number: int) -> Dict[str, Any]:
    """Get detailed PR information including body."""
    url = f"https://api.github.com/repos/{org}/{project}/pulls/{pr_number}"
    return fetch_json(url)


def get_assignees(item: Dict[str, Any]) -> str:
    """Extract assignee usernames from an issue/PR."""
    assignees = item.get("assignees", [])
    if not assignees:
        assignee = item.get("assignee")
        if assignee:
            return f"@{assignee['login']}"
        return ""
    return " ".join(f"@{a['login']}" for a in assignees)


def is_pull_request(item: Dict[str, Any]) -> bool:
    """Check if an item is a pull request."""
    return "pull_request" in item


def has_label(item: Dict[str, Any], label_name: str) -> bool:
    """Check if an item has a specific label."""
    labels = item.get("labels", [])
    return any(label.get("name") == label_name for label in labels)


def extract_linked_issue_numbers(text: str) -> Set[int]:
    """
    Extract issue numbers that are linked/referenced in PR body or title.
    Looks for patterns like:
    - Fixes #123, Closes #123, Resolves #123
    - Fix #123, Close #123, Resolve #123
    - Fixed #123, Closed #123, Resolved #123
    - https://github.com/org/repo/issues/123
    """
    issue_numbers = set()

    # Pattern for "Fixes #123", "Closes #456", etc.
    keyword_pattern = r"(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s*#(\d+)"
    for match in re.finditer(keyword_pattern, text, re.IGNORECASE):
        issue_numbers.add(int(match.group(1)))

    # Pattern for direct GitHub issue URLs
    url_pattern = r"github\.com/[^/]+/[^/]+/issues/(\d+)"
    for match in re.finditer(url_pattern, text, re.IGNORECASE):
        issue_numbers.add(int(match.group(1)))

    return issue_numbers


def build_issue_pr_mapping(
    org: str, project: str, items: List[Dict[str, Any]]
) -> Dict[int, List[int]]:
    """
    Build a mapping of issue numbers to their linked PR numbers.
    Returns: {issue_number: [pr_number1, pr_number2, ...]}
    """
    issues = {item["number"]: item for item in items if not is_pull_request(item)}
    prs = [item for item in items if is_pull_request(item)]

    issue_to_prs: Dict[int, List[int]] = {num: [] for num in issues.keys()}

    for pr in prs:
        pr_number = pr["number"]
        # Check PR title and body for issue references
        text = f"{pr.get('title', '')} {pr.get('body', '') or ''}"
        linked_issues = extract_linked_issue_numbers(text)

        # Only link to issues that are in our milestone
        for issue_num in linked_issues:
            if issue_num in issue_to_prs:
                issue_to_prs[issue_num].append(pr_number)

    return issue_to_prs


def format_checkbox(state: str) -> str:
    """Return checkbox based on state."""
    return "[x]" if state == "closed" else "[ ]"


def generate_milestone_report(
    org: str,
    project: str,
    milestone_id: Optional[int] = None,
    milestone_title: Optional[str] = None,
    header: str = "### 🐛 Describe the bug",
) -> str:
    """
    Generate a markdown report of all issues and PRs from a milestone.

    - Excludes items with "release-feature-request" label
    - Links issues with their associated PRs side by side
    - Shows checkbox based on closed/open state
    """
    # Resolve milestone
    if milestone_id is None:
        if milestone_title is None:
            raise ValueError("Either milestone_id or milestone_title must be provided")
        milestone = get_milestone_by_title(org, project, milestone_title)
        if milestone is None:
            raise ValueError(f"Milestone '{milestone_title}' not found")
        milestone_id = milestone["number"]
        print(f"Found milestone: {milestone['title']} (#{milestone_id})")

    # Fetch all issues and PRs
    items = get_milestone_issues(org, project, milestone_id)
    print(f"Found {len(items)} total items in milestone")

    # Filter out items with "release-feature-request" label
    filtered_items = [
        item for item in items
        if not has_label(item, "release-feature-request")
    ]
    excluded_count = len(items) - len(filtered_items)
    if excluded_count > 0:
        print(f"Excluded {excluded_count} items with 'release-feature-request' label")

    # Separate into issues and PRs
    issues = [item for item in filtered_items if not is_pull_request(item)]
    prs = [item for item in filtered_items if is_pull_request(item)]
    pr_by_number = {pr["number"]: pr for pr in prs}

    print(f"Processing {len(issues)} issues and {len(prs)} PRs")

    # Build mapping of issues to their linked PRs
    issue_to_prs = build_issue_pr_mapping(org, project, filtered_items)

    # Track which PRs are linked to issues
    linked_pr_numbers: Set[int] = set()
    for pr_nums in issue_to_prs.values():
        linked_pr_numbers.update(pr_nums)

    # Sort issues by number
    issues.sort(key=lambda x: x["number"])

    # Generate report lines
    lines = [header, ""]

    # Process issues with their linked PRs
    for issue in issues:
        issue_num = issue["number"]
        issue_url = issue["html_url"]
        assignees = get_assignees(issue)
        linked_prs = issue_to_prs.get(issue_num, [])

        if linked_prs:
            # Issue has linked PRs - show them side by side
            # Determine overall status: closed if issue AND all linked PRs are closed
            all_closed = issue["state"] == "closed" and all(
                pr_by_number.get(pr_num, {}).get("state") == "closed"
                for pr_num in linked_prs
                if pr_num in pr_by_number
            )
            checkbox = "[x]" if all_closed else "[ ]"

            # Format PR links
            pr_links = []
            for pr_num in sorted(linked_prs):
                if pr_num in pr_by_number:
                    pr_links.append(pr_by_number[pr_num]["html_url"])

            if pr_links:
                pr_text = " | " + " ".join(pr_links)
            else:
                pr_text = ""

            if assignees:
                lines.append(f"- {checkbox} {issue_url}{pr_text} - {assignees}")
            else:
                lines.append(f"- {checkbox} {issue_url}{pr_text}")
        else:
            # Issue without linked PRs
            checkbox = format_checkbox(issue["state"])
            if assignees:
                lines.append(f"- {checkbox} {issue_url} - {assignees}")
            else:
                lines.append(f"- {checkbox} {issue_url}")

    # Add standalone PRs (not linked to any issue in the milestone)
    standalone_prs = [pr for pr in prs if pr["number"] not in linked_pr_numbers]
    standalone_prs.sort(key=lambda x: x["number"])

    for pr in standalone_prs:
        pr_url = pr["html_url"]
        assignees = get_assignees(pr)
        checkbox = format_checkbox(pr["state"])

        if assignees:
            lines.append(f"- {checkbox} {pr_url} - {assignees}")
        else:
            lines.append(f"- {checkbox} {pr_url}")

    return "\n".join(lines)


def print_summary(items: List[Dict[str, Any]]) -> None:
    """Print a summary of the milestone items."""
    # Filter out release-feature-request items
    filtered = [i for i in items if not has_label(i, "release-feature-request")]

    issues = [item for item in filtered if not is_pull_request(item)]
    prs = [item for item in filtered if is_pull_request(item)]

    closed_issues = sum(1 for i in issues if i["state"] == "closed")
    closed_prs = sum(1 for p in prs if p["state"] == "closed")

    print("\nSummary:")
    print(f"  Issues: {closed_issues}/{len(issues)} closed")
    print(f"  PRs: {closed_prs}/{len(prs)} closed/merged")
    print(f"  Total: {closed_issues + closed_prs}/{len(filtered)} complete")


def parse_arguments():
    parser = argparse.ArgumentParser(
        description="Generate markdown checklist from GitHub milestone issues and PRs"
    )
    parser.add_argument(
        "--org",
        type=str,
        default="pytorch",
        help="GitHub organization name (default: pytorch)",
    )
    parser.add_argument(
        "--project",
        type=str,
        default="pytorch",
        help="GitHub project/repository name (default: pytorch)",
    )
    parser.add_argument(
        "--milestone",
        type=str,
        help="Milestone title (e.g., '2.9.1')",
    )
    parser.add_argument(
        "--milestone-id",
        type=int,
        help="Milestone number/ID (e.g., 57 for milestone/57)",
    )
    parser.add_argument(
        "--header",
        type=str,
        default="### 🐛 Describe the bug",
        help="Header text for the report",
    )
    parser.add_argument(
        "--output",
        type=str,
        help="Output file path (if not specified, prints to stdout)",
    )
    parser.add_argument(
        "--list-milestones",
        action="store_true",
        help="List all available milestones and exit",
    )
    parser.add_argument(
        "--summary",
        action="store_true",
        help="Print a summary of milestone progress",
    )
    return parser.parse_args()


def main():
    args = parse_arguments()

    if args.list_milestones:
        print(f"Fetching milestones for {args.org}/{args.project}...")
        milestones = get_milestones(args.org, args.project)
        print(f"\nFound {len(milestones)} milestones:\n")
        for m in sorted(milestones, key=lambda x: x.get("number", 0), reverse=True):
            state = "🟢" if m["state"] == "open" else "⚪"
            print(f"  {state} #{m['number']}: {m['title']}")
        return

    if args.milestone is None and args.milestone_id is None:
        print("Error: Either --milestone or --milestone-id is required")
        print("Use --list-milestones to see available milestones")
        return

    try:
        report = generate_milestone_report(
            org=args.org,
            project=args.project,
            milestone_id=args.milestone_id,
            milestone_title=args.milestone,
            header=args.header,
        )

        if args.output:
            with open(args.output, "w") as f:
                f.write(report)
            print(f"\nReport written to {args.output}")
        else:
            print("\n" + "=" * 60)
            print(report)
            print("=" * 60)

        if args.summary:
            if args.milestone_id:
                milestone_id = args.milestone_id
            else:
                milestone = get_milestone_by_title(args.org, args.project, args.milestone)
                milestone_id = milestone["number"]
            items = get_milestone_issues(args.org, args.project, milestone_id)
            print_summary(items)

    except ValueError as e:
        print(f"Error: {e}")
    except HTTPError as e:
        print(f"HTTP Error: {e}")


if __name__ == "__main__":
    main()
