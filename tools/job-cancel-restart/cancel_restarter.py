#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "requests>=2.28.0",
# ]
# ///
"""Cancel and restart GitHub Actions workflow runs with stuck queued jobs.

Manual recovery tool for infrastructure incidents. Scans a repository for
workflow jobs stuck in 'queued' status beyond a configurable threshold,
then cancels and fully re-runs the affected workflow runs from scratch.

The full re-run is intentional: pytorch workflows have generator jobs whose
outputs determine what downstream jobs run. A partial re-run (failed-only)
would skip those generators, leaving downstream jobs without their inputs.

Flow:
  1. Fetch all queued/in-progress workflow runs (with optional workflow name filter)
  2. For each run, check if any jobs have been queued beyond the threshold
  3. Group stuck jobs by their parent workflow run (each run is only acted on once)
  4. Show the list of affected runs and ask for confirmation
  5. Cancel each run, wait for cancellation, then trigger a full re-run
"""

import argparse
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any

import requests

API_BASE = "https://api.github.com"
RUN_STATUSES_TO_CHECK = ("queued", "in_progress")

DEFAULT_REPO = "pytorch/pytorch"
DEFAULT_MAX_QUEUE_MINUTES = 60
DEFAULT_MAX_PAGES = 5
DEFAULT_MAX_CANCELLATIONS = 10
POLL_INTERVAL_SECONDS = 5
POLL_TIMEOUT_SECONDS = 120
RATE_LIMIT_RETRY_SECONDS = 60
MAX_RETRIES = 3


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Cancel and restart GitHub Actions jobs queued too long.",
    )
    parser.add_argument(
        "--repo",
        default=DEFAULT_REPO,
        help=f"GitHub repository as owner/repo (default: {DEFAULT_REPO})",
    )
    parser.add_argument(
        "--max-queue-time",
        type=int,
        default=DEFAULT_MAX_QUEUE_MINUTES,
        help=f"Max queue time in minutes before acting (default: {DEFAULT_MAX_QUEUE_MINUTES})",
    )
    parser.add_argument(
        "--token",
        default=os.getenv("GITHUB_TOKEN", ""),
        help="GitHub token (default: GITHUB_TOKEN env var)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=True,
        help="Only list stuck jobs, don't cancel/restart (default: True)",
    )
    parser.add_argument(
        "--no-dry-run",
        action="store_true",
        help="Actually cancel and restart stuck jobs",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=DEFAULT_MAX_PAGES,
        help=f"Max pages of runs to fetch per status, 100 runs/page (default: {DEFAULT_MAX_PAGES})",
    )
    parser.add_argument(
        "--max-cancellations",
        type=int,
        default=DEFAULT_MAX_CANCELLATIONS,
        help=f"Max number of runs to cancel in one invocation (default: {DEFAULT_MAX_CANCELLATIONS})",
    )
    parser.add_argument(
        "--workflow",
        action="append",
        default=[],
        help="Only include runs matching this workflow name (substring match, repeatable)",
    )
    parser.add_argument(
        "--exclude-workflow",
        action="append",
        default=[],
        help="Exclude runs matching this workflow name (substring match, repeatable)",
    )
    parser.add_argument(
        "--yes",
        "-y",
        action="store_true",
        help="Skip confirmation prompt in live mode",
    )
    args = parser.parse_args()

    if args.no_dry_run:
        args.dry_run = False
    if not args.token:
        print("Error: GITHUB_TOKEN not set. Use --token or set GITHUB_TOKEN env var.")
        sys.exit(1)
    if args.max_queue_time <= 0:
        print("Error: --max-queue-time must be a positive integer.")
        sys.exit(1)
    return args


def make_session(token: str) -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
    )
    return session


