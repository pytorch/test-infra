from ..workflow_checker import WorkflowRestartChecker


def do_restart_workflow(workflow: str, commit: str) -> None:
    checker = WorkflowRestartChecker()

    # Restart specific commit
    success = checker.restart_workflow(workflow, commit)
    print(f"Commit {commit}: {'✓ RESTARTED' if success else '✗ Not restarted'}")
