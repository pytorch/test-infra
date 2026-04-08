"""Query commands: status, task-status, stream, history."""

import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import click
from rich.panel import Panel
from rich.table import Table

from ..core.core_types import console, get_status_color
from . import get_client


# =============================================================================
# Local history cache (~/.blast/history.json)
# =============================================================================

BLAST_DIR = Path.home() / ".blast"
HISTORY_FILE = BLAST_DIR / "history.json"
CONFIG_FILE = BLAST_DIR / "config.json"

DEFAULT_HISTORY_LIMIT = 200


def _load_user_config() -> dict:
    """Load user config from ~/.blast/config.json."""
    if not CONFIG_FILE.exists():
        return {}
    try:
        with open(CONFIG_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def load_history() -> list:
    """Load run history from local cache."""
    if not HISTORY_FILE.exists():
        return []
    try:
        with open(HISTORY_FILE) as f:
            return json.load(f)
    except Exception:
        return []


def save_to_history(run_id: str, name: str, tasks_info: list):
    """Save a run to local history. Prunes old entries by count and age."""
    BLAST_DIR.mkdir(parents=True, exist_ok=True)

    config = _load_user_config()
    max_entries = config.get("history_limit", DEFAULT_HISTORY_LIMIT)
    max_days = config.get("history_days", 30)

    records = load_history()
    records.append(
        {
            "run_id": run_id,
            "name": name,
            "tasks": [{"task_id": t.task_id, "step": t.step_name} for t in tasks_info],
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
    )

    # Prune by age
    cutoff = datetime.now(timezone.utc) - timedelta(days=max_days)
    records = [r for r in records if _parse_time(r.get("created_at", "")) >= cutoff]

    # Prune by count
    records = records[-max_entries:]

    with open(HISTORY_FILE, "w") as f:
        json.dump(records, f, indent=2)


def _parse_time(ts: str):
    """Parse ISO timestamp, return epoch on failure."""
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return datetime(2000, 1, 1, tzinfo=timezone.utc)


# =============================================================================
# Task detail printing
# =============================================================================


def _print_task_panel(task: dict):
    """Print task status panel with history."""
    task_id = task.get("id", "?")
    current_status = task.get("current_status", "unknown")
    status_color = get_status_color(current_status)

    console.print(
        Panel.fit(
            f"[bold]Task ID:[/bold] {task_id}\n"
            f"[bold]Name:[/bold] {task.get('name')}\n"
            f"[bold]Status:[/bold] [{status_color}]{current_status}[/{status_color}]\n"
            f"[bold]Run ID:[/bold] {task.get('run_id', 'N/A')}\n"
            f"[bold]Created:[/bold] {task.get('created_at')}\n"
            f"[bold]Updated:[/bold] {task.get('updated_at')}",
            title=f"Task {task_id}",
        )
    )

    history_entries = task.get("history", [])
    if history_entries:
        table = Table(title="Status History", show_header=True)
        table.add_column("Status", style="bold")
        table.add_column("Time")
        table.add_column("Metadata", style="dim")

        for h in history_entries:
            h_color = get_status_color(h.get("status"))
            ts = str(h.get("created_at", ""))[:19]
            meta_str = ""
            if h.get("metadata"):
                meta_str = json.dumps(h["metadata"], indent=2)
            table.add_row(
                f"[{h_color}]{h.get('status')}[/{h_color}]",
                ts,
                meta_str,
            )

        console.print(table)


def print_task_detail(client, task_id: str):
    """Print detailed task status with history."""
    task = client.query_task_status(task_id)
    if not task:
        console.print(f"[dim]  Task {task_id}: not found[/dim]")
        return
    _print_task_panel(task)


# =============================================================================
# Click commands
# =============================================================================


@click.command()
@click.argument("task_id", type=str)
@click.option("--log-tail", default=0, type=int, help="Show last N lines of logs (for running tasks)")
@click.pass_context
def task_status(ctx, task_id, log_tail):
    """Get task status with history."""
    as_json = ctx.obj.get("as_json", False)

    client = get_client(ctx)

    try:
        if as_json:
            task = client.query_task_status(task_id, tail_lines=log_tail)
            print(json.dumps(task or {"error": "not found"}, indent=2))
            return
        task = client.query_task_status(task_id, tail_lines=log_tail)
        if not task:
            console.print(f"[dim]  Task {task_id}: not found[/dim]")
            return
        _print_task_panel(task)
        if log_tail > 0:
            if task.get("tail_logs"):
                console.print(Panel(task["tail_logs"], title="Tail Logs", border_style="dim"))
            elif task.get("current_status") in ("completed", "failed"):
                run_id = task.get("run_id", "<run-id>")
                console.print(
                    f"[dim]Pod cleaned up. Use: blast download {run_id} "
                    f"--task {task_id} --logs[/dim]"
                )
    except Exception as e:
        if as_json:
            print(json.dumps({"error": str(e)}))
        else:
            console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@click.command()
@click.argument("run_id")
@click.option("--detail", "-d", is_flag=True, help="Show detailed status for each task")
@click.pass_context
def run_status(ctx, run_id, detail):
    """Get status of job and all its tasks."""
    as_json = ctx.obj.get("as_json", False)

    client = get_client(ctx)

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
            t_status = t.get("status", "unknown")
            status_color = get_status_color(t_status)

            table.add_row(
                str(t.get("stepIndex", "?")),
                str(t.get("task_id", "")),
                t.get("name", ""),
                t.get("task_type", "default"),
                f"[{status_color}]{t_status}[/{status_color}]",
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


@click.command()
@click.argument("id", type=str)
@click.option("-t", "--task", is_flag=True, help="ID is a task_id (single task)")
@click.pass_context
def logs(ctx, id, task):
    """Stream logs for a run or task.
    Use --task/-t flag to indicate it's a task_id.
    """
    from ..core.core_types import TaskInfo
    from ..core.log_stream import follow_all_steps

    client = get_client(ctx)

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


@click.command()
@click.option("--limit", "-l", default=20, help="Max entries to show")
@click.pass_context
def history(ctx, limit):
    """Show local history of your runs."""
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
