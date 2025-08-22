"""
GPU Developer CLI - Main entry point
Reserve and manage GPU development servers
"""

import click
import json
from typing import Optional
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich import print as rprint

from .auth import authenticate_user
from .reservations import (
    ReservationManager,
    _generate_vscode_command,
    _add_agent_forwarding_to_ssh,
)
from .config import Config, load_config

console = Console()


@click.group()
@click.version_option()
@click.pass_context
def main(ctx: click.Context) -> None:
    """\b
    GPU Developer CLI - Reserve and manage GPU development servers

    Reserve GPU-enabled development environments with SSH access.
    Supports 1, 2, 4, 8, or 16 GPU configurations with automatic resource management.

    \b
    Examples:
        gpu-dev reserve --gpus 2 --hours 4      # Reserve 2 GPUs for 4 hours
        gpu-dev reserve --jupyter               # Reserve with Jupyter Lab
        gpu-dev list                            # Check your reservations
        gpu-dev show abc12345                   # Get detailed reservation info
        gpu-dev edit abc12345 --enable-jupyter  # Enable Jupyter on active reservation
        gpu-dev cancel abc12345                 # Cancel a reservation
        gpu-dev availability                    # Check GPU availability by type
        gpu-dev status                          # Check cluster status

    Use 'gpu-dev <command> --help' for detailed help on each command.
    """
    ctx.ensure_object(dict)


@main.command()
@click.option(
    "--gpus",
    "-g",
    type=click.Choice(["1", "2", "4", "8", "16"]),
    default="1",
    help="Number of GPUs to reserve (16 = 2x8 GPU setup)",
)
@click.option(
    "--gpu-type",
    type=click.Choice(["h200", "h100", "a100", "t4"]),
    default="a100",
    help="GPU type to reserve (h200/h100/a100/t4)",
)
@click.option(
    "--hours",
    "-h",
    type=float,
    default=8.0,
    help="Reservation duration in hours (supports decimals, max 24)",
)
@click.option("--name", "-n", type=str, help="Optional name for the reservation")
@click.option(
    "--jupyter",
    is_flag=True,
    help="Enable Jupyter Lab access (can be enabled later with 'gpu-dev edit')",
)
@click.pass_context
def reserve(
    ctx: click.Context,
    gpus: str,
    gpu_type: str,
    hours: float,
    name: Optional[str],
    jupyter: bool,
) -> None:
    """Reserve GPU development server(s)

    Creates a reservation for GPU-enabled development environment with SSH access.
    The environment includes PyTorch, CUDA, and common ML tools pre-installed.

    Jupyter Lab can be enabled with --jupyter flag or added later with 'gpu-dev edit'.

    GPU Options:
        1, 2, 4, 8: Single server with specified GPU count
        16: Two connected servers with 8 GPUs each (high-speed interconnect)

    \b
    Examples:
        gpu-dev reserve                          # 1 GPU for 8 hours (default)
        gpu-dev reserve -g 4 -h 2.5             # 4 GPUs for 2.5 hours
        gpu-dev reserve -g 8 -h 12 -n "training" # 8 GPUs, named reservation
        gpu-dev reserve --jupyter                # Include Jupyter Lab access
        gpu-dev reserve --gpu-type h200 -g 2    # 2 H200 GPUs

    Authentication: Uses your AWS credentials and GitHub SSH keys
    """
    try:
        gpu_count = int(gpus)

        # Validate parameters
        if hours > 24:
            rprint("[red]❌ Maximum reservation time is 24 hours[/red]")
            return

        if hours < 0.0833:  # Less than 5 minutes
            rprint("[red]❌ Minimum reservation time is 5 minutes (0.0833 hours)[/red]")
            return

        # Production mode - zero config!
        config = load_config()

        # Authenticate using AWS credentials - if you can call AWS, you're authorized
        try:
            user_info = authenticate_user(config)
        except RuntimeError as e:
            rprint(f"[red]❌ {str(e)}[/red]")
            return

        # Submit reservation
        reservation_mgr = ReservationManager(config)
        reservation_id = reservation_mgr.create_reservation(
            user_id=user_info["user_id"],
            gpu_count=gpu_count,
            gpu_type=gpu_type,
            duration_hours=hours,
            name=name,
            github_user=user_info["github_user"],
            jupyter_enabled=jupyter,
        )

        if reservation_id:
            rprint(
                f"[green]✅ Reservation request submitted: {reservation_id[:8]}...[/green]"
            )

            # Poll for completion with spinner and status updates (no timeout)
            completed_reservation = reservation_mgr.wait_for_reservation_completion(
                reservation_id=reservation_id, timeout_minutes=None
            )

            if not completed_reservation:
                rprint(
                    f"[yellow]💡 Use 'gpu-dev show {reservation_id[:8]}' to check connection details later[/yellow]"
                )
        else:
            rprint("[red]❌ Failed to create reservation[/red]")

    except Exception as e:
        rprint(f"[red]❌ Error: {str(e)}[/red]")