def api_get(
    session: requests.Session, url: str, params: dict[str, Any] | None = None
) -> requests.Response:
    """GET with rate-limit retry."""
    for attempt in range(MAX_RETRIES):
        resp = session.get(url, params=params)
        if resp.status_code == 403 and "rate limit" in resp.text.lower():
            retry_after = int(
                resp.headers.get("Retry-After", RATE_LIMIT_RETRY_SECONDS)
            )
            print(f"  Rate limited. Waiting {retry_after}s...")
            time.sleep(retry_after)
            continue
        if resp.status_code == 429:
            retry_after = int(
                resp.headers.get("Retry-After", RATE_LIMIT_RETRY_SECONDS)
            )
            print(f"  Rate limited (429). Waiting {retry_after}s...")
            time.sleep(retry_after)
            continue
        if resp.status_code >= 500 and attempt < MAX_RETRIES - 1:
            print(f"  Server error ({resp.status_code}), retrying...")
            time.sleep(2 ** attempt)
            continue
        return resp
    return resp  # return last response even if all retries failed


def api_post(
    session: requests.Session, url: str
) -> requests.Response:
    """POST with rate-limit retry."""
    for attempt in range(MAX_RETRIES):
        resp = session.post(url)
        if resp.status_code in (403, 429) and (
            "rate limit" in resp.text.lower() or resp.status_code == 429
        ):
            retry_after = int(
                resp.headers.get("Retry-After", RATE_LIMIT_RETRY_SECONDS)
            )
            print(f"  Rate limited. Waiting {retry_after}s...")
            time.sleep(retry_after)
            continue
        if resp.status_code >= 500 and attempt < MAX_RETRIES - 1:
            print(f"  Server error ({resp.status_code}), retrying...")
            time.sleep(2 ** attempt)
            continue
        return resp
    return resp


def paginated_get(
    session: requests.Session, url: str, params: dict[str, Any], max_pages: int
) -> list[dict[str, Any]]:
    """Fetch paginated results from the GitHub API."""
    all_items: list[dict[str, Any]] = []
    for page in range(1, max_pages + 1):
        page_params = {**params, "page": page, "per_page": 100}
        resp = api_get(session, url, page_params)
        if resp.status_code == 404:
            print(f"Error: Not found — {url}")
            print("Check that the repository exists and your token has access.")
            sys.exit(1)
        if resp.status_code == 401:
            print("Error: Authentication failed. Check your GITHUB_TOKEN.")
            sys.exit(1)
        resp.raise_for_status()
        data = resp.json()

        if "workflow_runs" in data:
            items = data["workflow_runs"]
        elif "jobs" in data:
            items = data["jobs"]
        else:
            items = data if isinstance(data, list) else []

        if not items:
            break
        all_items.extend(items)
    return all_items


def workflow_matches(
    run: dict[str, Any],
    include: list[str],
    exclude: list[str],
) -> bool:
    """Check if a run's workflow name passes include/exclude filters."""
    name = (run.get("name") or "").lower()
    if exclude:
        for pattern in exclude:
            if pattern.lower() in name:
                return False
    if include:
        return any(pattern.lower() in name for pattern in include)
    return True


def get_queued_runs(
    session: requests.Session,
    repo: str,
    max_pages: int,
    workflow_include: list[str],
    workflow_exclude: list[str],
) -> list[dict[str, Any]]:
    """Fetch all runs that might contain queued jobs, deduplicated and filtered."""
    url = f"{API_BASE}/repos/{repo}/actions/runs"
    seen_ids: set[int] = set()
    unique_runs: list[dict[str, Any]] = []
    filtered_count = 0

    for status in RUN_STATUSES_TO_CHECK:
        runs = paginated_get(session, url, {"status": status}, max_pages)
        count = 0
        for run in runs:
            run_id = run.get("id")
            if not run_id or run_id in seen_ids:
                continue
            seen_ids.add(run_id)
            if not workflow_matches(run, workflow_include, workflow_exclude):
                filtered_count += 1
                continue
            unique_runs.append(run)
            count += 1
        print(f"  Found {count} runs with status={status}")

    if filtered_count:
        print(f"  ({filtered_count} runs excluded by workflow filter)")

    return unique_runs


