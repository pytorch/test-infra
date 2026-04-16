"""Cancel command."""

import json
import sys

import click

from ..core.core_types import console
from . import get_client


@click.command()
@click.argument("run_id", type=str)
@click.pass_context
def cancel(ctx, run_id):
    """Cancel a run and all its tasks."""
    as_json = ctx.obj.get("as_json", False)

    client = get_client(ctx)

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