@main.command()
@click.option(
    "--user",
    "-u",
    type=str,
    help='Show reservations for specific user (use "all" for all users, default: current user)',
)
@click.option(
    "--status",
    "-s",
    type=str,
    help='Filter by status (comma-separated, default: active,preparing,queued,pending). Use "all" for all statuses. Available: active,preparing,queued,pending,expired,cancelled,failed,all',
)
@click.pass_context
def list(ctx: click.Context, user: Optional[str], status: Optional[str]) -> None:
    """List GPU reservations (shows your in-progress reservations by default)

    By default, shows your in-progress reservations (active, preparing, queued, pending).
    Use --user all to see all users' reservations.
    Use --status to filter by specific statuses.

    \b
    Examples:
        gpu-dev list                             # Your in-progress reservations
        gpu-dev list --user all                 # All users' in-progress reservations
        gpu-dev list --status expired           # Your expired reservations
        gpu-dev list --status active,expired    # Your active + expired
        gpu-dev list --status all               # All your reservations (any status)
        gpu-dev list --user all --status all    # All reservations for all users

    Available statuses: active, preparing, queued, pending, expired, cancelled, failed, all
    """
    try:
        config = load_config()

        # Authenticate using AWS credentials
        try:
            user_info = authenticate_user(config)
            current_user = user_info["user_id"]
            reservation_mgr = ReservationManager(config)

            # Determine user filter
            if user == "all":
                user_filter = None  # Show all users
            elif user:
                user_filter = user  # Show specific user
            else:
                user_filter = current_user  # Show only current user (default)

            # Determine status filter
            if status:
                # Handle special "all" case
                if status.strip().lower() == "all":
                    statuses_to_include = None  # None means all statuses
                else:
                    # Parse comma-separated statuses and validate
                    requested_statuses = [s.strip() for s in status.split(",")]
                    valid_statuses = [
                        "active",
                        "preparing",
                        "queued",
                        "pending",
                        "expired",
                        "cancelled",
                        "failed",
                    ]

                    # Validate all requested statuses
                    invalid_statuses = [
                        s for s in requested_statuses if s not in valid_statuses
                    ]
                    if invalid_statuses:
                        rprint(
                            f"[red]❌ Invalid status(es): {', '.join(invalid_statuses)}[/red]"
                        )
                        rprint(
                            f"[yellow]Valid statuses: {', '.join(valid_statuses)}, all[/yellow]"
                        )
                        return

                    statuses_to_include = requested_statuses
            else:
                # Default: all in-progress statuses (exclude terminal states)
                statuses_to_include = ["active", "preparing", "queued", "pending"]

            reservations = reservation_mgr.list_reservations(
                user_filter=user_filter, statuses_to_include=statuses_to_include
            )
        except RuntimeError as e:
            rprint(f"[red]❌ {str(e)}[/red]")
            return

        if not reservations:
            rprint("[yellow]📋 No reservations found[/yellow]")
            return

        # Create table with enhanced columns for queue info
        table = Table(title="GPU Reservations")
        table.add_column("ID", style="cyan", no_wrap=True)
        table.add_column("User", style="green")
        table.add_column("GPUs", style="magenta")
        table.add_column("Status", style="yellow")
        table.add_column("Queue Info", style="cyan")
        table.add_column("Created", style="blue")
        table.add_column("Expires/ETA", style="red")

        for reservation in reservations:
            try:
                # Safely get reservation data with defaults
                reservation_id = reservation.get("reservation_id", "unknown")
                user_id = reservation.get("user_id", "unknown")
                gpu_count = reservation.get("gpu_count", 1)
                gpu_type = reservation.get("gpu_type", "unknown")
                status = reservation.get("status", "unknown")
                created_at = reservation.get("created_at", "N/A")

                # Format GPU information
                if gpu_type and gpu_type not in ["unknown", "Unknown"]:
                    gpu_display = f"{gpu_count}x {gpu_type}"
                else:
                    gpu_display = str(gpu_count)

                # Format expiration time or ETA
                expires_at = reservation.get("expires_at", "N/A")

                if status == "active" and expires_at != "N/A":
                    from datetime import datetime

                    try:
                        if isinstance(expires_at, str):
                            # Handle different ISO format variations
                            if expires_at.endswith("Z"):
                                # Format: 2025-01-11T23:30:00Z
                                expires_dt_utc = datetime.fromisoformat(
                                    expires_at.replace("Z", "+00:00")
                                )
                            elif "+" in expires_at or expires_at.endswith("00:00"):
                                # Format: 2025-01-11T23:30:00+00:00
                                expires_dt_utc = datetime.fromisoformat(expires_at)
                            else:
                                # Format: 2025-01-11T23:30:00 (naive datetime, assume UTC)
                                from datetime import timezone

                                naive_dt = datetime.fromisoformat(expires_at)
                                expires_dt_utc = naive_dt.replace(tzinfo=timezone.utc)

                            expires_dt = (
                                expires_dt_utc.astimezone()
                            )  # Convert to local timezone
                        else:
                            # Legacy Unix timestamp (backward compatibility)
                            expires_dt = datetime.fromtimestamp(expires_at)
                        expires_formatted = expires_dt.strftime("%m-%d %H:%M")
                    except (ValueError, TypeError):
                        expires_formatted = "Invalid"
                elif status in ["queued", "pending"]:
                    # Show estimated wait time if available
                    estimated_wait = reservation.get("estimated_wait_minutes", "?")
                    if estimated_wait != "?" and estimated_wait is not None:
                        expires_formatted = f"~{estimated_wait}min"
                    else:
                        expires_formatted = "Calculating..."
                else:
                    expires_formatted = "N/A"

                # Format queue info for queued reservations
                queue_info = ""
                if status in ["queued", "pending"]:
                    queue_position = reservation.get("queue_position", "?")
                    estimated_wait = reservation.get("estimated_wait_minutes", "?")
                    if queue_position != "?" and queue_position is not None:
                        queue_info = f"#{queue_position}"
                        if estimated_wait != "?" and estimated_wait is not None:
                            queue_info += f" (~{estimated_wait}min)"
                    else:
                        queue_info = "Calculating..."
                elif status == "active":
                    # Show SSH connection hint for active reservations
                    ssh_command = reservation.get("ssh_command", "")
                    if ssh_command and "dev@" in ssh_command:
                        try:
                            node_info = (
                                ssh_command.split("dev@")[1].split()[0]
                                if "dev@" in ssh_command
                                else "Ready"
                            )
                            queue_info = f"Ready: {node_info}"
                        except (IndexError, AttributeError):
                            queue_info = "Ready"
                    else:
                        queue_info = "Ready"

                # Format created_at date
                created_formatted = "N/A"
                if created_at and created_at != "N/A":
                    try:
                        if len(str(created_at)) > 10:
                            created_formatted = str(created_at)[:10]
                        else:
                            created_formatted = str(created_at)
                    except (TypeError, AttributeError):
                        created_formatted = "N/A"

                table.add_row(
                    str(reservation_id)[:8],
                    str(user_id),
                    gpu_display,
                    str(status),
                    queue_info,
                    created_formatted,
                    expires_formatted,
                )

            except Exception as row_error:
                # Skip malformed reservations but log the error
                rprint(
                    f"[yellow]⚠️  Skipping malformed reservation: {str(row_error)}[/yellow]"
                )
                continue

        console.print(table)

    except Exception as e:
        rprint(f"[red]❌ Error in list command: {str(e)}[/red]")
        # Debug info for troubleshooting
        import traceback

        rprint(f"[dim]Debug traceback: {traceback.format_exc()}[/dim]")


