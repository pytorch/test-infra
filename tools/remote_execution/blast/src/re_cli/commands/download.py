"""Download command: download outputs from a completed run."""

import json
import sys
import tarfile
import tempfile
from pathlib import Path

import click
import requests

from ..core.core_types import console
from . import get_client


@click.command()
@click.argument("run_id")
@click.option(
    "--task",
    "task_id",
    default=None,
    help="Download outputs for a specific task ID only",
)
@click.option(
    "-o",
    "--output",
    "output_dir",
    default="./outputs",
    help="Local directory to save outputs (default: ./outputs)",
)
@click.option(
    "--logs",
    "include_logs",
    is_flag=True,
    help="Also download log files",
)
@click.pass_context
def download(ctx, run_id, task_id, output_dir, include_logs):
    """Download outputs from a completed or failed run.

    Downloads and extracts the outputs archive (tar.gz) for each task.
    Use --logs to also download individual log files.

    Examples:
        blast download <run-id>
        blast download <run-id> --logs
        blast download <run-id> --task <task-id>
        blast download <run-id> -o ./my-outputs
        blast --json download <run-id>
    """
    as_json = ctx.obj.get("as_json", False)
    client = get_client(ctx)
    out_path = Path(output_dir)

    try:
        if task_id:
            # Query single task
            task = client.query_task_status(task_id, include_downloads=True)
            if not task:
                if as_json:
                    print(json.dumps({"error": f"Task {task_id} not found"}))
                else:
                    console.print(f"[red]Task {task_id} not found[/red]")
                sys.exit(1)

            status = task.get("current_status", "unknown")
            if status not in ("completed", "failed"):
                if as_json:
                    print(json.dumps({"error": f"Task {task_id} is '{status}', not completed/failed"}))
                else:
                    console.print(
                        f"[yellow]Task {task_id} is '{status}' — "
                        f"download is only available for completed/failed tasks[/yellow]"
                    )
                sys.exit(1)

            downloads = task.get("downloads", {})
            if as_json:
                print(json.dumps({"task_id": task_id, "downloads": downloads}, indent=2))
                return

            if not downloads.get("outputs") and not downloads.get("logs"):
                console.print(f"[yellow]No outputs found for task {task_id}[/yellow]")
                return

            _download_task(downloads, out_path / task_id, include_logs)
        else:
            # Query run status (includes download URLs per task)
            run_info = client.query_run_status(run_id, include_downloads=True)
            if not run_info:
                if as_json:
                    print(json.dumps({"error": f"Run {run_id} not found"}))
                else:
                    console.print(f"[red]Run {run_id} not found[/red]")
                sys.exit(1)

            tasks = run_info.get("tasks", [])

            if as_json:
                output = [
                    {
                        "task_id": t.get("task_id", ""),
                        "name": t.get("name", ""),
                        "status": t.get("status", ""),
                        "downloads": t.get("downloads", {}),
                    }
                    for t in tasks
                    if t.get("downloads")
                ]
                print(json.dumps(output, indent=2))
                return

            if not tasks:
                console.print(f"[yellow]No tasks found for run {run_id}[/yellow]")
                return

            downloaded = 0
            for t in tasks:
                tid = t.get("task_id", "")
                status = t.get("status", "unknown")
                downloads = t.get("downloads", {})

                if not downloads.get("outputs") and not downloads.get("logs"):
                    if status in ("completed", "failed"):
                        console.print(
                            f"[dim]  {t.get('name', tid)}: no outputs[/dim]"
                        )
                    continue

                task_dir = out_path / tid
                console.print(f"[blue]{t.get('name', tid)}[/blue] ({status})")
                _download_task(downloads, task_dir, include_logs)
                downloaded += 1

            if downloaded == 0:
                console.print("[yellow]No outputs found for any task[/yellow]")
            else:
                console.print(
                    f"\n[green]Downloaded outputs for {downloaded} task(s) to {out_path}[/green]"
                )

    except Exception as e:
        if as_json:
            print(json.dumps({"error": str(e)}))
        else:
            console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


def _download_task(downloads: dict, dest_dir: Path, include_logs: bool):
    """Download outputs archive and optionally log files for a task."""
    dest_dir.mkdir(parents=True, exist_ok=True)

    # Download and extract outputs archive
    outputs = downloads.get("outputs")
    if outputs and outputs.get("url"):
        _download_and_extract(outputs["key"], outputs["url"], dest_dir)

    # Download log files if requested
    if include_logs:
        for log_entry in downloads.get("logs", []):
            url = log_entry.get("url", "")
            key = log_entry.get("key", "")
            if not url:
                continue
            file_path = dest_dir / key
            file_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                resp = requests.get(url, stream=True, timeout=300)
                resp.raise_for_status()
                with open(file_path, "wb") as f:
                    for chunk in resp.iter_content(chunk_size=8192):
                        f.write(chunk)
                console.print(f"  [green]↓[/green] {key}")
            except requests.RequestException as e:
                console.print(f"  [red]✗[/red] {key}: {e}")


def _download_and_extract(key: str, url: str, dest_dir: Path):
    """Download a tar.gz archive and extract to dest_dir."""
    try:
        resp = requests.get(url, stream=True, timeout=300)
        resp.raise_for_status()
        with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=True) as tmp:
            for chunk in resp.iter_content(chunk_size=8192):
                tmp.write(chunk)
            tmp.flush()
            with tarfile.open(tmp.name, "r:gz") as tar:
                tar.extractall(path=dest_dir)
            console.print(f"  [green]↓[/green] {key} (extracted)")
    except requests.RequestException as e:
        console.print(f"  [red]✗[/red] {key}: {e}")
