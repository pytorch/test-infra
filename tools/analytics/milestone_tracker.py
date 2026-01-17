#!/usr/bin/env python3

"""
Script to gather all issues and PRs from a GitHub milestone and format them
as a markdown checklist for insertion into a GitHub issue description.

Usage:
    python milestone_tracker.py --milestone "2.9.1"
    python milestone_tracker.py --milestone-id 57
    python milestone_tracker.py --milestone "2.9.1" --output report.md

    # Extract comments from a tracking issue and merge into the report
    python milestone_tracker.py --milestone "2.9.1" --from-issue 170119
    python milestone_tracker.py --milestone "2.9.1" --from-issue-url https://github.com/pytorch/pytorch/issues/170119

    # Just list checklist items found in issue comments (no milestone required)
    python milestone_tracker.py --from-issue 170119
    python milestone_tracker.py --from-issue-url https://github.com/pytorch/pytorch/issues/170119

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


def fetch_json(url: str, params: Optional[Dict[str, Any]] = None) -> Any:
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
    rc: List[Dict[str, Any]] = []
    page_idx, prev_len, params = 1, -1, params.copy()
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


def get_issue_comments(
    org: str, project: str, issue_number: int
) -> List[Dict[str, Any]]:
    """Get all comments from a GitHub issue."""
    url = f"https://api.github.com/repos/{org}/{project}/issues/{issue_number}/comments"
    return fetch_multipage_json(url)


def extract_issue_pr_references_from_text(text: str) -> List[Tuple[str, int]]:
    """
    Extract issue and PR references from text.
    Returns list of tuples: (type, number) where type is 'issue' or 'pr'.

    Patterns recognized:
    - #123 (generic reference)
    - https://github.com/org/repo/issues/123
    - https://github.com/org/repo/pull/123
    """
    references: List[Tuple[str, int]] = []

    # Pattern for GitHub issue URLs
    issue_url_pattern = r"github\.com/[^/]+/[^/]+/issues/(\d+)"
    for match in re.finditer(issue_url_pattern, text, re.IGNORECASE):
        references.append(("issue", int(match.group(1))))

    # Pattern for GitHub PR URLs
    pr_url_pattern = r"github\.com/[^/]+/[^/]+/pull/(\d+)"
    for match in re.finditer(pr_url_pattern, text, re.IGNORECASE):
        references.append(("pr", int(match.group(1))))

    # Pattern for #123 references (could be issue or PR, we'll treat as generic)
    hash_pattern = r"(?<![a-zA-Z0-9/])#(\d+)(?![a-zA-Z0-9])"
    for match in re.finditer(hash_pattern, text):
        num = int(match.group(1))
        # Avoid duplicates if already found via URL
        if ("issue", num) not in references and ("pr", num) not in references:
            references.append(("ref", num))

    return references


def extract_checklist_items_from_comments(
    org: str, project: str, issue_number: int
) -> List[Dict[str, Any]]:
    """
    Extract checklist items from issue comments.

    Looks for markdown checklist patterns like:
    - [ ] Item description #123
    - [x] Completed item https://github.com/org/repo/issues/456

    Returns list of dicts with 'text', 'checked', and 'references' keys.
    """
    comments = get_issue_comments(org, project, issue_number)
    items: List[Dict[str, Any]] = []

    # Pattern for markdown checklist items
    checklist_pattern = r"^[\s]*[-*]\s*\[([ xX])\]\s*(.+)$"

    for comment in comments:
        body = comment.get("body", "") or ""
        author = comment.get("user", {}).get("login", "unknown")

        for line in body.split("\n"):
            match = re.match(checklist_pattern, line)
            if match:
                checked = match.group(1).lower() == "x"
                text = match.group(2).strip()
                references = extract_issue_pr_references_from_text(text)
                items.append(
                    {
                        "text": text,
                        "checked": checked,
                        "references": references,
                        "author": author,
                        "raw_line": line.strip(),
                    }
                )

    return items


def get_referenced_numbers_from_comments(
    org: str, project: str, issue_number: int
) -> Set[int]:
    """
    Extract all issue/PR numbers referenced in comments of a given issue.
    Returns a set of unique issue/PR numbers found.
    """
    comments = get_issue_comments(org, project, issue_number)
    all_numbers: Set[int] = set()

    for comment in comments:
        body = comment.get("body", "") or ""
        references = extract_issue_pr_references_from_text(body)
        for ref_type, num in references:
            all_numbers.add(num)

    return all_numbers


def extract_release_branch_prs_from_comments(
    org: str, project: str, issue_number: int
) -> Dict[int, Dict[str, Any]]:
    """
    Extract PRs that are listed as "Link to release branch PR:" in issue comments.

    Looks for patterns like:
    - Link to release branch PR:
      * https://github.com/org/repo/pull/123
    - Link to release branch PR: https://github.com/org/repo/pull/123
    - Link to release branch PR: #456

    Returns a dictionary mapping PR number to PR info.
    """
    comments = get_issue_comments(org, project, issue_number)
    release_prs: Dict[int, Dict[str, Any]] = {}

    # Pattern for "Link to release branch PR:" followed by optional newline, bullet, and URL or #number
    # This handles both single-line and multi-line formats with bullets
    release_pr_pattern = r"Link to release branch PR:\s*(?:\n\s*[*-]\s*)?(?:https://github\.com/[^/]+/[^/]+/pull/(\d+)|#(\d+))"

    for comment in comments:
        body = comment.get("body", "") or ""
        author = comment.get("user", {}).get("login", "unknown")

        for match in re.finditer(release_pr_pattern, body, re.IGNORECASE):
            # Group 1 is from URL pattern, group 2 is from #number pattern
            pr_num_str = match.group(1) or match.group(2)
            if pr_num_str:
                pr_num = int(pr_num_str)
                if pr_num not in release_prs:
                    release_prs[pr_num] = {
                        "number": pr_num,
                        "author": author,
                        "from_release_branch_link": True,
                    }

    return release_prs


def merge_items_from_issue_comments(
    existing_items: List[Dict[str, Any]],
    org: str,
    project: str,
    issue_number: int,
) -> Tuple[List[Dict[str, Any]], int]:
    """
    Merge items from issue comments into existing list.

    Only adds items that are not already present (based on issue/PR number).
    Returns tuple of (merged_list, count_of_new_items).
    """
    # Get existing issue/PR numbers
    existing_numbers: Set[int] = set()
    for item in existing_items:
        existing_numbers.add(item.get("number", 0))

    # Get checklist items from comments
    comment_items = extract_checklist_items_from_comments(org, project, issue_number)

    new_items: List[Dict[str, Any]] = []
    for item in comment_items:
        for ref_type, num in item.get("references", []):
            if num not in existing_numbers:
                existing_numbers.add(num)
                new_items.append(
                    {
                        "number": num,
                        "type": ref_type,
                        "text": item["text"],
                        "checked": item["checked"],
                        "source": f"comment by {item['author']}",
                    }
                )

    return existing_items + new_items, len(new_items)


def parse_github_issue_url(url: str) -> Optional[Tuple[str, str, int]]:
    """
    Parse a GitHub issue URL and extract org, project, and issue number.

    Args:
        url: Full GitHub issue URL (e.g., https://github.com/pytorch/pytorch/issues/170119)

    Returns:
        Tuple of (org, project, issue_number) or None if URL is invalid.
    """
    pattern = r"github\.com/([^/]+)/([^/]+)/issues/(\d+)"
    match = re.search(pattern, url)
    if match:
        return match.group(1), match.group(2), int(match.group(3))
    return None


def print_issue_comments_report(org: str, project: str, issue_number: int) -> None:
    """
    Print a report of all checklist items found in issue comments.
    """
    print(f"Fetching comments from {org}/{project}#issue/{issue_number}...")
    items = extract_checklist_items_from_comments(org, project, issue_number)

    if not items:
        print("No checklist items found in issue comments.")
        return

    print(f"\nFound {len(items)} checklist items in comments:\n")

    for item in items:
        checkbox = "[x]" if item["checked"] else "[ ]"
        refs = item.get("references", [])
        ref_str = ", ".join(f"#{num}" for _, num in refs) if refs else "no refs"
        print(f"  {checkbox} {item['text'][:60]}... ({ref_str}) - by {item['author']}")


def generate_report_with_comments(
    org: str,
    project: str,
    milestone_id: Optional[int] = None,
    milestone_title: Optional[str] = None,
    header: str = "### 🐛 Describe the bug",
    from_issue_number: Optional[int] = None,
) -> str:
    """
    Generate milestone report and merge in items from issue comments.

    This extends generate_milestone_report by also extracting items
    referenced in comments of a tracking issue.

    Uses a dictionary to ensure each issue/PR is listed only once,
    groups issues with their corresponding PRs, and adds [cherry-pick] prefix
    only to PRs from the tracker issue that are listed as "Link to release branch PR:".
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

    # Fetch all issues and PRs from milestone
    items = get_milestone_issues(org, project, milestone_id)
    print(f"Found {len(items)} total items in milestone")

    # Filter out items with "release-feature-request" label and "Release tracker" in title
    filtered_items = [
        item
        for item in items
        if not has_label(item, "release-feature-request")
        and "Release tracker" not in item.get("title", "")
    ]

    # Dictionary to track all items: {number: item_data}
    # This ensures each issue/PR is listed only once
    items_dict: Dict[int, Dict[str, Any]] = {}

    # Set to track which items should have [cherry-pick] prefix
    cherry_pick_numbers: Set[int] = set()

    # Separate into issues and PRs
    issues = [item for item in filtered_items if not is_pull_request(item)]
    prs = [item for item in filtered_items if is_pull_request(item)]
    pr_by_number = {pr["number"]: pr for pr in prs}

    print(f"Processing {len(issues)} issues and {len(prs)} PRs from milestone")

    # Build mapping of issues to their linked PRs
    issue_to_prs = build_issue_pr_mapping(org, project, filtered_items)

    # Track which PRs are linked to issues
    linked_pr_numbers: Set[int] = set()
    for pr_nums in issue_to_prs.values():
        linked_pr_numbers.update(pr_nums)

    # Add all issues to the dictionary with their linked PRs
    for issue in issues:
        issue_num = issue["number"]
        linked_prs = issue_to_prs.get(issue_num, [])
        items_dict[issue_num] = {
            "number": issue_num,
            "title": issue.get("title", ""),
            "url": issue["html_url"],
            "type": "issue",
            "state": issue["state"],
            "assignees": get_assignees(issue),
            "linked_prs": [
                pr_by_number[pr_num] for pr_num in linked_prs if pr_num in pr_by_number
            ],
        }
        # Mark linked PRs as processed
        for pr_num in linked_prs:
            if pr_num in pr_by_number:
                linked_pr_numbers.add(pr_num)

    # Add standalone PRs (not linked to any issue in the milestone)
    for pr in prs:
        if pr["number"] not in linked_pr_numbers and pr["number"] not in items_dict:
            items_dict[pr["number"]] = {
                "number": pr["number"],
                "title": pr.get("title", ""),
                "url": pr["html_url"],
                "type": "pr",
                "state": pr["state"],
                "assignees": get_assignees(pr),
                "linked_prs": [],
            }

    # Now extract "Link to release branch PR:" items from tracker issue comments if provided
    if from_issue_number is not None:
        print(
            f"\nExtracting 'Link to release branch PR:' items from issue #{from_issue_number} comments..."
        )

        # Get release branch PRs from comments
        release_branch_prs = extract_release_branch_prs_from_comments(
            org, project, from_issue_number
        )

        print(f"Found {len(release_branch_prs)} release branch PRs in comments")

        # Add these PRs to items_dict if not already present, and mark them for [cherry-pick]
        # Only include PRs that are merged (not open)
        skipped_open = 0
        for pr_num, pr_info in release_branch_prs.items():
            if pr_num not in items_dict:
                try:
                    pr_data = fetch_json(
                        f"https://api.github.com/repos/{org}/{project}/pulls/{pr_num}"
                    )

                    # Skip PRs that are still open or not merged
                    if pr_data.get("state") == "open" or not pr_data.get(
                        "merged", False
                    ):
                        skipped_open += 1
                        continue

                    cherry_pick_numbers.add(pr_num)  # Mark for [cherry-pick] prefix
                    items_dict[pr_num] = {
                        "number": pr_num,
                        "title": pr_data.get("title", ""),
                        "url": pr_data["html_url"],
                        "type": "pr",
                        "state": pr_data["state"],
                        "merged": pr_data.get("merged", False),
                        "assignees": get_assignees(pr_data),
                        "linked_prs": [],
                        "from_comments": True,
                    }
                except Exception as e:
                    print(f"Warning: Could not fetch details for PR #{pr_num}: {e}")
            else:
                # PR already in items_dict from milestone, just mark for cherry-pick
                cherry_pick_numbers.add(pr_num)

        if skipped_open > 0:
            print(f"Skipped {skipped_open} PRs that are still open or not merged")

    # Generate report lines
    lines = [header, ""]

    # Sort items by number
    sorted_items = sorted(items_dict.values(), key=lambda x: x["number"])

    for item in sorted_items:
        checkbox = "[ ]"
        title = item["title"]
        url = item["url"]
        assignees = item["assignees"]
        item_linked_prs: List[Dict[str, Any]] = item.get("linked_prs", [])

        # Add [cherry-pick] prefix only if this item is from the tracker issue
        is_cherry_pick = item["number"] in cherry_pick_numbers
        prefix = "[cherry-pick] " if is_cherry_pick else ""

        # Build the line
        if item_linked_prs:
            # Issue with linked PRs - show them side by side
            pr_links = " | ".join(str(pr["html_url"]) for pr in item_linked_prs)
            if assignees:
                lines.append(
                    f"- {checkbox} {prefix}{title} {url} | {pr_links} - {assignees}"
                )
            else:
                lines.append(f"- {checkbox} {prefix}{title} {url} | {pr_links}")
        else:
            # Standalone issue or PR
            if assignees:
                lines.append(f"- {checkbox} {prefix}{title} {url} - {assignees}")
            else:
                lines.append(f"- {checkbox} {prefix}{title} {url}")

    print(f"\nTotal unique items in report: {len(items_dict)}")
    print(f"Items with [cherry-pick] prefix: {len(cherry_pick_numbers)}")

    return "\n".join(lines)


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
    """Return checkbox based on state (always unchecked)."""
    return "[ ]"


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
        item for item in items if not has_label(item, "release-feature-request")
    ]
    excluded_count = len(items) - len(filtered_items)
    if excluded_count > 0:
        print(f"Excluded {excluded_count} items with 'release-feature-request' label")

    # Filter out items with "Release tracker" in title
    pre_filter_count = len(filtered_items)
    filtered_items = [
        item
        for item in filtered_items
        if "Release tracker" not in item.get("title", "")
    ]
    tracker_excluded = pre_filter_count - len(filtered_items)
    if tracker_excluded > 0:
        print(f"Excluded {tracker_excluded} items with 'Release tracker' in title")

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
            # Always use unchecked checkbox
            checkbox = "[ ]"

            # Format PR links
            pr_links = []
            for pr_num in sorted(linked_prs):
                if pr_num in pr_by_number:
                    pr_links.append(pr_by_number[pr_num]["html_url"])

            if pr_links:
                pr_text = " | " + " ".join(pr_links)
            else:
                pr_text = ""

            issue_title = issue.get("title", "")
            if assignees:
                lines.append(
                    f"- {checkbox} {issue_title} {issue_url}{pr_text} - {assignees}"
                )
            else:
                lines.append(f"- {checkbox} {issue_title} {issue_url}{pr_text}")
        else:
            # Issue without linked PRs
            checkbox = format_checkbox(issue["state"])
            issue_title = issue.get("title", "")
            if assignees:
                lines.append(f"- {checkbox} {issue_title} {issue_url} - {assignees}")
            else:
                lines.append(f"- {checkbox} {issue_title} {issue_url}")

    # Add standalone PRs (not linked to any issue in the milestone)
    standalone_prs = [pr for pr in prs if pr["number"] not in linked_pr_numbers]
    standalone_prs.sort(key=lambda x: x["number"])

    for pr in standalone_prs:
        pr_url = pr["html_url"]
        assignees = get_assignees(pr)
        checkbox = format_checkbox(pr["state"])
        pr_title = pr.get("title", "")

        if assignees:
            lines.append(f"- {checkbox} {pr_title} {pr_url} - {assignees}")
        else:
            lines.append(f"- {checkbox} {pr_title} {pr_url}")

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
    parser.add_argument(
        "--from-issue",
        type=int,
        help="Issue number to extract comments from and merge into the report (e.g., 170119)",
    )
    parser.add_argument(
        "--from-issue-url",
        type=str,
        help="Full GitHub issue URL to extract comments from (e.g., https://github.com/pytorch/pytorch/issues/170119)",
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

    # Handle --from-issue-url to extract issue number
    from_issue_number = args.from_issue
    if args.from_issue_url:
        parsed = parse_github_issue_url(args.from_issue_url)
        if parsed is None:
            print(f"Error: Invalid GitHub issue URL: {args.from_issue_url}")
            return
        url_org, url_project, from_issue_number = parsed
        print(f"Parsed issue URL: {url_org}/{url_project}#{from_issue_number}")

    # If only --from-issue or --from-issue-url is provided (no milestone), just list comments
    if args.milestone is None and args.milestone_id is None:
        if from_issue_number is not None:
            print_issue_comments_report(args.org, args.project, from_issue_number)
            return
        print("Error: Either --milestone or --milestone-id is required")
        print("Use --list-milestones to see available milestones")
        print("Or use --from-issue/--from-issue-url to extract comments from an issue")
        return

    try:
        report = generate_report_with_comments(
            org=args.org,
            project=args.project,
            milestone_id=args.milestone_id,
            milestone_title=args.milestone,
            header=args.header,
            from_issue_number=from_issue_number,
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
                milestone = get_milestone_by_title(
                    args.org, args.project, args.milestone
                )
                milestone_id = milestone["number"]
            items = get_milestone_issues(args.org, args.project, milestone_id)
            print_summary(items)

    except ValueError as e:
        print(f"Error: {e}")
    except HTTPError as e:
        print(f"HTTP Error: {e}")


if __name__ == "__main__":
    main()