def get_queued_jobs_for_run(
    session: requests.Session, repo: str, run_id: int
) -> list[dict[str, Any]]:
    """Get jobs with status 'queued' for a specific run."""
    url = f"{API_BASE}/repos/{repo}/actions/runs/{run_id}/jobs"
    jobs = paginated_get(session, url, {"filter": "latest"}, max_pages=10)
    return [j for j in jobs if j.get("status") == "queued"]


def compute_queue_minutes(job: dict[str, Any]) -> float:
    """Compute how many minutes a job has been queued."""
    created_str = job.get("created_at", "")
    if not created_str:
        return 0.0
    created = datetime.fromisoformat(created_str.replace("Z", "+00:00"))
    now = datetime.now(timezone.utc)
    return (now - created).total_seconds() / 60.0


def wait_for_run_cancelled(
    session: requests.Session, repo: str, run_id: int
) -> bool:
    """Poll until a run reaches completed/cancelled state. Returns True if confirmed."""
    url = f"{API_BASE}/repos/{repo}/actions/runs/{run_id}"
    elapsed = 0
    while elapsed < POLL_TIMEOUT_SECONDS:
        resp = api_get(session, url)
        if resp.status_code == 200:
            data = resp.json()
            status = data.get("status")
            conclusion = data.get("conclusion")
            if status == "completed":
                return True
            if conclusion == "cancelled":
                return True
        time.sleep(POLL_INTERVAL_SECONDS)
        elapsed += POLL_INTERVAL_SECONDS
    return False


def cancel_run(session: requests.Session, repo: str, run_id: int) -> bool:
    """Cancel a workflow run. Returns True on success."""
    url = f"{API_BASE}/repos/{repo}/actions/runs/{run_id}/cancel"
    resp = api_post(session, url)
    if resp.status_code == 202:
        return True
    # 409 = already completed/cancelled — not an error
    if resp.status_code == 409:
        print("    Run already completed/cancelled.")
        return True
    print(f"    Warning: cancel returned {resp.status_code}: {resp.text}")
    return False


def rerun_workflow(session: requests.Session, repo: str, run_id: int) -> bool:
    """Re-run an entire workflow run from scratch. Returns True on success."""
    url = f"{API_BASE}/repos/{repo}/actions/runs/{run_id}/rerun"
    resp = api_post(session, url)
    if resp.status_code == 201:
        return True
    print(f"    Warning: rerun returned {resp.status_code}: {resp.text}")
    return False


def print_stuck_runs(
    stuck_by_run: dict[int, list[dict[str, Any]]],
    run_info: dict[int, dict[str, Any]],
) -> None:
    """Print a numbered list of workflow runs with their stuck jobs."""
    for idx, (run_id, jobs) in enumerate(stuck_by_run.items(), 1):
        run = run_info[run_id]
        workflow = run.get("name", "?")
        branch = run.get("head_branch", "?")
        run_num = run.get("run_number", "?")
        url = run.get("html_url", "N/A")
        print(f"  {idx}. [{workflow}] Run #{run_num} on branch '{branch}'")
        print(f"     URL: {url}")
        print(f"     Stuck jobs ({len(jobs)}):")
        for job in jobs:
            queue_min = compute_queue_minutes(job)
            labels = ", ".join(job.get("labels", []))
            name = job.get("name", "unknown")
            print(f"       - {name} (queued {queue_min:.0f}m, labels: [{labels}])")
        print()


