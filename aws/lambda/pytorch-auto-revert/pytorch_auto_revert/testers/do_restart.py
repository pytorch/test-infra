from ..workflow_checker import WorkflowRestartChecker


def do_restart_workflow(workflow: str, commit: str = None) -> None:
    checker = WorkflowRestartChecker()

    if commit:
        # Restart specific commit
        success = checker.restart_workflow(workflow, commit)
        print(f"Commit {commit}: {'✓ RESTARTED' if success else '✗ Not restarted'}")
    else:
        # Restart latest commit
        success = checker.restart_latest_workflow(workflow)
        print(f"Latest commit: {'✓ RESTARTED' if success else '✗ Not restarted'}")
