#!/usr/bin/env python3
"""
Blast CLI - Remote Execution

Usage:
    blast run-steps --step build --script build.sh --type cpu
    blast run-steps --step build --script build.sh --step test --script test.sh
    blast status <task_id>
    blast logs <run_id>
    blast history
    blast cancel <run_id>
"""

import sys

import click
from rich.panel import Panel
from rich.table import Table

from .cli_helper import (
    build_step_configs_from_json,
    execute_job,
    load_config_file,
    load_history,
    print_task_detail,
)
from .core.core_types import build_step_configs, console, get_status_color
from .core.k8s_client import K8sClient, K8sConfig


@click.group()
@click.option(
    "--namespace",
    default="remote-execution-system",
    envvar="ELAINE_NAMESPACE",
    help="Kubernetes namespace",
)
@click.option(
    "--timeout",
    default=60,
    help="Timeout for CRD operations (seconds)",
)
@click.option("--json", "as_json", is_flag=True, help="Output as JSON (quiet mode)")
@click.pass_context
def cli(ctx, namespace, timeout, as_json):
    """Blast CLI - Run and monitor remote execution jobs."""
    ctx.ensure_object(dict)
    # silence console output if --json output is used
    ctx.obj["as_json"] = as_json
    if as_json:
        console.quiet = True
    console.print("[Auth] getting K8sConfig")
    config = K8sConfig(namespace=namespace, timeout=timeout)
    ctx.obj["client"] = K8sClient(config)


@cli.command("cancel")
@click.argument("run_id", type=str)
@click.pass_context
def cancel(ctx, run_id):
    """Cancel a run and all its tasks."""
    as_json = ctx.obj.get("as_json", False)
    import json

    client = ctx.obj["client"]

    try:
        result = client.cancel_run(run_id)
        if as_json:
            print(json.dumps({"run_id": run_id, "status": "cancelled", **result}))

        console.print(f"[yellow]○ Run {run_id} cancelled[/yellow]")
        if result.get("message"):
            console.print(f"[dim]  {result['message']}[/dim]")
    except Exception as e:
        if as_json:
            print(json.dumps({"error": str(e)}))
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@cli.command("task-status")
@click.argument("task_id", type=str)
@click.pass_context
def task_status(ctx, task_id):
    """Get task status with history."""
    import json

    as_json = ctx.obj.get("as_json", False)
    client = ctx.obj["client"]

    try:
        if as_json:
            task = client.query_task_status(task_id)
            print(json.dumps(task or {"error": "not found"}, indent=2))
        print_task_detail(client, task_id)
    except Exception as e:
        if as_json:
            print(json.dumps({"error": str(e)}))
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@cli.command("status")
@click.argument("run_id")
@click.option("--detail", "-d", is_flag=True, help="Show detailed status for each task")
@click.pass_context
def run_status(ctx, run_id, detail):
    """Get status of job and all its tasks."""
    import json

    as_json = ctx.obj.get("as_json", False)

    client = ctx.obj["client"]

    try:
        run_info = client.query_run_status(run_id)
        if not run_info:
            if as_json:
                print(json.dumps({"error": "not found"}))
            console.print(f"[yellow]Run {run_id} not found[/yellow]")
            return

        if as_json:
            output = run_info
            if detail:
                # Enrich each task with detailed status + history
                for t in output.get("tasks", []):
                    tid = str(t.get("task_id", ""))
                    if tid:
                        try:
                            t["detail"] = client.query_task_status(tid)
                        except Exception:
                            t["detail"] = None
            print(json.dumps(output, indent=2, default=str))
            return

        job_tasks = run_info.get("tasks", [])
        job_tasks.sort(key=lambda t: t.get("stepIndex", 0))
        created_at = run_info.get("createdAt", "N/A")

        console.print(
            Panel.fit(
                f"[bold]Run ID:[/bold] {run_info.get('id', run_id)}\n"
                f"[bold]Name:[/bold] {run_info.get('name', 'N/A')}\n"
                f"[bold]Created:[/bold] {created_at}\n"
                f"[bold]Steps:[/bold] {len(job_tasks)}\n"
                f"[bold]Artifacts:[/bold] {run_info.get('artifactsPath', 'N/A')}",
                title=f"Run {run_id}",
            )
        )

        if not job_tasks:
            console.print("[yellow]No tasks found[/yellow]")
            return

        # Tasks table
        table = Table(title="Tasks")
        table.add_column("Step", style="cyan")
        table.add_column("Task ID")
        table.add_column("Name")
        table.add_column("Type")
        table.add_column("Status")
        table.add_column("Created", style="dim")
        table.add_column("Updated", style="dim")

        for t in job_tasks:
            task_status = t.get("status", "unknown")
            status_color = get_status_color(task_status)

            table.add_row(
                str(t.get("stepIndex", "?")),
                str(t.get("task_id", "")),
                t.get("name", ""),
                t.get("task_type", "default"),
                f"[{status_color}]{task_status}[/{status_color}]",
                t.get("createdAt", ""),
                t.get("updatedAt", ""),
            )

        console.print(table)

        # Show detailed task info if --detail
        if detail:
            console.print()
            console.rule("[bold]Detail View[/bold]")
            console.print()
            for t in job_tasks:
                tid = str(t.get("task_id", ""))
                if tid:
                    try:
                        print_task_detail(client, tid)
                        console.print()
                    except Exception:
                        console.print(
                            f"[dim]  Could not fetch details for task {tid}[/dim]"
                        )

    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@cli.command("stream")