@main.command()
@click.argument("reservation_id")
@click.pass_context
def cancel(ctx: click.Context, reservation_id: str) -> None:
    """Cancel a GPU reservation

    Cancels an active, queued, or pending reservation and releases resources.
    You can only cancel your own reservations.

    Arguments:
        RESERVATION_ID: The reservation ID (8-character prefix is sufficient)

    \b
    Examples:
        gpu-dev cancel abc12345                  # Cancel reservation abc12345
        gpu-dev cancel abc1                      # Short form also works

    Note: Cancelled reservations cannot be restored. Active pods will be terminated.
    """
    try:
        config = load_config()

        # Authenticate using AWS credentials
        try:
            user_info = authenticate_user(config)
            reservation_mgr = ReservationManager(config)
            success = reservation_mgr.cancel_reservation(
                reservation_id, user_info["user_id"]
            )
        except RuntimeError as e:
            rprint(f"[red]❌ {str(e)}[/red]")
            return

        if success:
            rprint(f"[green]✅ Reservation {reservation_id} cancelled[/green]")
        else:
            rprint(f"[red]❌ Failed to cancel reservation {reservation_id}[/red]")

    except Exception as e:
        rprint(f"[red]❌ Error: {str(e)}[/red]")


@main.command()
@click.argument("reservation_id")
@click.pass_context
def show(ctx: click.Context, reservation_id: str) -> None:
    """Show detailed information for a reservation

    Shows comprehensive details for a reservation including SSH connection info,
    GPU specifications, and timing information.

    Arguments:
        RESERVATION_ID: The reservation ID (8-character prefix is sufficient)

    \b
    Examples:
        gpu-dev show abc12345                    # Show details for abc12345
        gpu-dev show abc1                        # Short form works too

    The output includes:
        - SSH connection command
        - Pod name and namespace
        - GPU count and type
        - Reservation start time
        - Expiration time
        - Current status

    Works for reservations in any status.
    """
    try:
        config = load_config()

        # Authenticate using AWS credentials
        try:
            user_info = authenticate_user(config)
            reservation_mgr = ReservationManager(config)
            connection_info = reservation_mgr.get_connection_info(
                reservation_id, user_info["user_id"]
            )
        except RuntimeError as e:
            rprint(f"[red]❌ {str(e)}[/red]")
            return

        if connection_info:
            status = connection_info.get("status", "unknown")
            gpu_count = connection_info.get("gpu_count", 1)
            gpu_type = connection_info.get("gpu_type", "Unknown")
            instance_type = connection_info.get("instance_type", "unknown")

            # Format GPU information
            if gpu_type != "Unknown" and gpu_type != "unknown":
                gpu_info = f"{gpu_count}x {gpu_type}"
            else:
                gpu_info = f"{gpu_count} GPU(s)"

            # Format timestamps
            created_at = connection_info.get("created_at", "N/A")
            launched_at = connection_info.get("launched_at", "N/A")
            expires_at = connection_info.get("expires_at", "N/A")

            # Convert timestamps to readable format
            def format_timestamp(timestamp_str):
                if not timestamp_str or timestamp_str == "N/A":
                    return "N/A"
                try:
                    from datetime import datetime, timezone

                    if isinstance(timestamp_str, str):
                        # Handle different ISO format variations
                        if timestamp_str.endswith("Z"):
                            # Format: 2025-01-11T23:30:00Z
                            dt_utc = datetime.fromisoformat(
                                timestamp_str.replace("Z", "+00:00")
                            )
                        elif "+" in timestamp_str or timestamp_str.endswith("00:00"):
                            # Format: 2025-01-11T23:30:00+00:00
                            dt_utc = datetime.fromisoformat(timestamp_str)
                        else:
                            # Format: 2025-01-11T23:30:00 (naive datetime, assume UTC)
                            naive_dt = datetime.fromisoformat(timestamp_str)
                            dt_utc = naive_dt.replace(tzinfo=timezone.utc)

                        dt_local = dt_utc.astimezone()  # Convert to local timezone
                        return dt_local.strftime("%Y-%m-%d %H:%M:%S")
                    else:
                        # Legacy Unix timestamp
                        dt = datetime.fromtimestamp(timestamp_str)
                        return dt.strftime("%Y-%m-%d %H:%M:%S")
                except (ValueError, TypeError):
                    return str(timestamp_str)[:19]  # Fallback to first 19 chars

            created_formatted = format_timestamp(created_at)
            launched_formatted = format_timestamp(launched_at)
            expires_formatted = format_timestamp(expires_at)

            if status == "active":
                jupyter_info = ""
                if connection_info.get("jupyter_enabled") and connection_info.get(
                    "jupyter_url"
                ):
                    jupyter_info = (
                        f"[blue]Jupyter Lab:[/blue] {connection_info['jupyter_url']}\n"
                    )
                elif connection_info.get("jupyter_enabled") and not connection_info.get(
                    "jupyter_url"
                ):
                    jupyter_info = (
                        f"[blue]Jupyter Lab:[/blue] [yellow]Starting...[/yellow]\n"
                    )
                else:
                    # Show enable command if Jupyter is not enabled
                    short_id = connection_info["reservation_id"][:8]
                    jupyter_info = f"[dim]Jupyter Lab:[/dim] [yellow]Not enabled[/yellow] [dim]→[/dim] [cyan]gpu-dev edit {short_id} --enable-jupyter[/cyan]\n"

                # Format secondary users information
                secondary_users = connection_info.get("secondary_users", [])
                secondary_users_info = ""
                if secondary_users:
                    users_list = ", ".join(secondary_users)
                    secondary_users_info = (
                        f"[blue]Secondary Users:[/blue] {users_list}\n"
                    )
                else:
                    # Show add-user command if no secondary users
                    short_id = connection_info["reservation_id"][:8]
                    secondary_users_info = f"[dim]Secondary Users:[/dim] [yellow]None[/yellow] [dim]→[/dim] [cyan]gpu-dev edit {short_id} --add-user <github_username>[/cyan]\n"

                # Generate VS Code command
                vscode_command = _generate_vscode_command(
                    connection_info["ssh_command"]
                )
                vscode_info = ""
                if vscode_command:
                    vscode_info = f"[blue]VS Code Remote:[/blue] {vscode_command}\n"

                # Add agent forwarding to SSH command for display
                ssh_with_forwarding = _add_agent_forwarding_to_ssh(
                    connection_info["ssh_command"]
                )

                panel_content = (
                    f"[green]Reservation Details[/green]\n\n"
                    f"[blue]SSH Command:[/blue] {ssh_with_forwarding}\n"
                    + vscode_info
                    + jupyter_info
                    + f"[blue]Pod Name:[/blue] {connection_info['pod_name']}\n"
                    f"[blue]GPUs:[/blue] {gpu_info}\n"
                    f"[blue]Instance Type:[/blue] {instance_type}\n"
                    + secondary_users_info
                    + f"[blue]Created:[/blue] {created_formatted}\n"
                    f"[blue]Started:[/blue] {launched_formatted}\n"
                    f"[blue]Expires:[/blue] {expires_formatted}"
                )
                panel = Panel.fit(panel_content, title="🚀 Active Reservation")
                console.print(panel)
            elif status in ["queued", "pending", "preparing"]:
                panel_content = (
                    f"[yellow]Reservation Details[/yellow]\n\n"
                    f"[blue]Status:[/blue] {status.title()}\n"
                    f"[blue]GPUs Requested:[/blue] {gpu_info}\n"
                    f"[blue]Created:[/blue] {created_formatted}\n"
                    f"[blue]Expected Instance:[/blue] {instance_type if instance_type != 'unknown' else 'TBD'}"
                )
                if status == "preparing":
                    panel_content += f"\n[blue]Pod Name:[/blue] {connection_info.get('pod_name', 'N/A')}"
                    # Show dynamic pod events from failure_reason if available
                    failure_reason = connection_info.get("failure_reason", "")
                    if failure_reason:
                        panel_content += (
                            f"\n[blue]Current Status:[/blue] {failure_reason}"
                        )

                panel = Panel.fit(
                    panel_content, title=f"⏳ {status.title()} Reservation"
                )
                console.print(panel)

                if status == "queued":
                    rprint(
                        "[yellow]💡 SSH access will be available once your reservation becomes active[/yellow]"
                    )
                elif status == "preparing":
                    rprint(
                        "[yellow]💡 Your environment is being prepared. SSH access will be available shortly.[/yellow]"
                    )
            else:
                panel_content = (
                    f"[red]Reservation Details[/red]\n\n"
                    f"[blue]Status:[/blue] {status.title()}\n"
                    f"[blue]GPUs:[/blue] {gpu_info}\n"
                    f"[blue]Created:[/blue] {created_formatted}\n"
                    f"[blue]Started:[/blue] {launched_formatted}\n"
                    f"[blue]Ended:[/blue] {expires_formatted}"
                )

                # Show failure reason for failed reservations
                if status == "failed":
                    failure_reason = connection_info.get(
                        "failure_reason", "Unknown error"
                    )
                    panel_content += f"\n[blue]Error:[/blue] {failure_reason}"

                panel = Panel.fit(
                    panel_content, title=f"📋 {status.title()} Reservation"
                )
                console.print(panel)

                # Show pod logs for failed reservations
                if status == "failed":
                    pod_logs = connection_info.get("pod_logs", "")
                    if pod_logs and pod_logs.strip():
                        from rich.text import Text

                        rprint("\n[red]🔍 Pod logs (last 20 lines) - Details:[/red]")

                        # Create logs panel
                        log_text = Text(pod_logs)
                        log_panel = Panel(
                            log_text,
                            title="🐚 Container Startup Logs",
                            title_align="left",
                            border_style="red",
                            expand=False,
                        )
                        console.print(log_panel)
        else:
            rprint(f"[red]❌ Could not get connection info for {reservation_id}[/red]")

    except Exception as e:
        rprint(f"[red]❌ Error: {str(e)}[/red]")


