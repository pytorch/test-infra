"""Debug command: exec into a running interactive pod."""

import os
import shutil
import sys

import click

from . import get_client
from ..core.core_types import console


@click.command()
@click.argument("id", type=str)
@click.option("-t", "--task", is_flag=True, help="ID is a task_id (skip run lookup)")
@click.pass_context
def debug(ctx, id, task):
    """Exec into an interactive debug session pod.

    By default, treats ID as a run_id and finds the last task's pod.
    Use --task/-t if passing a task_id directly.

    Examples:
        blast debug <run_id>
        blast debug -t <task_id>
    """
    client = get_client(ctx)

    if task:
        task_id = id
        console.print(f"[blue]Task: {task_id}[/blue]")
    else:
        tasks = client.get_run_tasks(id)
        if not tasks:
            console.print(f"[red]No tasks found for run {id}[/red]")
            console.print("[dim]Use -t flag if this is a task_id[/dim]")
            sys.exit(1)

        tasks.sort(key=lambda t: t.get("step_order", 0))
        last_task = tasks[-1]
        task_id = last_task["task_id"]
        console.print(
            f"[blue]Run {id} → last task: {task_id} "
            f"({last_task.get('step_name', '')})[/blue]"
        )

    # Find the pod for this task
    job_ns = client.config.job_namespace
    pod_name = _find_pod(client, job_ns, task_id)
    if not pod_name:
        console.print(f"[red]No running pod found for task {task_id}[/red]")
        console.print("[dim]The pod may have already completed or been cleaned up.[/dim]")
        sys.exit(1)

    console.print(f"[green]Found pod: {pod_name}[/green]")

    if shutil.which("kubectl"):
        os.execvp("kubectl", [
            "kubectl", "exec", "-it", pod_name, "-n", job_ns, "--", "bash",
        ])
    else:
        console.print(
            "[yellow]kubectl not found, using python client "
            "(install kubectl for better experience)[/yellow]"
        )
        _exec_via_python(client, job_ns, pod_name)


def _exec_via_python(client, namespace: str, pod_name: str):
    """Fallback: interactive shell via kubernetes python client."""
    import select
    import termios
    import tty

    from kubernetes.stream import stream as k8s_stream

    resp = k8s_stream(
        client.core_api.connect_get_namespaced_pod_exec,
        pod_name,
        namespace,
        command=["/bin/bash"],
        stderr=True,
        stdin=True,
        stdout=True,
        tty=True,
        _preload_content=False,
    )

    old_settings = termios.tcgetattr(sys.stdin)
    try:
        tty.setraw(sys.stdin.fileno())

        while resp.is_open():
            resp.update(timeout=0.1)

            if resp.peek_stdout():
                sys.stdout.write(resp.read_stdout())
                sys.stdout.flush()
            if resp.peek_stderr():
                sys.stderr.write(resp.read_stderr())
                sys.stderr.flush()

            if select.select([sys.stdin], [], [], 0.1)[0]:
                data = sys.stdin.read(1)
                if data:
                    resp.write_stdin(data)
    finally:
        termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old_settings)
        resp.close()
        print()


def _find_pod(client, namespace: str, task_id: str) -> str | None:
    """Find a running pod for the given task_id."""
    try:
        pods = client.core_api.list_namespaced_pod(
            namespace=namespace,
            label_selector=f"task-id={task_id}",
        )
        for pod in pods.items:
            if pod.status.phase in ("Running"):
                return pod.metadata.name
    except Exception:
        pass

    # Fallback: search by pod name prefix (task-{task_id}-*)
    try:
        pods = client.core_api.list_namespaced_pod(
            namespace=namespace,
            field_selector="status.phase=Running",
        )
        prefix = f"task-{task_id}"
        for pod in pods.items:
            if pod.metadata.name.startswith(prefix):
                return pod.metadata.name
    except Exception:
        pass

    return None
