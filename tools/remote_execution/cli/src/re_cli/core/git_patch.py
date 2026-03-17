"""Git patch utilities for the Remote Execution CLI."""

import os

from .core_types import console
from .git_helper import GitHelper


def check_uncommitted_changes(repo_path: str = None) -> bool:
    """Check for uncommitted changes in a git repository.

    Args:
        repo_path: Path to the repository (defaults to current directory)

    Returns:
        True if there are uncommitted changes, False otherwise
    """
    cwd = os.path.expanduser(repo_path) if repo_path else os.getcwd()
    git = GitHelper(cwd)
    has_changes = git.has_uncommitted_changes()

    if has_changes:
        console.print()
        console.print(f"[red]Error: You have uncommitted changes in {cwd}[/red]")
        console.print("[yellow]Please commit all your changes first:[/yellow]")
        console.print("  git add -A && git commit -m 'your message'")

    return has_changes


def get_patch_metadata(
    repo_path: str = None,
    commit: str = None,
    repo: str = None,
) -> tuple[dict, str, str]:
    """Get git patch metadata and resolve commit/repo.
    Returns:
        Tuple of (patch_metadata, resolved_commit, resolved_repo)
    """
    cwd = os.path.expanduser(repo_path) if repo_path else os.getcwd()
    console.print(f"[blue]Detecting local changes from:[/blue] {cwd}")

    git = GitHelper(cwd)
    remote_url = git.get_remote_url()
    repo_name = git.get_repo_name()
    current_branch = git.get_current_branch()
    base_commit = git.resolve_base_commit(commit)

    console.print(f"[blue]Base commit:[/blue] {base_commit[:12]}")

    changed_files = git.get_changed_files(base_commit, committed_only=True)

    patch_metadata = {
        "repo_name": repo_name,
        "remote_url": remote_url,
        "base_commit": base_commit,
        "branch": current_branch,
        "changed_files": changed_files,
    }

    resolved_commit = commit or base_commit
    resolved_repo = repo or remote_url

    if changed_files:
        console.print(f"[blue]Changed files:[/blue] {len(changed_files)}")

        # Create patch content
        patch_content = git.create_patch(base_commit, committed_only=True)
        patch_metadata["patch_content"] = patch_content
        console.print(
            f"  [green]✓[/green] Patch generated ({len(patch_content)} bytes)"
        )
    else:
        console.print("[yellow]No committed changes - metadata only[/yellow]")

    return patch_metadata, resolved_commit, resolved_repo
