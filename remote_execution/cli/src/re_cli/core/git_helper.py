"""Git helper utilities for Blast CLI."""

import os
import subprocess


class GitHelper:
    """Helper class for git operations."""

    def __init__(self, cwd=None):
        """Initialize GitHelper with optional working directory."""
        self.cwd = cwd

    def run_git(self, *args):
        """Run a git command and return output."""
        result = subprocess.run(
            ["git"] + list(args),
            capture_output=True,
            text=True,
            cwd=self.cwd,
        )
        if result.returncode != 0:
            raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr}")
        return result.stdout.strip()

    def get_git_root(self):
        """Get the root directory of the git repo."""
        return self.run_git("rev-parse", "--show-toplevel")

    def get_remote_url(self):
        """Get the origin remote URL."""
        try:
            url = self.run_git("remote", "get-url", "origin")
            # Convert SSH to HTTPS for easier cloning
            if url.startswith("git@github.com:"):
                url = url.replace("git@github.com:", "https://github.com/")
            if url.endswith(".git"):
                url = url[:-4]
            return url
        except RuntimeError:
            return None

    def get_repo_name(self):
        """Get the repository name from the remote URL or directory."""
        url = self.get_remote_url()
        if url:
            # Extract repo name from URL (e.g., "pytorch/pytorch" from GitHub URL)
            parts = url.rstrip("/").split("/")
            if len(parts) >= 2:
                return f"{parts[-2]}/{parts[-1]}"
        # Fallback to directory name
        root = self.get_git_root()
        return os.path.basename(root)

    def resolve_base_commit(self, base=None):
        """
        Resolve base reference to full commit SHA.

        If no base specified, auto-detect using merge-base with origin/main.
        This finds the commit where local branch diverged from remote.
        """
        if base:
            return self.run_git("rev-parse", base)

        # Auto-detect: find merge-base with origin/main or origin/master
        for ref in ["origin/main", "origin/master"]:
            try:
                # merge-base finds common ancestor between HEAD and remote
                merge_base = self.run_git("merge-base", "HEAD", ref)
                return merge_base
            except RuntimeError:
                continue

        raise RuntimeError(
            "Could not find origin/main or origin/master. Use --base to specify."
        )

    def get_current_branch(self):
        """Get the current branch name."""
        try:
            return self.run_git("rev-parse", "--abbrev-ref", "HEAD")
        except RuntimeError:
            return None

    def has_uncommitted_changes(self):
        """Check if there are any uncommitted changes (staged or unstaged)."""
        # Check for staged or unstaged changes
        status = self.run_git("status", "--porcelain")
        return bool(status.strip())

    def create_patch(self, base_commit, committed_only=False):
        """Create a git diff patch.

        Args:
            base_commit: The base commit to diff from
            committed_only: If True, only include committed changes (base..HEAD),
                           otherwise include working tree changes (base)
        """
        # Don't use run_git() here because it strips the output,
        # and git apply requires the patch to end with a newline
        if committed_only:
            # Only committed changes: base..HEAD
            cmd = ["git", "diff", f"{base_commit}..HEAD"]
        else:
            # All changes including uncommitted: base to working tree
            cmd = ["git", "diff", base_commit]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=self.cwd,
        )
        if result.returncode != 0:
            raise RuntimeError(f"git diff failed: {result.stderr}")
        return result.stdout  # Don't strip - preserve trailing newline

    def get_changed_files(self, base_commit, committed_only=False):
        """Get list of changed files.

        Args:
            base_commit: The base commit to diff from
            committed_only: If True, only include committed changes (base..HEAD)
        """
        if committed_only:
            output = self.run_git(
                "diff", "--name-only", f"{base_commit}..HEAD"
            )
        else:
            output = self.run_git("diff", "--name-only", base_commit)
        return [f for f in output.split("\n") if f]