def main() -> None:
    args = parse_args()
    session = make_session(args.token)

    mode = "DRY RUN" if args.dry_run else "LIVE"
    print(f"[{mode}] Scanning {args.repo} for jobs queued > {args.max_queue_time}m")
    if args.workflow:
        print(f"  Include workflows: {', '.join(args.workflow)}")
    if args.exclude_workflow:
        print(f"  Exclude workflows: {', '.join(args.exclude_workflow)}")
    print()

    # Phase 1: Fetch runs
    print("Fetching workflow runs...")
    runs = get_queued_runs(
        session, args.repo, args.max_pages, args.workflow, args.exclude_workflow
    )
    print(f"Total unique runs to check: {len(runs)}\n")

    # Phase 2: Find stuck jobs
    stuck_by_run: dict[int, list[dict[str, Any]]] = {}
    run_info: dict[int, dict[str, Any]] = {}

    for i, run in enumerate(runs):
        run_id = run.get("id")
        if not run_id:
            continue
        if (i + 1) % 50 == 0:
            print(f"  Checking run {i + 1}/{len(runs)}...")

        queued_jobs = get_queued_jobs_for_run(session, args.repo, run_id)
        for job in queued_jobs:
            queue_min = compute_queue_minutes(job)
            if queue_min >= args.max_queue_time:
                stuck_by_run.setdefault(run_id, []).append(job)
                run_info[run_id] = run

    if not stuck_by_run:
        print("No stuck jobs found.")
        return

    total_stuck = sum(len(jobs) for jobs in stuck_by_run.values())
    print(f"\nFound {total_stuck} stuck job(s) across {len(stuck_by_run)} workflow run(s):\n")
    print_stuck_runs(stuck_by_run, run_info)

    if args.dry_run:
        print("Dry run — no actions taken. Use --no-dry-run to cancel and restart.")
        return

    # Phase 3: Confirm and execute
    run_ids_to_process = list(stuck_by_run.keys())
    if len(run_ids_to_process) > args.max_cancellations:
        print(
            f"Capping at --max-cancellations={args.max_cancellations} "
            f"(of {len(run_ids_to_process)} affected runs).\n"
        )
        run_ids_to_process = run_ids_to_process[: args.max_cancellations]

    print("Runs to cancel and restart:")
    for idx, run_id in enumerate(run_ids_to_process, 1):
        run = run_info[run_id]
        n_jobs = len(stuck_by_run[run_id])
        print(f"  {idx}. [{run.get('name', '?')}] Run #{run.get('run_number', '?')} ({n_jobs} stuck job(s))")
    print()

    if not args.yes:
        answer = input(
            f"Cancel and restart these {len(run_ids_to_process)} run(s)? [y/N] "
        ).strip().lower()
        if answer != "y":
            print("Aborted.")
            return

    print(f"\nProcessing {len(run_ids_to_process)} run(s)...\n")

    succeeded: list[int] = []
    failed: list[tuple[int, str]] = []

    for idx, run_id in enumerate(run_ids_to_process, 1):
        run = run_info[run_id]
        run_label = f"[{idx}/{len(run_ids_to_process)}] [{run.get('name', '?')}] Run #{run.get('run_number', '?')}"
        print(f"  {run_label}...")

        if not cancel_run(session, args.repo, run_id):
            failed.append((run_id, "cancel failed"))
            continue

        print("    Waiting for cancellation to complete...")
        if not wait_for_run_cancelled(session, args.repo, run_id):
            print(f"    Warning: timed out waiting for cancellation ({POLL_TIMEOUT_SECONDS}s).")
            print("    Attempting rerun anyway...")

        if rerun_workflow(session, args.repo, run_id):
            print("    Full re-run triggered (entire workflow from scratch).")
            succeeded.append(run_id)
        else:
            failed.append((run_id, "cancel succeeded but rerun failed"))
        print()

    # Summary
    print("=" * 60)
    print(f"  Succeeded: {len(succeeded)}")
    print(f"  Failed:    {len(failed)}")
    if failed:
        print("\n  Failed runs:")
        for run_id, reason in failed:
            run = run_info[run_id]
            print(f"    Run #{run.get('run_number', '?')} (id={run_id}): {reason}")
            print(f"      URL: {run.get('html_url', 'N/A')}")
    print("=" * 60)

    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