@click.argument("id", type=str)
@click.option("-t", "--task", is_flag=True, help="ID is a task_id (single task)")
@click.pass_context
def logs(ctx, id, task):
    """Stream logs for a run or task.
    Use --task/-t flag to indicate it's a task_id.
    """
    from .core.core_types import TaskInfo
    from .core.log_stream import follow_all_steps

    client = ctx.obj["client"]

    try:
        if task:
            tasks_info = [
                TaskInfo(
                    task_id=id,
                    step_name="task",
                    step_index=0,
                    dependency=0,
                    task_type="cpu",
                    script_name="",
                )
            ]
            run_id = id
        else:
            tasks = client.get_run_tasks(id)
            if not tasks:
                console.print(f"[red]No tasks found for run {id}[/red]")
                console.print("[dim]Use --task/-t if this is a task_id[/dim]")
                sys.exit(1)

            tasks_info = [
                TaskInfo(
                    task_id=str(t.get("task_id", t.get("taskId", t.get("id")))),
                    step_name=t.get("step_name", t.get("name", f"step_{i}")),
                    step_index=t.get("step_order", t.get("stepIndex", i)),
                    dependency=1 if i > 0 else 0,
                    task_type=t.get("task_type", "cpu"),
                    script_name="",
                )
                for i, t in enumerate(tasks)
            ]
            run_id = id

        console.print(f"[blue]Following {len(tasks_info)} step(s)...[/blue]")
        follow_all_steps(client, tasks_info, run_id)

    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)
    except KeyboardInterrupt:
        console.print("\n[dim]Stopped.[/dim]")


@cli.command("history")
@click.option("--limit", "-l", default=20, help="Max entries to show")
@click.pass_context
def history(ctx, limit):
    """Show local history of your runs."""
    import json

    as_json = ctx.obj.get("as_json", False)

    records = load_history()

    if not records:
        if as_json:
            print(json.dumps([]))
        console.print("[yellow]No runs in history[/yellow]")
        console.print("[dim]History is saved after each blast run/run-steps[/dim]")
        return

    # Show most recent first
    records = list(reversed(records[-limit:]))

    if as_json:
        print(json.dumps(records, indent=2))

    table = Table(title=f"Run History ({len(records)})")
    table.add_column("Run ID", style="cyan", no_wrap=True)
    table.add_column("Name")
    table.add_column("Steps")
    table.add_column("Task IDs", style="dim")
    table.add_column("Created", style="dim")

    for r in records:
        task_ids = ", ".join(t.get("task_id", "") for t in r.get("tasks", []))
        table.add_row(
            r.get("run_id", ""),
            r.get("name", ""),
            str(len(r.get("tasks", []))),
            task_ids,
            r.get("created_at", ""),
        )

    console.print(table)


# =============================================================================
# run / run-steps commands
# =============================================================================


