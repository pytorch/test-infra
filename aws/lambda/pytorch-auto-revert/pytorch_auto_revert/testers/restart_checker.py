from typing import FrozenSet, Optional

from ..workflow_checker import WorkflowRestartChecker
from ..workflow_resolver import WorkflowResolver


def workflow_restart_checker(workflow: str, commit: str = None, days: int = 7) -> None:
    if commit:
        # Check specific commit
        result = WorkflowRestartChecker().has_restarted_workflow(workflow, commit)
        print(f"Commit {commit}: {'✓ RESTARTED' if result else '✗ Not restarted'}")
    else:
        # Get all restarted commits in date range
        commits = WorkflowRestartChecker().get_restarted_commits(workflow, days)
        print(f"Restarted commits for {workflow} (last {days} days):")
        if commits:
            for commit in sorted(commits):
                print(f"  ✓ {commit}")
        else:
            print("  No restarted workflows found")


def dispatch_workflow_restart(
    workflow: str,
    commit: str,
    jobs: Optional[str] = None,
    tests: Optional[str] = None,
    repo: str = "pytorch/pytorch",
    dry_run: bool = False,
) -> None:
    """Dispatch a workflow restart with optional job/test filters.

    Args:
        workflow: Workflow name (e.g., "trunk" or "trunk.yml")
        commit: Commit SHA to restart
        jobs: Space-separated job display names to filter (or None for all)
        tests: Space-separated test module paths to filter (or None for all)
        repo: Repository in owner/repo format
        dry_run: If True, only show what would be dispatched
    """
    # Parse filter strings to frozensets
    jobs_to_include: FrozenSet[str] = frozenset(jobs.split()) if jobs else frozenset()
    tests_to_include: FrozenSet[str] = (
        frozenset(tests.split()) if tests else frozenset()
    )

    # Get workflow resolver and check input support
    resolver = WorkflowResolver.get(repo)
    wf_ref = resolver.require(workflow)
    input_support = resolver.get_input_support(workflow)

    print(f"Workflow: {wf_ref.display_name} ({wf_ref.file_name})")
    print(f"Commit: {commit}")
    print(f"Repository: {repo}")
    print()

    # Show input support status
    print("Workflow input support:")
    print(
        f"  jobs-to-include:  {'✓ supported' if input_support.jobs_to_include else '✗ not supported'}"
    )
    print(
        f"  tests-to-include: {'✓ supported' if input_support.tests_to_include else '✗ not supported'}"
    )
    print()

    # Show what filters will be applied
    effective_jobs = jobs_to_include if input_support.jobs_to_include else frozenset()
    effective_tests = (
        tests_to_include if input_support.tests_to_include else frozenset()
    )

    if jobs_to_include:
        if input_support.jobs_to_include:
            print(f"Jobs filter: {' '.join(sorted(jobs_to_include))}")
        else:
            print(
                f"Jobs filter: {' '.join(sorted(jobs_to_include))} (IGNORED - workflow doesn't support)"
            )

    if tests_to_include:
        if input_support.tests_to_include:
            print(f"Tests filter: {' '.join(sorted(tests_to_include))}")
        else:
            print(
                f"Tests filter: {' '.join(sorted(tests_to_include))} (IGNORED - workflow doesn't support)"
            )

    if not jobs_to_include and not tests_to_include:
        print("Filters: none (full CI run)")

    print()

    if dry_run:
        print("DRY RUN - would dispatch workflow with above settings")
        return

    # Dispatch the workflow
    checker = WorkflowRestartChecker(
        repo_owner=repo.split("/")[0], repo_name=repo.split("/")[1]
    )
    checker.restart_workflow(
        workflow,
        commit,
        jobs_to_include=effective_jobs,
        tests_to_include=effective_tests,
    )
    print("✓ Workflow dispatched successfully")
