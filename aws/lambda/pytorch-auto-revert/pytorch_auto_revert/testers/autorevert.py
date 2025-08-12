import logging
from collections import defaultdict

from ..autorevert_checker import AutorevertPatternChecker
from ..workflow_checker import WorkflowRestartChecker


def autorevert_checker(
    workflow_names: list[str],
    do_restart: bool,
    do_revert: bool,
    hours: int = 48,
    verbose: bool = False,
    dry_run: bool = False,
    ignore_common_errors=True,
):
    common_errors = {
        "GHA error",
        "GHA timeout",
        "sccache error",
    }

    # Initialize checker
    checker = AutorevertPatternChecker(
        workflow_names,
        hours,
        ignore_classification_rules=common_errors if ignore_common_errors else set(),
    )

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
                    f"  {i + 1:2d}. {commit.head_sha[:8]} ({commit.created_at.strftime('%m-%d %H:%M')}) - "
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
    reverts = checker.commits_reverted
    reverts_with_info = checker.commits_reverted_with_info

    # Categorize reverts
    reverts_by_category = defaultdict(set)
    for sha, info in reverts_with_info.items():
        category = info.get("category", "uncategorized")
        reverts_by_category[category].add(sha)

    # For recall calculation, we only consider non-ghfirst reverts
    not_found_reverts = reverts.copy()

    if patterns:
        print(
            f"✓ {len(patterns)} AUTOREVERT PATTERN{'S' if len(patterns) > 1 else ''} DETECTED"
        )

        # Create a revert checker (with extended lookback for finding reverts)
        revert_checker = AutorevertPatternChecker(
            workflow_names=[], lookback_hours=hours * 2
        )

        # Initialize workflow restart checker if needed
        restart_checker = WorkflowRestartChecker() if do_restart else None
        restarted_commits = []

        # Track reverts
        reverted_patterns = []

        false_positive = 0

        for i, pattern in enumerate(patterns, 1):
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

            # For clarity in naming
            workflow_name = pattern["workflow_name"]
            first_failing = pattern["newer_commits"][
                1
            ]  # the older of the two failing commits
            previous_commit = pattern[
                "older_commit"
            ]  # previously successful commit for the matched job
            revert_result = revert_checker.is_commit_reverted(first_failing)

            if revert_result:
                not_found_reverts.discard(first_failing)
                category = reverts_with_info.get(first_failing, {}).get(
                    "category", "uncategorized"
                )
                print(
                    f"✓ REVERTED ({category}): {first_failing} was reverted by {revert_result['revert_sha'][:8]} "
                    f"after {revert_result['hours_after_target']:.1f} hours"
                )
                reverted_patterns.append(pattern)
            else:
                false_positive += 1
                print(f"✗ NOT REVERTED: {first_failing} was not reverted")

                # Try to restart workflow if --do-restart flag is set and not already reverted
                if do_restart and restart_checker:
                    # Restart the first failing (older failing) and the previous (successful) commit
                    for target_commit in (first_failing, previous_commit):
                        if restart_checker.has_restarted_workflow(
                            workflow_name, target_commit
                        ):
                            print(
                                f"  ⟳ ALREADY RESTARTED: {workflow_name} for {target_commit[:8]}"
                            )
                            continue
                        if dry_run:
                            print(
                                f"  ⟳ DRY RUN: Would restart {workflow_name} for {target_commit[:8]}"
                            )
                            restarted_commits.append((workflow_name, target_commit))
                        else:
                            success = restart_checker.restart_workflow(
                                workflow_name, target_commit
                            )
                            if success:
                                print(
                                    f"  ✓ RESTARTED: {workflow_name} for {target_commit[:8]}"
                                )
                                restarted_commits.append((workflow_name, target_commit))
                            else:
                                print(
                                    f"  ✗ FAILED TO RESTART: {workflow_name} for {target_commit[:8]}"
                                )

                # Secondary verification: compare first failing vs previous on restarted runs.
                if do_revert:
                    try:
                        if checker.confirm_commit_caused_failure_on_restarted(pattern):
                            if dry_run:
                                print(
                                    f"  ⚠ DRY RUN: Would record REVERT for {first_failing[:8]} ({workflow_name})"
                                )
                            else:
                                print(
                                    f"  ⚠ REVERT recorded for {first_failing[:8]} ({workflow_name})"
                                )
                    except Exception as e:
                        logging.warning(
                            f"Secondary verification failed for {first_failing[:8]} ({workflow_name}): {e}"
                        )

            if verbose:
                print(f"Failed jobs ({len(pattern['failed_job_names'])}):")
                for job in pattern["failed_job_names"][:5]:
                    print(f"  - {job}")
                if len(pattern["failed_job_names"]) > 5:
                    print(f"  ... and {len(pattern['failed_job_names']) - 5} more")

                # Job coverage overlap logging removed (older_job_coverage dropped from pattern)

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

        len_patterns = len(patterns)
        len_reverted_patterns = len(reverted_patterns)
        ratio_revert_patterns = len_reverted_patterns / len_patterns if len_patterns > 0 else 0
        print(f"Auto revert patterns detected: {len(patterns)}")
        print(
            "Actual reverts inside auto revert patterns detected (%): "
            + f"{len_reverted_patterns} ({ratio_revert_patterns * 100:.1f}%)"
        )
        print(f"Total revert commits in period: {len(reverts)}")

        # Show breakdown by category
        if reverts_by_category:
            print("\nRevert categories:")
            for category, shas in sorted(
                reverts_by_category.items(), key=lambda x: len(x[1]), reverse=True
            ):
                percentage = len(shas) / len(reverts) * 100
                print(f"  {category}: {len(shas)} ({percentage:.1f}%)")

        # Calculate non-ghfirst metrics
        non_ghfirst_reverts = set()
        for sha in reverts:
            if (
                reverts_with_info.get(sha, {}).get("category", "uncategorized")
                != "ghfirst"
            ):
                non_ghfirst_reverts.add(sha)

        not_found_non_ghfirst = not_found_reverts & non_ghfirst_reverts

        print(f"\nTotal reverts excluding ghfirst: {len(non_ghfirst_reverts)}")

        # Calculate recall based on non-ghfirst reverts only
        len_non_ghfirst_reverts = len(non_ghfirst_reverts)
        len_not_found_non_ghfirst = len(not_found_non_ghfirst)
        ratio_non_ghfirst_reverts = len_not_found_non_ghfirst / len_non_ghfirst_reverts if len_non_ghfirst_reverts > 0 else 0
        # recall_non_ghfirst = 1 - ratio_non_ghfirst_reverts
        print(
            "Reverts (excluding ghfirst) that dont match any auto revert pattern detected (%): "
            + f"({len_not_found_non_ghfirst}) ({ratio_non_ghfirst_reverts * 100:.1f}%)"
        )

        len_reverts_with_info = len(reverts_with_info)
        stats_precision = len_reverted_patterns / len_patterns if len_patterns > 0 else 0.0
        stats_recall = len_reverted_patterns / len_reverts_with_info if len_reverts_with_info > 0 else 0.0
        stats_f1 = (
            2 * stats_precision * stats_recall / (stats_precision + stats_recall)
            if (stats_precision + stats_recall) > 0
            else 0.0
        )

        print()
        print("*********************************************************************")
        print("STATS SUMMARY:")
        print(f" PRECISION: {stats_precision * 100:.1f}%")
        print(f" RECALL: {stats_recall * 100:.1f}%")
        print(f" F1: {stats_f1 * 100:.1f}%")
        print("*********************************************************************")
        print()

        workflow_statistics = defaultdict(
            lambda: {"match_pattern": 0, "reverts": 0, "reverts_non_ghfirst": 0}
        )
        for pattern in patterns:
            workflow_statistics[pattern["workflow_name"]]["match_pattern"] += 1
            second_commit = pattern["newer_commits"][1]
            if second_commit in reverts:
                workflow_statistics[pattern["workflow_name"]]["reverts"] += 1
                # Check if it's non-ghfirst
                if second_commit in non_ghfirst_reverts:
                    workflow_statistics[pattern["workflow_name"]][
                        "reverts_non_ghfirst"
                    ] += 1

        print("Per workflow precision:")
        for workflow, stats in workflow_statistics.items():
            precision = (
                stats["reverts"] / stats["match_pattern"] * 100
                if stats["match_pattern"] > 0
                else 0.0
            )
            precision_non_ghfirst = (
                stats["reverts_non_ghfirst"] / stats["match_pattern"] * 100
                if stats["match_pattern"] > 0
                else 0.0
            )
            print(
                f"  {workflow}: {stats['reverts']} reverts out of {stats['match_pattern']} patterns ({precision:.1f}%)"
                f" [excluding ghfirst: {stats['reverts_non_ghfirst']} ({precision_non_ghfirst:.1f}%)]"
            )

        if reverted_patterns:
            print("\nReverted patterns:")
            for pattern in reverted_patterns:
                second_commit = pattern["newer_commits"][1]
                category = reverts_with_info.get(second_commit, {}).get(
                    "category", "uncategorized"
                )
                print(
                    f"  - {pattern['failure_rule']}: {second_commit[:8]} ({category})"
                )

        # Show restart summary if applicable
        if do_restart and restarted_commits:
            print(f"\nRestarted workflows: {len(restarted_commits)}")
            for workflow, commit in restarted_commits:
                print(f"  - {workflow} for {commit[:8]}")

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
                        f"  {i + 1}. {commit.head_sha[:8]}: {len(failures)} unique failure types"
                    )
                    if failures:
                        for rule in list(failures)[:2]:
                            print(f"     - {rule}")
                        if len(failures) > 2:
                            print(f"     ... and {len(failures) - 2} more")