def _show_availability() -> None:
    """Shared function to show GPU availability"""
    try:
        config = load_config()

        # Authenticate using AWS credentials
        try:
            user_info = authenticate_user(config)
            reservation_mgr = ReservationManager(config)
            availability_info = reservation_mgr.get_gpu_availability_by_type()
        except RuntimeError as e:
            rprint(f"[red]❌ {str(e)}[/red]")
            return

        if availability_info:
            table = Table(title="GPU Availability by Type")
            table.add_column("GPU Type", style="cyan")
            table.add_column("Available", style="green")
            table.add_column("Total", style="blue")
            table.add_column("Queue Length", style="yellow")
            table.add_column("Est. Wait Time", style="magenta")

            for gpu_type, info in availability_info.items():
                available = info.get("available", 0)
                total = info.get("total", 0)
                queue_length = info.get("queue_length", 0)
                est_wait = info.get("estimated_wait_minutes", 0)

                # Format wait time
                if available > 0:
                    wait_display = "Available now"
                elif est_wait == 0:
                    wait_display = "Unknown"
                elif est_wait < 60:
                    wait_display = f"{int(est_wait)}min"
                else:
                    hours = int(est_wait // 60)
                    minutes = int(est_wait % 60)
                    if minutes == 0:
                        wait_display = f"{hours}h"
                    else:
                        wait_display = f"{hours}h {minutes}min"

                # Color code availability
                if available > 0:
                    available_display = f"[green]{available}[/green]"
                else:
                    available_display = f"[red]{available}[/red]"

                table.add_row(
                    gpu_type.upper(),
                    available_display,
                    str(total),
                    str(queue_length),
                    wait_display,
                )

            console.print(table)

            # Show usage tip
            rprint(
                "\n[dim]💡 Use 'gpu-dev reserve --gpu-type <type>' to reserve GPUs of a specific type[/dim]"
            )

        else:
            rprint("[red]❌ Could not get GPU availability information[/red]")

    except Exception as e:
        rprint(f"[red]❌ Error: {str(e)}[/red]")


@main.command()
@click.pass_context
def availability(ctx: click.Context) -> None:
    """Show GPU availability by type and queue estimates

    Displays real-time information about GPU availability for each GPU type.
    Shows immediate availability and estimated queue times when resources are full.

    Information shown per GPU type:
        - Available GPUs: GPUs ready for immediate reservation
        - Queue Length: Number of pending reservations for this GPU type
        - Estimated Wait: Expected time until resources become available

    \b
    Examples:
        gpu-dev availability                     # Show availability for all GPU types

    This helps you choose the right GPU type and understand wait times before reserving.
    """
    _show_availability()


@main.command(name="avail")
@click.pass_context
def avail(ctx: click.Context) -> None:
    """Show GPU availability by type and queue estimates (alias for 'availability')

    This is a shorter alias for the 'availability' command.
    """
    _show_availability()


@main.command()
@click.pass_context
def status(ctx: click.Context) -> None:
    """Show overall GPU cluster status

    Displays real-time information about GPU cluster capacity and usage.
    Useful for understanding resource availability before making reservations.

    Information shown:
        - Total GPUs: Total GPU capacity in the cluster
        - Available GPUs: GPUs ready for new reservations
        - Reserved GPUs: GPUs currently allocated to active reservations
        - Active Reservations: Number of running reservations
        - Queue Length: Number of pending reservation requests

    \b
    Examples:
        gpu-dev status                           # Show current cluster status

    Note: Status is updated in real-time from the Kubernetes cluster.
    """
    try:
        config = load_config()

        # Authenticate using AWS credentials
        try:
            user_info = authenticate_user(config)
            reservation_mgr = ReservationManager(config)
            cluster_status = reservation_mgr.get_cluster_status()
        except RuntimeError as e:
            rprint(f"[red]❌ {str(e)}[/red]")
            return

        if cluster_status:
            table = Table(title="GPU Cluster Status")
            table.add_column("Metric", style="cyan")
            table.add_column("Value", style="green")

            table.add_row("Total GPUs", str(cluster_status["total_gpus"]))
            table.add_row("Available GPUs", str(cluster_status["available_gpus"]))
            table.add_row("Reserved GPUs", str(cluster_status["reserved_gpus"]))
            table.add_row(
                "Active Reservations", str(cluster_status["active_reservations"])
            )
            table.add_row("Queue Length", str(cluster_status["queue_length"]))

            console.print(table)
        else:
            rprint("[red]❌ Could not get cluster status[/red]")

    except Exception as e:
        rprint(f"[red]❌ Error: {str(e)}[/red]")


@main.group()
def config() -> None:
    """Manage configuration settings

    Configure user-specific settings for the GPU development CLI.
    Most settings are auto-detected from AWS credentials and environment.

    Commands:
        show: Display current configuration and AWS identity
        set:  Set user-specific configuration values

    \b
    Examples:
        gpu-dev config show                      # Show current config
        gpu-dev config set github_user myname   # Set GitHub username
    """
    pass


@config.command()
def show() -> None:
    """Show current configuration

    Displays current configuration including AWS identity, region, and user settings.
    Also shows which GitHub username is configured for SSH key retrieval.

    \b
    Examples:
        gpu-dev config show                      # Display all configuration

    The output shows:
        - AWS region, queue, and cluster information (auto-detected)
        - Your AWS identity and account
        - GitHub username for SSH keys (user-configurable)
    """
    try:
        config = load_config()
        identity = config.get_user_identity()
        github_user = config.get_github_username()

        config_text = (
            f"[green]Configuration (Zero-Config)[/green]\n\n"
            f"[blue]Region:[/blue] {config.aws_region}\n"
            f"[blue]Queue:[/blue] {config.queue_name}\n"
            f"[blue]Cluster:[/blue] {config.cluster_name}\n"
            f"[blue]User:[/blue] {identity['arn']}\n"
            f"[blue]Account:[/blue] {identity['account']}\n\n"
            f"[green]User Settings ({config.config_file})[/green]\n"
            f"[blue]GitHub User:[/blue] {github_user or '[red]Not set - run: gpu-dev config set github_user <username>[/red]'}"
        )

        panel = Panel.fit(config_text, title="⚙️  Configuration")
        console.print(panel)

    except Exception as e:
        rprint(f"[red]❌ Error: {str(e)}[/red]")


@config.command()
@click.argument("key")
@click.argument("value")
def set(key: str, value: str) -> None:
    """Set a configuration value

    Configure user-specific settings. Currently only GitHub username is configurable.
    Your GitHub username is used to fetch SSH public keys for server access.

    Arguments:
        KEY: Configuration key to set (currently: github_user)
        VALUE: Value to set for the configuration key

    \b
    Examples:
        gpu-dev config set github_user johndoe   # Set GitHub username to 'johndoe'
        gpu-dev config set github_user jane.doe  # GitHub usernames with dots work too

    Valid keys:
        github_user: Your GitHub username (used to fetch SSH public keys)

    Note: SSH keys must be public on your GitHub profile (github.com/username.keys)
    """
    try:
        config = load_config()

        # Validate known keys
        valid_keys = ["github_user"]
        if key not in valid_keys:
            rprint(
                f"[red]❌ Unknown config key '{key}'. Valid keys: {', '.join(valid_keys)}[/red]"
            )
            return

        config.save_user_config(key, value)
        rprint(f"[green]✅ Set {key} = {value}[/green]")
        rprint(f"[dim]Saved to {config.config_file}[/dim]")

    except Exception as e:
        rprint(f"[red]❌ Error: {str(e)}[/red]")


@main.command()
@click.argument("reservation_id")
@click.option(
    "--enable-jupyter",
    is_flag=True,
    help="Enable Jupyter Lab access for this reservation",
)
@click.option(
    "--disable-jupyter",
    is_flag=True,
    help="Disable Jupyter Lab access for this reservation",
)
@click.option(
    "--add-user",
    type=str,
    help="Add GitHub user as secondary user (fetches their public SSH keys)",
)
@click.pass_context
def edit(
    ctx: click.Context,
    reservation_id: str,
    enable_jupyter: bool,
    disable_jupyter: bool,
    add_user: Optional[str],
) -> None:
    """Edit an active reservation's settings

    Modify settings for an existing active reservation such as enabling/disabling Jupyter Lab
    or adding secondary users with SSH access.

    \b
    Examples:
        gpu-dev edit abc12345 --enable-jupyter   # Enable Jupyter Lab
        gpu-dev edit abc12345 --disable-jupyter  # Disable Jupyter Lab
        gpu-dev edit abc12345 --add-user johndoe # Add GitHub user 'johndoe' SSH access
    """
    try:
        if enable_jupyter and disable_jupyter:
            rprint("[red]❌ Cannot enable and disable Jupyter at the same time[/red]")
            return

        if not enable_jupyter and not disable_jupyter and not add_user:
            rprint(
                "[red]❌ Please specify --enable-jupyter, --disable-jupyter, or --add-user[/red]"
            )
            return

        # Authenticate first
        config = load_config()
        user_info = authenticate_user(config)
        if not user_info:
            return

        reservation_mgr = ReservationManager(config)

        # Check if reservation exists and belongs to user
        connection_info = reservation_mgr.get_connection_info(
            reservation_id, user_info["user_id"]
        )
        if not connection_info:
            rprint(
                f"[red]❌ Reservation {reservation_id} not found or doesn't belong to you[/red]"
            )
            return

        if connection_info["status"] != "active":
            rprint(
                f"[red]❌ Can only edit active reservations (current status: {connection_info['status']})[/red]"
            )
            return

        # Enable/disable Jupyter
        if enable_jupyter:
            success = reservation_mgr.enable_jupyter(
                reservation_id, user_info["user_id"]
            )
            if success:
                rprint(
                    f"[green]✅ Jupyter Lab enabled for reservation {reservation_id[:8]}...[/green]"
                )
                rprint(
                    "[blue]💡 Use 'gpu-dev show {reservation_id[:8]}' to see the Jupyter URL[/blue]"
                )
            else:
                rprint("[red]❌ Failed to enable Jupyter Lab[/red]")

        elif disable_jupyter:
            success = reservation_mgr.disable_jupyter(
                reservation_id, user_info["user_id"]
            )
            if success:
                rprint(
                    f"[green]✅ Jupyter Lab disabled for reservation {reservation_id[:8]}...[/green]"
                )
            else:
                rprint("[red]❌ Failed to disable Jupyter Lab[/red]")

        elif add_user:
            success = reservation_mgr.add_user(
                reservation_id, user_info["user_id"], add_user
            )
            if success:
                rprint(
                    f"[green]✅ User {add_user} added to reservation {reservation_id[:8]}...[/green]"
                )
                rprint(
                    f"[blue]💡 {add_user} can now SSH to the server using their GitHub SSH keys[/blue]"
                )
            else:
                rprint(f"[red]❌ Failed to add user {add_user}[/red]")

    except Exception as e:
        rprint(f"[red]❌ Error editing reservation: {str(e)}[/red]")


if __name__ == "__main__":
    main()