@cli.command("run")
@click.option(
    "--config",
    "config_file",
    default=None,
    type=click.Path(exists=True),
    help="JSON config file (CLI flags override config values)",
)
@click.option("--script", "-s", default=None, help="Script file path")
@click.option(
    "--command",
    "-c",
    default=None,
    help="Direct command (alternative to --script)",
)
@click.option(
    "--type",
    "-t",
    "task_type",
    default="default",
    help="Task type: cpu, gpu, etc.",
)
@click.option("--image", "-i", default=None, help="Docker image")
@click.option(
    "--env",
    "-e",
    "env_vars",
    default=None,
    help="Environment variables (KEY=VALUE,KEY2=VALUE2)",
)
@click.option("--name", "-n", default=None, help="Job name")
@click.option("--follow", "-f", is_flag=True, help="Follow logs")
@click.option("--patch", "-p", is_flag=True, help="Include local git changes")
@click.option(
    "--no-submodule",
    is_flag=True,
    default=False,
    help="Skip git submodule update during checkout",
)
@click.option(
    "--repo-path",
    default=None,
    envvar="LOCAL_REPO",
    help="Path to local git repo",
)
@click.option(
    "--repo-cache",
    default=None,
    envvar="REPO_CACHE",
    help="Repo cache path on worker",
)
@click.option("--commit", default=None, help="Git commit SHA")
@click.option("--repo", "-r", default=None, help="Git repo URL")
@click.option("--raw", is_flag=True, default=False, help="Raw mode: skip S3 upload")
@click.option("--dry-run", is_flag=True, default=False, help="Dry run")
@click.pass_context
def run_single(
    ctx,
    config_file,
    script,
    command,
    task_type,
    image,
    env_vars,
    name,
    follow,
    patch,
    no_submodule,
    repo_path,
    repo_cache,
    commit,
    repo,
    raw,
    dry_run,
):
    """Run a single step.

    Examples:
        blast run --script build.sh --type cpu-44 --follow
        blast run --config single-step.json --follow
    """
    import os

    as_json = ctx.obj.get("as_json", False)

    # Load from config file if provided
    if config_file:
        cfg = load_config_file(config_file)
        follow = follow or cfg.get("follow", False)
        patch = patch or cfg.get("patch", False)
        repo_path = repo_path or cfg.get("repo_path")
        repo_cache = repo_cache or cfg.get("repo_cache")
        commit = commit or cfg.get("commit")
        repo = repo or cfg.get("repo")
        raw = raw or cfg.get("raw", False)

        # Single step from config
        steps_json = cfg.get("steps", [])
        if steps_json:
            s = steps_json[0]
            script = script or s.get("script")
            command = command or s.get("command")
            task_type = (
                task_type if task_type != "default" else s.get("type", "default")
            )
            image = image or s.get("image")
            name = name or s.get("name")
            if not env_vars and s.get("env"):
                env_data = s["env"]
                if isinstance(env_data, dict):
                    env_vars = ",".join(f"{k}={v}" for k, v in env_data.items())

    if not script and not command:
        console.print("[red]Error: --script or --command is required[/red]")
        sys.exit(1)

    step_name = (
        name or os.path.splitext(os.path.basename(script))[0] if script else "step"
    )
    job_name = name or step_name

    step_configs = build_step_configs(
        steps=(step_name,),
        scripts=(script,) if script else (),
        commands=(command,) if command else (),
        types=(task_type,),
        images=(image,) if image else (),
        env_vars_list=(env_vars,) if env_vars else (),
        depends_on=(),
        additional=(),
    )
    execute_job(
        ctx,
        step_configs,
        job_name,
        follow,
        patch,
        repo_path,
        repo_cache,
        commit,
        repo,
        raw,
        dry_run,
        as_json=as_json,
        no_submodule=no_submodule,
    )


