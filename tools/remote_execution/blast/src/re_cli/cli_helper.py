"""CLI helper functions shared across commands."""

import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from rich.panel import Panel
from rich.table import Table

from .core.core_types import build_step_configs, console, get_status_color, StepConfig
from .core.git_patch import check_uncommitted_changes
from .core.job_runner import JobRunner
from .core.log_stream import _prompt_cancel_action


# =============================================================================
# Local history cache (~/.blast/history.json)
# =============================================================================

BLAST_DIR = Path.home() / ".blast"
HISTORY_FILE = BLAST_DIR / "history.json"
CONFIG_FILE = BLAST_DIR / "config.json"

DEFAULT_HISTORY_LIMIT = 200


def load_config() -> dict:
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

    config = load_config()
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


def print_task_detail(client, task_id: str):
    """Print detailed task status with history."""
    task = client.query_task_status(task_id)
    if not task:
        console.print(f"[dim]  Task {task_id}: not found[/dim]")
        return

    current_status = task.get("current_status", "unknown")
    status_color = get_status_color(current_status)

    console.print(
        Panel.fit(
            f"[bold]Task ID:[/bold] {task.get('id')}\n"
            f"[bold]Name:[/bold] {task.get('name')}\n"
            f"[bold]Status:[/bold] [{status_color}]{current_status}[/{status_color}]\n"
            f"[bold]Run ID:[/bold] {task.get('run_id', 'N/A')}\n"
            f"[bold]Created:[/bold] {task.get('created_at')}\n"
            f"[bold]Updated:[/bold] {task.get('updated_at')}",
            title=f"Task {task_id}",
        )
    )

    history = task.get("history", [])
    if history:
        table = Table(title="Status History", show_header=True)
        table.add_column("Status", style="bold")
        table.add_column("Time")
        table.add_column("Metadata", style="dim")

        for h in history:
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


# =============================================================================
# Config file loading
# =============================================================================


def load_config_file(config_path: str) -> dict:
    """Load a JSON config file for run/run-steps."""
    with open(config_path) as f:
        return json.load(f)


def build_step_configs_from_json(steps_json: list) -> list[StepConfig]:
    """Build StepConfig list from JSON config, using build_step_configs."""
    steps = []
    scripts = []
    commands = []
    types = []
    images = []
    env_vars_list = []
    depends_on = []
    additional = []

    for s in steps_json:
        steps.append(s.get("name", "step"))
        scripts.append(s.get("script", ""))
        commands.append(s.get("command", ""))
        types.append(s.get("type", "default"))
        images.append(s.get("image", ""))

        # Convert env dict to "KEY=VALUE,KEY2=VALUE2" string
        env = s.get("env", {})
        if isinstance(env, dict) and env:
            env_vars_list.append(",".join(f"{k}={v}" for k, v in env.items()))
        elif isinstance(env, str):
            env_vars_list.append(env)
        else:
            env_vars_list.append("")

        depends_on.append(s.get("depends_on", ""))
        additional.append(s.get("additional", ""))

    return build_step_configs(
        tuple(steps),
        tuple(scripts),
        tuple(commands),
        tuple(types),
        tuple(images),
        tuple(env_vars_list),
        tuple(depends_on),
        tuple(additional),
    )


# =============================================================================
# Job execution
# =============================================================================


from .core.k8s_client import K8sClient


def execute_job(
    client: K8sClient,
    step_configs: list[StepConfig],
    name: str,
    follow: bool,
    patch: bool,
    repo_path: Optional[str],
    repo_cache: Optional[str],
    commit: Optional[str],
    repo: Optional[str],
    raw: bool,
    dry_run: bool,
    as_json: bool = False,
    no_submodule: bool = False,
) -> None:
    """Shared execution logic for run and run-steps commands."""
    if patch and raw:
        console.print("[red]Error: --raw mode cannot upload patch[/red]")
        sys.exit(1)
    if patch and not repo_path:
        console.print(
            "[red]Error: --patch requires --repo-path or export LOCAL_REPO [/red]"
        )
        sys.exit(1)
    if patch and check_uncommitted_changes(repo_path):
        sys.exit(1)

    if patch and not as_json:
        console.print(
            f"[white]Patch mode with repo:[white][yellow]: {repo_path}[/yellow]"
        )

    # If --no-submodule, set runner_modules on each step to skip git_submodule
    if no_submodule:
        from .core.script_builder import RunnerScriptBuilder

        modules_without_submodule = [
            m for m in RunnerScriptBuilder.DEFAULT_MODULES if m != "git_submodule"
        ]
        for cfg in step_configs:
            if not cfg.runner_modules:
                cfg.runner_modules = modules_without_submodule

    runner = JobRunner(
        client=client,
        name=name,
        step_configs=step_configs,
    )
    try:
        runner.run(
            raw=raw,
            patch=patch,
            repo_path=repo_path,
            commit=commit,
            repo=repo,
            repo_cache=repo_cache,
            follow=follow if not as_json else False,
            dry_run=dry_run,
            as_json=as_json,
        )
        # JSON output after successful submission (non-dry-run)
        if as_json and not dry_run and runner.run_id:
            import json as json_mod

            print(
                json_mod.dumps(
                    {
                        "run_id": runner.run_id,
                        "name": name,
                        "artifacts_path": runner.artifacts_path,
                        "tasks": [
                            {
                                "task_id": t.task_id,
                                "step_name": t.step_name,
                                "step_index": t.step_index,
                                "task_type": t.task_type,
                                "env_vars": runner.task_requests[i].get("env_vars", {}),
                            }
                            for i, t in enumerate(runner.tasks_info)
                        ],
                    },
                    indent=2,
                )
            )
    except KeyboardInterrupt:
        action: str = _prompt_cancel_action()
        if action == "cancel" and runner.run_id:
            try:
                client.cancel_run(runner.run_id)
                console.print(f"[yellow]○ Run {runner.run_id} cancelled[/yellow]")
            except Exception as e:
                console.print(f"[red]Failed to cancel: {e}[/red]")
        elif action == "exit":
            console.print(f"[dim]Run {runner.run_id} continues in background[/dim]")
    finally:
        # Save to history as soon as run_id exists (job submitted)
        if not dry_run and runner.run_id:
            save_to_history(runner.run_id, name, runner.tasks_info)
