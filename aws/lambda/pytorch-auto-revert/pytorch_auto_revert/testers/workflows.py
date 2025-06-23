from ..autorevert_checker import AutorevertPatternChecker
from ..clickhouse_client_helper import CHCliFactory


def autorevert_checker(
    workflow_names: list[str], hours: int = 48, verbose: bool = False
):
    # Initialize checker
    checker = AutorevertPatternChecker(workflow_names, hours)

    # Fetch data
    if verbose:
        workflows_str = ", ".join(workflow_names)
        print(f"Fetching commits for workflow(s) '{workflows_str}' (last {hours}h)...")

    # For single workflow, show commit details
    if len(workflow_names) == 1:
        commits = checker.workflow_commits

        if not commits:
            print(
                f"No commit data found for workflow '{workflow_names[0]}' in last {hours}h"
            )
            return 1

        if verbose:
            print(f"Found {len(commits)} commits with job data")
            print("\nRecent commits:")
            for i, commit in enumerate(commits[:10]):
                failed_count = len(commit.failed_jobs)
                total_count = len(commit.jobs)
                pending = " (PENDING)" if commit.has_pending_jobs else ""
                print(
                    f"  {i+1:2d}. {commit.head_sha[:8]} ({commit.created_at.strftime('%m-%d %H:%M')}) - "
                    f"{failed_count:2d}/{total_count:2d} failed{pending}"
                )
    else:
        # For multiple workflows, show summary
        if verbose:
            print("\nCommit data by workflow:")
            for workflow in workflow_names:
                commits = checker.get_workflow_commits(workflow)
                print(f"  {workflow}: {len(commits)} commits")

    # Detect patterns
    patterns = checker.detect_autorevert_pattern()

    if patterns:
        print(
            f"✓ {len(patterns)} AUTOREVERT PATTERN{'S' if len(patterns) > 1 else ''} DETECTED"
        )

        # Create a revert checker (with extended lookback for finding reverts)
        revert_checker = AutorevertPatternChecker(
            CHCliFactory().client, workflow_names=[], lookback_hours=hours * 2
        )

        # Track reverts
        reverted_patterns = []

        for i, pattern in enumerate(patterns, 1):
            if len(patterns) > 1:
                print(f"\nPattern #{i}:")

            print(f"Failure rule: '{pattern['failure_rule']}'")
            print(
                f"Recent commits with failure: {' '.join(sha[:8] for sha in pattern['newer_commits'])}"
            )
            print(f"Older commit without failure: {pattern['older_commit'][:8]}")

            # Show additional workflows if detected
            if "additional_workflows" in pattern:
                print(
                    f"Also detected in {len(pattern['additional_workflows'])} other workflow(s):"
                )
                for additional in pattern["additional_workflows"]:
                    print(
                        f"  - {additional['workflow_name']}: {additional['failure_rule']}"
                    )

            # Check if the second commit (older of the two failures) was reverted
            second_commit = pattern["newer_commits"][1]
            revert_result = revert_checker.is_commit_reverted(second_commit)

            if revert_result:
                print(
                    f"✓ REVERTED: {second_commit[:8]} was reverted by {revert_result['revert_sha'][:8]} "
                    f"after {revert_result['hours_after_target']:.1f} hours"
                )
                reverted_patterns.append(pattern)
            else:
                print(f"✗ NOT REVERTED: {second_commit[:8]} was not reverted")

            if verbose:
                print(f"Failed jobs ({len(pattern['failed_job_names'])}):")
                for job in pattern["failed_job_names"][:5]:
                    print(f"  - {job}")
                if len(pattern["failed_job_names"]) > 5:
                    print(f"  ... and {len(pattern['failed_job_names']) - 5} more")

                print(f"Job coverage overlap ({len(pattern['older_job_coverage'])}):")
                for job in pattern["older_job_coverage"][:3]:
                    print(f"  - {job}")
                if len(pattern["older_job_coverage"]) > 3:
                    print(f"  ... and {len(pattern['older_job_coverage']) - 3} more")

                if revert_result and verbose:
                    print(f"Revert message: {revert_result['revert_message'][:100]}...")

        # Print summary statistics
        print("\n" + "=" * 50)
        print("SUMMARY STATISTICS")
        print("=" * 50)
        workflows_str = ", ".join(workflow_names)
        print(f"Workflow(s): {workflows_str}")
        print(f"Timeframe: {hours} hours")

        # Total commits across all workflows
        total_commits = sum(
            len(checker.get_workflow_commits(w)) for w in workflow_names
        )
        print(f"Commits checked: {total_commits}")

        print(f"Patterns detected: {len(patterns)}")
        print(
            f"Actual reverts: {len(reverted_patterns)} ({len(reverted_patterns)/len(patterns)*100:.1f}%)"
        )

        if reverted_patterns:
            print("\nReverted patterns:")
            for pattern in reverted_patterns:
                print(
                    f"  - {pattern['failure_rule']}: {pattern['newer_commits'][1][:8]}"
                )

    else:
        print("✗ No autorevert patterns detected")

        if verbose and len(workflow_names) == 1:
            commits = checker.workflow_commits
            if len(commits) >= 3:
                print("\nDiagnostic (first 3 commits):")
                for i, commit in enumerate(commits[:3]):
                    failures = {
                        j.classification_rule
                        for j in commit.failed_jobs
                        if j.classification_rule
                    }
                    print(
                        f"  {i+1}. {commit.head_sha[:8]}: {len(failures)} unique failure types"
                    )
                    if failures:
                        for rule in list(failures)[:2]:
                            print(f"     - {rule}")
                        if len(failures) > 2:
                            print(f"     ... and {len(failures) - 2} more")