@cli.command("run-steps")
@click.option(
    "--config",
    "config_file",
    default=None,
    type=click.Path(exists=True),
    help="JSON config file (CLI flags override config values)",
)
@click.option(
    "--step",
    "-S",
    "steps",
    multiple=True,
    help="Step name (use multiple times for each step)",
)
@click.option(
    "--script",
    "-s",
    "scripts",
    multiple=True,
    help="Script file path for each step (in order)",
)
@click.option(
    "--command",
    "-c",
    "commands",
    multiple=True,
    help="Direct command for each step (in order, alternative to --script)",
)
@click.option(
    "--type",
    "-t",
    "types",
    multiple=True,
    default=["default"],
    help="Task type for each step: default, cpu, gpu, gpu-l6, gpu-a10g, gpu-h100",
)
@click.option(
    "--depends-on",
    "-d",
    "depends_on",
    multiple=True,
    help="Dependency for each step: 'none' or S3 path (default: previous step)",
)
@click.option(
    "--additional",
    "-a",
    "additional",
    multiple=True,
    help="Additional artifact dependencies (task IDs or S3 paths), comma-separated",
)
@click.option(
    "--image",
    "-i",
    "images",
    multiple=True,
    help="Docker image for each step (in order)",
)
@click.option(
    "--env",
    "-e",
    "env_vars_list",
    multiple=True,
    help="Environment variable for each step in format KEY=VALUE (in order)",
)
@click.option("--name", "-n", default="multi_step_job", help="Job name")
@click.option("--follow", "-f", is_flag=True, help="Follow logs of first step")
@click.option(
    "--patch",
    "-p",
    is_flag=True,
    help="Include local git changes",
)
@click.option(
    "--no-submodule",
    is_flag=True,
    default=False,
    help="Skip git submodule update during checkout",
)
@click.option(
    "--repo-path",
    default=None,
    envvar="LOCAL_REPO",
    help="Path to local git repo for --patch",
)
@click.option(
    "--repo-cache",
    default=None,
    envvar="REPO_CACHE",
    help="Path to repo cache on worker (EFS/daemonset mounted)",
)
@click.option(
    "--commit",
    default=None,
    help="Git commit SHA to checkout",
)
@click.option(
    "--repo",
    "-r",
    default=None,
    help="Git repo URL",
)
@click.option(
    "--raw",
    is_flag=True,
    default=False,
    help="Raw mode: put script content directly in command, skip S3 upload",
)
@click.option(
    "--dry-run",
    is_flag=True,
    default=False,
    help="Dry run: show what would be uploaded without executing",
)
@click.pass_context
def run_steps(
    ctx,
    config_file,
    steps,
    scripts,
    commands,
    types,
    images,
    env_vars_list,
    name,
    follow,
    patch,
    no_submodule,
    repo_path,
    repo_cache,
    commit,
    repo,
    raw,
    dry_run,
    depends_on,
    additional,
):
    """Run multiple steps in sequence.

    Examples:
        blast run-steps --config job.json --follow
        blast run-steps \\
            --step build --script ./build.sh --type cpu \\
            --step test --script ./test.sh --type gpu-l6 \\
            --follow
    """
    as_json = ctx.obj.get("as_json", False)

    # Load from config file if provided, and override CLI flags if present
    if config_file:
        cfg = load_config_file(config_file)
        # CLI flags override config values
        follow = follow or cfg.get("follow", False)
        patch = patch or cfg.get("patch", False)
        repo_path = repo_path or cfg.get("repo_path")
        repo_cache = repo_cache or cfg.get("repo_cache")
        commit = commit or cfg.get("commit")
        repo = repo or cfg.get("repo")
        raw = raw or cfg.get("raw", False)
        name = name if name != "multi_step_job" else cfg.get("name", "multi_step_job")

    # Build step configs from config file or CLI flags
    if config_file and "steps" in cfg and not steps:
        step_configs = build_step_configs_from_json(cfg["steps"])
    elif steps:
        step_configs = build_step_configs(
            steps,
            scripts,
            commands,
            types,
            images,
            env_vars_list,
            depends_on,
            additional,
        )
    else:
        console.print("[red]Error: provide --step flags or --config with steps[/red]")
        sys.exit(1)

    execute_job(
        ctx,
        step_configs,
        name,
        follow,
        patch,
        repo_path,
        repo_cache,
        commit,
        repo,
        raw,
        dry_run,
        as_json=as_json,
        no_submodule=no_submodule,
    )


if __name__ == "__main__":
    cli()
