"""JobRunner - orchestrates multi-step job execution."""

import sys
import time

from rich.panel import Panel
from .core_types import StepConfig, TaskInfo, compute_topo_deps, console
from .artifacts import (
    build_artifacts_metadata,
    build_task_requests,
    upload_artifacts_to_s3,
)
from .git_patch import get_patch_metadata
from .log_stream import follow_all_steps


class JobRunner:
    """Runner for executing multi-step jobs."""

    def __init__(
        self,
        client,
        name: str,
        step_configs: list[StepConfig],
        script_builder_class: type = None,
    ):
        from .script_builder import RunnerScriptBuilder

        self.client = client
        self.name = name
        self.step_configs = step_configs
        self.num_steps = len(step_configs)
        self.script_builder_class = script_builder_class or RunnerScriptBuilder

        # Build api_steps from step_configs
        self.api_steps = self._build_api_steps()

        # Set during run
        self.run_id = None
        self.artifacts_path = None
        self.signed_url = None
        self.tasks_info: list[TaskInfo] = []
        self.raw = False  # Will be set in run()

    def _build_api_steps(self) -> list[dict]:
        """Build step definitions for API from step configs."""
        return [
            {
                "name": cfg.name,
                "task_type": cfg.task_type,
                "image": cfg.image,
                "script_name": cfg.get_script_name(i),
            }
            for i, cfg in enumerate(self.step_configs)
        ]

    def run(
        self,
        raw: bool = False,
        patch: bool = False,
        repo_path: str = None,
        commit: str = None,
        repo: str = None,
        repo_cache: str = None,
        follow: bool = False,
        dry_run: bool = False,
        as_json: bool = False,
    ):
        """Run the job.

        Args:
            raw: Use raw mode (no S3 upload)
            patch: Include git patch
            repo_path: Path to git repository
            commit: Git commit SHA
            repo: Git repo URL
            repo_cache: Optional repo cache path
            follow: Whether to follow logs after spawning
            dry_run: If True, print what would be done without executing
            as_json: If True and dry_run, output JSON instead of rich display
        """
        self.raw = raw
        if raw:
            if dry_run:
                console.print(
                    "[yellow]Dry run not supported in raw mode[/yellow]"
                )
                return
            self._run_raw_mode(follow=follow)
        else:
            self._run_normal_mode(
                patch=patch,
                repo_path=repo_path,
                commit=commit,
                repo=repo,
                repo_cache=repo_cache,
                follow=follow,
                dry_run=dry_run,
                as_json=as_json,
            )

    # =========================================================================
    # API 1: /run/create - get run_id, task_ids, signed_url
    # =========================================================================
    def _create(self, need_signed_url: bool = True) -> dict:
        """Call /run/create API.

        Args:
            need_signed_url: Whether to request signed URL for upload

        Returns:
            API response with run_id, tasks, signed_url (if requested)
        """
        result = self.client.create_run(
            name=self.name,
            steps=self.api_steps,
            need_signed_url=need_signed_url,
        )
        self.run_id = result["run_id"]
        self.artifacts_path = result.get("artifacts_path", "")
        self.signed_url = result.get("signed_url")
        self.crd_name = result.get("crd_name")  # Save CRD name for reuse

        # Build tasks_info
        deps = compute_topo_deps(self.num_steps)
        self.tasks_info = []
        for t in result["tasks"]:
            step_idx = t["step_index"]
            task_info = TaskInfo(
                task_id=t["task_id"],
                step_index=step_idx,
                step_name=t["step_name"],
                dependency=deps[step_idx],
                task_type=t["task_type"],
                image=self.api_steps[step_idx].get("image"),
                command=None,
                script_name=(
                    t.get("script_name")
                    or self.api_steps[step_idx].get("script_name")
                ),
            )
            self.tasks_info.append(task_info)

        return result

    # =========================================================================
    # API 2: /run/execute - finalize tasks + spawn first job
    # =========================================================================
    def _execute(self, task_requests: list, patch_metadata: dict = None):
        """Call /run/execute API."""
        first_task_env = task_requests[0]["env_vars"] if task_requests else {}
        self.client.execute_run(
            run_id=self.run_id,
            artifacts_path=self.artifacts_path,
            tasks=task_requests,
            patch_info=patch_metadata,
            first_task_env=first_task_env,
        )

    # =========================================================================
    # Run modes
    # =========================================================================
    def _run_raw_mode(self, follow: bool = False):
        """Run in raw mode (no S3 upload).

        Flow:
        1. /run/create (no signed_url)
        2. /run/execute
        """
        console.print("[blue]Creating run (raw mode)...[/blue]")

        self._create(need_signed_url=False)
        console.print(f"[blue]Run ID:[/blue] {self.run_id}")
        for t in self.tasks_info:
            # Raw mode: set command directly
            t.command = self.step_configs[t.step_index].get_command(
                raw_mode=True
            )
            console.print(
                f"  [green]✓[/green] Task {t.task_id} for '{t.step_name}'"
            )

        self.task_requests = build_task_requests(
            artifacts_path=self.artifacts_path,
            step_configs=self.step_configs,
            tasks_info=self.tasks_info,
            raw_mode=True,
            run_id=self.run_id,
        )

        console.print("[blue]Executing...[/blue]")
        self._execute(task_requests=self.task_requests)
        console.print("[green]✓ Job started[/green]")
        console.print("[dim]Steps will run sequentially.[/dim]")

        if follow:
            follow_all_steps(
                self.client, self.tasks_info, self.run_id, self.artifacts_path
            )

    def _run_normal_mode(
        self,
        patch: bool = False,
        repo_path: str = None,
        commit: str = None,
        repo: str = None,
        repo_cache: str = None,
        follow: bool = False,
        dry_run: bool = False,
        as_json: bool = False,
    ):
        """Run in normal mode with S3 upload.

        Flow:
        1. /run/create (get signed_url)
        2. upload to signed_url
        3. /run/execute
        """
        # Dry run mode: print what would be done without API calls
        if dry_run:
            self._print_dry_run_info(
                patch=patch,
                repo_path=repo_path,
                commit=commit,
                repo=repo,
                repo_cache=repo_cache,
                as_json=as_json,
            )
            return

        # API 1: /run/create
        console.print("[blue]Creating run...[/blue]", end=" ")
        create_start = time.time()
        try:
            self._create(need_signed_url=True)
        except Exception as e:
            console.quiet = False
            console.print(f"\n[red]Error creating run: {e}[/red]")
            sys.exit(1)
        console.print(f"[dim]({time.time() - create_start:.1f}s)[/dim]")
        self._print_job_info()

        # Handle patch if requested
        patch_metadata = None
        nonlocal_commit = commit
        nonlocal_repo = repo
        if patch:
            try:
                patch_metadata, nonlocal_commit, nonlocal_repo = (
                    get_patch_metadata(repo_path, commit, repo)
                )
            except Exception as e:
                console.print(f"[red]Error creating patch: {e}[/red]")
                sys.exit(1)

        # Build artifact data for bucket
        artifact_data: dict[Unknown, Unknown] = build_artifacts_metadata(
            run_id=self.run_id,
            name=self.name,
            artifacts_path=self.artifacts_path,
            step_configs=self.step_configs,
            tasks_info=self.tasks_info,
            patch_metadata=patch_metadata,
            commit=nonlocal_commit,
            repo=nonlocal_repo,
            script_builder_class=self.script_builder_class,
        )

        # Build task requests for api
        self.task_requests = build_task_requests(
            artifacts_path=self.artifacts_path,
            step_configs=self.step_configs,
            tasks_info=self.tasks_info,
            repo_cache=repo_cache,
            raw_mode=self.raw,
            commit=nonlocal_commit,
            repo=nonlocal_repo,
            run_id=self.run_id,
        )

        # Upload to S3
        console.print("[blue]Uploading artifacts...[/blue]", end=" ")
        upload_start = time.time()
        try:
            upload_artifacts_to_s3(
                client=self.client,
                run_id=self.run_id,
                artifacts_path=self.artifacts_path,
                artifact_data=artifact_data,
                patch_metadata=patch_metadata,
                signed_url=self.signed_url,
            )
        except Exception as e:
            console.quiet = False
            console.print(f"\n[red]Error uploading: {e}[/red]")
            sys.exit(1)
        console.print(f"[dim]({time.time() - upload_start:.1f}s)[/dim]")

        # API 2: /run/execute
        console.print("[blue]Executing...[/blue]", end=" ")
        try:
            self._execute(
                task_requests=self.task_requests,
                patch_metadata=patch_metadata,
            )
        except Exception as e:
            console.quiet = False
            console.print(f"\n[red]Error executing: {e}[/red]")
            sys.exit(1)
        console.print(f"[dim]({time.time() - create_start:.1f}s)[/dim]")

        if follow:
            console.quiet = False
            follow_all_steps(
                self.client, self.tasks_info, self.run_id, self.artifacts_path
            )
        else:
            console.print(
                f"\n[dim]To stream logs later: blast stream {self.run_id}[/dim]"
            )

    def _print_job_info(self):
        header_lines = []
        header_lines.append(f"[bold blue]Run ID:[/bold blue] {self.run_id}")
        header_lines.append(f"[blue]Artifacts:[/blue] {self.artifacts_path}")
        header_lines.append("")
        for t in self.tasks_info:
            header_lines.append(
                f"Task {t.step_name} (type: {t.task_type}): {t.task_id}"
            )
        console.print(
            Panel.fit(
                "\n".join(header_lines),
                title="[bold]Job Info[/bold]",
                border_style="blue",
            )
        )
        console.print()

    def _print_dry_run_info(
        self,
        patch: bool = False,
        repo_path: str = None,
        commit: str = None,
        repo: str = None,
        repo_cache: str = None,
        as_json: bool = False,
    ):
        """Print dry run information without making API calls."""
        import json

        # Get patch metadata using shared function
        patch_metadata = None
        actual_commit = commit
        actual_repo = repo
        if patch:
            patch_metadata, actual_commit, actual_repo = get_patch_metadata(
                repo_path, commit, repo
            )

        # Create placeholder TaskInfo for dry run
        dry_run_tasks = [
            TaskInfo(
                task_id=f"<task_{i}>",
                step_index=i,
                step_name=cfg.name,
                dependency=None if i == 0 else f"<task_{i - 1}>",
                task_type=cfg.task_type,
                image=cfg.image,
                script_name=cfg.get_script_name(i),
            )
            for i, cfg in enumerate(self.step_configs)
        ]

        # Build artifact data
        artifact_data = build_artifacts_metadata(
            run_id="<run_id>",
            name=self.name,
            artifacts_path="<s3://bucket/runs/run_id/>",
            step_configs=self.step_configs,
            tasks_info=dry_run_tasks,
            patch_metadata=patch_metadata,
            commit=actual_commit,
            repo=actual_repo,
            script_builder_class=self.script_builder_class,
        )

        # Set placeholders for build_task_requests
        self.run_id = "<run_id>"
        self.artifacts_path = "<s3://bucket/runs/run_id/>"
        self.tasks_info = dry_run_tasks

        task_requests = build_task_requests(
            artifacts_path=self.artifacts_path,
            step_configs=self.step_configs,
            tasks_info=dry_run_tasks,
            repo_cache=repo_cache,
            raw_mode=False,
            commit=actual_commit,
            repo=actual_repo,
            run_id=self.run_id,
        )

        # JSON output mode
        if as_json:
            job_info = artifact_data["job_info"]
            # Remove patch_content (too large for JSON output)
            if job_info.get("patch_info"):
                job_info["patch_info"] = {
                    k: v
                    for k, v in job_info["patch_info"].items()
                    if k != "patch_content"
                }
            # Truncate command in task_requests (bootstrap script is large)
            slim_updates = []
            for tu in task_requests:
                slim = {k: v for k, v in tu.items() if k != "command"}
                slim_updates.append(slim)

            output = {
                "job_info": job_info,
                "task_requests": slim_updates,
            }
            print(json.dumps(output, indent=2, default=str))
            return

        from rich.panel import Panel
        from rich.syntax import Syntax
        from rich.table import Table
        from rich.tree import Tree

        console.print()
        console.print(
            Panel.fit(
                "[yellow bold]DRY RUN MODE[/yellow bold]\n"
                "[dim]No API calls will be made. "
                "Showing what would be uploaded/created.[/dim]",
                border_style="yellow",
            )
        )
        console.print()

        # 1. Print step configs table
        console.print("[blue bold]═══ Steps to Create ═══[/blue bold]")
        table = Table(show_header=True, header_style="bold cyan")
        table.add_column("Step", style="cyan")
        table.add_column("Name")
        table.add_column("Type")
        table.add_column("Image")
        table.add_column("Source")

        for i, cfg in enumerate(self.step_configs):
            source = cfg.script or (
                f"{cfg.command[:40]}..."
                if cfg.command and len(cfg.command) > 40
                else cfg.command
            )
            table.add_row(
                str(i + 1),
                cfg.name,
                cfg.task_type,
                cfg.image or "[dim]default[/dim]",
                source or "[dim]none[/dim]",
            )
        console.print(table)
        console.print()

        # 2. Print task requests (from build_task_requests)
        console.print(
            "[blue bold]═══ Task Requests (send to API) ═══[/blue bold]"
        )

        for i, task_req in enumerate(task_requests):
            cfg = self.step_configs[i]
            console.print(f"\n[cyan]── Task {i + 1}: {cfg.name} ──[/cyan]")

            for key, value in task_req.items():
                if key == "env_vars" and isinstance(value, dict):
                    console.print("  env_vars:")
                    for k, v in value.items():
                        console.print(
                            f"    [cyan]{k}[/cyan]=[green]{v}[/green]"
                        )
                elif key == "command":
                    # Truncate command for display
                    lines = str(value).split("\n")
                    preview = (
                        lines[0][:60] + "..."
                        if len(lines[0]) > 60
                        else lines[0]
                    )
                    console.print(f"  {key}: [dim]{preview}[/dim]")
                else:
                    console.print(f"  {key}: [green]{value}[/green]")

        console.print()

        # 3. Print ZIP file structure
        console.print(
            "[blue bold]═══ Files to Upload (inputs.zip) ═══[/blue bold]"
        )
        tree = Tree("[bold]inputs.zip[/bold]")

        scripts_branch = tree.add("[cyan]scripts/[/cyan]")
        for script_data in artifact_data["scripts"]:
            task_branch = scripts_branch.add(
                f"[cyan]{script_data['task_id']}/[/cyan]"
            )
            task_branch.add(f"[green]{script_data['script_name']}[/green]")
            task_branch.add("[green]runner.sh[/green]")

        tasks_branch = tree.add("[cyan]tasks/[/cyan]")
        for task_config in artifact_data["task_configs"]:
            tasks_branch.add(
                f"[green]task_{task_config['task_id']}.json[/green]"
            )

        if patch:
            git_branch = tree.add("[cyan]git-changes/[/cyan]")
            git_branch.add("[green]changes.patch[/green]")

        tree.add("[green]job.json[/green]")
        console.print(tree)
        console.print()

        # 4. Print patch info if applicable
        if patch:
            console.print("[blue bold]═══ Patch Info ═══[/blue bold]")
            console.print(
                f"  Repo path: [cyan]{repo_path or 'current directory'}[/cyan]"
            )
            console.print(f"  Base commit: [cyan]{actual_commit}[/cyan]")
            console.print(f"  Remote repo: [cyan]{actual_repo}[/cyan]")
            console.print()

        # 5. Print job.json content
        console.print("[blue bold]═══ Generated job.json ═══[/blue bold]")
        console.print(
            Syntax(
                json.dumps(artifact_data["job_info"], indent=2),
                "json",
                theme="monokai",
            )
        )
        console.print()

        # 6. Print each step's script content
        console.print("[blue bold]═══ Step Scripts ═══[/blue bold]")
        for script_data in artifact_data["scripts"]:
            console.print(f"\n[cyan]── {script_data['script_name']} ──[/cyan]")
            content = script_data["script_content"]
            if content:
                lines = content.split("\n")
                if len(lines) > 30:
                    preview = "\n".join(lines[:30])
                    preview += f"\n\n... ({len(lines) - 30} more lines) ..."
                else:
                    preview = content
                console.print(Syntax(preview, "bash", theme="monokai"))
            else:
                console.print("[dim]No script content[/dim]")

        # 7. Print generated runner script
        console.print(
            "\n[blue bold]═══ Generated runner.sh (Step 1) ═══[/blue bold]"
        )
        runner_content = artifact_data["scripts"][0]["runner_content"]
        lines = runner_content.split("\n")
        if len(lines) > 200:
            preview = "\n".join(lines[:200])
            preview += f"\n\n... ({len(lines) - 200} more lines) ..."
        else:
            preview = runner_content
        console.print(
            Syntax(preview, "bash", theme="monokai", line_numbers=True)
        )

        console.print()
        console.print(
            Panel.fit(
                "[yellow bold]END DRY RUN[/yellow bold]\n"
                "[dim]To execute for real, remove --dry-run flag.[/dim]",
                border_style="yellow",
            )
        )
