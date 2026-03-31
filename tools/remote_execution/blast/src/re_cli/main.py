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

import click

from .commands.cancel import cancel
from .commands.debug import debug
from .commands.query import history, logs, run_status, task_status
from .commands.run import run_single, run_steps
from .core.core_types import console


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
    ctx.obj["as_json"] = as_json
    if as_json:
        console.quiet = True
    ctx.obj["_k8s_namespace"] = namespace
    ctx.obj["_k8s_timeout"] = timeout


cli.add_command(run_single, "run")
cli.add_command(run_steps, "run-steps")
cli.add_command(cancel, "cancel")
cli.add_command(debug, "debug")
cli.add_command(task_status, "task-status")
cli.add_command(run_status, "status")
cli.add_command(logs, "stream")
cli.add_command(history, "history")


if __name__ == "__main__":
    cli()
