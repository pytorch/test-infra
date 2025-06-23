import sys
import argparse
from pathlib import Path

from ..workflow_checker import WorkflowRestartChecker


def workflow_restart_checker(workflow: str, commit: str = None, days: int = 7) -> None:
    checker = WorkflowRestartChecker()
    if commit:
        # Check specific commit
        result = checker.has_restarted_workflow(workflow, commit)
        print(f"Commit {commit}: {'✓ RESTARTED' if result else '✗ Not restarted'}")
    else:
        # Get all restarted commits in date range
        commits = checker.get_restarted_commits(workflow, days)
        print(f"Restarted commits for {workflow} (last {days} days):")
        if commits:
            for commit in sorted(commits):
                print(f"  ✓ {commit}")
        else:
            print("  No restarted workflows found")
