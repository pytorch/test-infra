"""Log streaming for follow_all_steps."""

from __future__ import annotations

import time
from typing import Optional, TYPE_CHECKING

from rich.panel import Panel

from .core_types import console


if TYPE_CHECKING:
    from .core_types import TaskInfo


def _prompt_cancel_action() -> str:
    """Prompt user for action when Ctrl+C is pressed.

    Returns:
        'continue', 'cancel', or 'exit'
    """
    console.print()
    console.print("[yellow]Interrupted! Choose an action:[/yellow]")
    console.print("  [cyan]c[/cyan] - Continue following logs")
    console.print("  [cyan]k[/cyan] - Cancel (kill) current task")
    console.print("  [cyan]e[/cyan] - Exit without cancelling")

    while True:
        try:
            choice = input("Choice [c/k/e]: ").strip().lower()
            if choice in ("c", "continue"):
                return "continue"
            elif choice in ("k", "kill", "cancel"):
                return "cancel"
            elif choice in ("e", "exit", "q", "quit"):
                return "exit"
            else:
                console.print("[dim]Invalid choice. Enter c, k, or e[/dim]")
        except (EOFError, KeyboardInterrupt):
            return "exit"


def follow_all_steps(
    client,
    tasks_info: list[TaskInfo],
    run_id: str,
    artifacts_path: Optional[str] = None,
):
    """Follow logs for all steps in sequence using kubectl logs.

    Args:
        client: kube client (with kubectl-based methods)
        tasks_info: List of TaskInfo objects
        run_id: Run ID for cancellation
        artifacts_path: Optional artifacts path to display in header
    """

    FINAL_STATES = {"completed", "failed", "cancelled"}

    def print_header(current_step: int, status: str = ""):
        """Print job info header panel."""
        lines = []
        lines.append(f"[bold blue]Run ID:[/bold blue] {run_id}")
        if artifacts_path:
            lines.append(f"[blue]Artifacts:[/blue] {artifacts_path}")
        lines.append("")
        for i, t in enumerate(tasks_info):
            if i < current_step:
                marker = "[green]✓[/green]"
            elif i == current_step:
                marker = "[yellow]▶[/yellow]"
            else:
                marker = "[dim]○[/dim]"
            lines.append(f"  {marker} Task {t.task_id} for '{t.step_name}'")
        if status:
            lines.append(f"\n[cyan]Status: {status}[/cyan]")
        console.print(
            Panel.fit(
                "\n".join(lines),
                title="[bold]Job Info[/bold]",
                border_style="blue",
            )
        )
        console.print()

    # Print initial header
    print_header(0, "starting")

    for i, task_info in enumerate(tasks_info):
        console.print(
            f"[yellow]Following logs for step {i + 1}/{len(tasks_info)}: "
            f"'{task_info.step_name}'...[/yellow]"
        )

        # Wait for task to reach running state (or final state)
        max_wait = 10800  # 3 hours max
        waited = 0
        last_status = None
        cancelled_by_user = False

        while waited < max_wait:
            try:
                status_info = client.get_task_status(task_info.task_id)
                current_status = status_info.get("current_status", "unknown")

                if current_status != last_status:
                    console.print(f"[green]Status: {current_status}[/green]")
                    last_status = current_status

                if current_status == "running" or current_status in FINAL_STATES:
                    break

            except KeyboardInterrupt:
                action = _prompt_cancel_action()
                if action == "continue":
                    console.print("[dim]Continuing to wait...[/dim]")
                    # Just continue waiting - no break
                elif action == "cancel":
                    try:
                        client.cancel_run(run_id)
                        console.print(f"[yellow]○ Run {run_id} cancelled[/yellow]")
                    except Exception as e:
                        console.print(f"[dim]Failed to cancel: {e}[/dim]")
                    cancelled_by_user = True
                    break
                else:
                    break
            except Exception as e:
                console.print(f"[dim]Waiting... ({e})[/dim]")

            time.sleep(6)
            waited += 6

        if cancelled_by_user:
            break

        # Stream logs (retry/reconnect handled by k8s_client internally)
        should_follow = last_status not in FINAL_STATES

        interactive_ready = False
        try:
            for ts, line in client.stream_task_logs(
                task_info.task_id,
                follow=should_follow,
            ):
                if ts:
                    pass  # cursor tracked internally by k8s_client
                if "=== Job finished. Container idle for" in line:
                    console.print()
                    console.print("[green bold]Interactive session ready![/green bold]")
                    console.print(
                        f"[cyan]Run: blast debug -t {task_info.task_id}[/cyan]"
                    )
                    console.print()
                    interactive_ready = True
                    break
                if "[Bootstrap]" in line or "[Runner]" in line:
                    console.print(f"[dim]{line.rstrip()}[/dim]")
                else:
                    console.print(line.rstrip())
        except KeyboardInterrupt:
            action = _prompt_cancel_action()
            if action == "cancel":
                try:
                    client.cancel_run(run_id)
                    console.print(f"[yellow]○ Run {run_id} cancelled[/yellow]")
                except Exception as e:
                    console.print(f"[dim]Failed to cancel: {e}[/dim]")
                cancelled_by_user = True
            elif action == "exit":
                cancelled_by_user = True
            # "continue" falls through to check final status
        except Exception as e:
            console.print(f"[red]Log stream failed: {e}[/red]")

        if cancelled_by_user:
            break

        if interactive_ready:
            break

        # Check final status
        try:
            final_info = client.get_task_status(task_info.task_id)
            final_status = final_info.get("current_status", "unknown")
            if final_status == "completed":
                console.print(
                    f"[green]✓ Step '{task_info.step_name}' completed[/green]"
                )
            elif final_status == "failed":
                console.print(f"[red]✗ Step '{task_info.step_name}' failed[/red]")
                print_header(i + 1, "failed")
                break
            elif final_status == "cancelled":
                console.print(
                    f"[yellow]○ Step '{task_info.step_name}' cancelled[/yellow]"
                )
                print_header(i + 1, "cancelled")
                break
        except Exception as e:
            print_header(i + 1, f"unknown failed (error: {e})")
            break

        # Print header before next step
        if i < len(tasks_info) - 1:
            print_header(i + 1)
        console.print()

    # Final header
    print_header(len(tasks_info), "done")
    console.print("[green]═══ End streaming ═══[/green]")
