"""
GPU Developer CLI - Main entry point
Reserve and manage GPU development servers
"""

import click
from typing import Optional
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich import print as rprint
from rich.spinner import Spinner
from rich.live import Live

from .auth import authenticate_user, validate_ssh_key_matches_github_user
from .reservations import (
    ReservationManager,
    _generate_vscode_command,
    _add_agent_forwarding_to_ssh,
)
from .config import Config, load_config
from .interactive import (
    select_gpu_type_interactive,
    select_gpu_count_interactive,
    select_duration_interactive,
    select_jupyter_interactive,
    select_reservation_interactive,
    ask_name_interactive,
    select_edit_action_interactive,
    ask_github_username_interactive,
    ask_extension_hours_interactive,
    check_interactive_support,
)

console = Console()


def _show_single_reservation(connection_info: dict) -> None:
    """Display detailed information for a single reservation"""
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


def _validate_ssh_key_or_exit(config: Config, live: Live) -> bool:
    """
    Validate SSH key matches configured GitHub username.
    Returns True if valid, False if validation failed (and exits with error messages).
    """
    validation_result = validate_ssh_key_matches_github_user(config)
    if not validation_result["valid"]:
        live.stop()
        rprint("[red]❌ Github SSH key validation failed[/red]")

        # Provide helpful suggestions
        if validation_result["ssh_user"] and validation_result["configured_user"]:
            rprint("\n[yellow]💡 Fix by updating your config:[/yellow]")
            rprint(
                "   [cyan]gpu-dev config set github_user {validation_result['ssh_user']}[/cyan]"
            )
        elif not validation_result["configured_user"]:
            rprint("\n[yellow]💡 Fix by configuring your GitHub username:[/yellow]")
            rprint(
                "   [cyan]gpu-dev config set github_user <your-github-username>[/cyan]"
            )
        else:
            rprint("\n[yellow]💡 gpu-dev utilizes Github keys for auth![/yellow]")
            rprint(
                "[yellow]💡 Check https://fburl.com/gh-ssh for info on how to add your ssh key to Github[/yellow]"
            )
        return False

    return True


@click.group()
@click.version_option()
@click.pass_context
def main(ctx: click.Context) -> None:
    """\b
    GPU Developer CLI - Reserve and manage GPU development servers

    Reserve GPU-enabled development environments with SSH access.
    Supports 1, 2, 4, 8, or 16 GPU configurations with automatic resource management.

    \b
    Interactive Mode (NEW):
        gpu-dev reserve                         # Interactive reservation (auto-detected)
        gpu-dev cancel                          # Interactive cancellation
        gpu-dev edit                            # Interactive edit

    \b
    Command-line Mode:
        gpu-dev reserve --gpus 2 --hours 4     # Reserve 2 GPUs for 4 hours
        gpu-dev reserve --jupyter               # Reserve with Jupyter Lab
        gpu-dev cancel abc12345                 # Cancel specific reservation
        gpu-dev edit abc12345 --enable-jupyter # Enable Jupyter on reservation

    \b
    Information Commands:
        gpu-dev list                            # Check your reservations
        gpu-dev show                            # Show detailed info for active/pending reservations
        gpu-dev show abc12345                   # Get detailed reservation info
        gpu-dev avail                           # Check GPU availability by type
        gpu-dev status                          # Check cluster status
        gpu-dev help                            # Show this help message

    Interactive mode is automatically enabled when running commands without
    parameters in a terminal. Use --no-interactive to disable.

    Use 'gpu-dev <command> --help' for detailed help on each command.
    """
    ctx.ensure_object(dict)


@main.command()
@click.option(
    "--gpus",
    "-g",
    type=click.Choice(["1", "2", "4", "8", "16"]),
    help="Number of GPUs to reserve (16 = 2x8 GPU setup)",
)
@click.option(
    "--gpu-type",
    type=click.Choice(
        ["b200", "h200", "h100", "a100", "t4", "l4", "t4-small"], case_sensitive=False
    ),
    help="GPU type to reserve (b200/h200/h100/a100/t4/l4/t4-small)",
)
@click.option(
    "--hours",
    "-h",
    type=float,
    help="Reservation duration in hours (supports decimals, max 24)",
)
@click.option("--name", "-n", type=str, help="Optional name for the reservation")
@click.option(
    "--jupyter",
    is_flag=True,
    help="Enable Jupyter Lab access (can be enabled later with 'gpu-dev edit')",
)
@click.option(
    "--ignore-no-persist",
    is_flag=True,
    help="Skip persistent disk warning for multiple reservations",
)
@click.option(
    "--recreate-env",
    is_flag=True,
    help="Recreate shell environment (bashrc/zshrc/oh-my-zsh) even on existing persistent disk",
)
@click.option(
    "--interactive/--no-interactive",
    default=None,
    help="Force interactive mode on/off (auto-detected by default)",
)
@click.pass_context
def reserve(
    ctx: click.Context,
    gpus: Optional[str],
    gpu_type: Optional[str],
    hours: Optional[float],
    name: Optional[str],
    jupyter: bool,
    ignore_no_persist: bool,
    recreate_env: bool,
    interactive: Optional[bool],
) -> None:
    """Reserve GPU development server(s)

    Creates a reservation for GPU-enabled development environment with SSH access.
    The environment includes PyTorch, CUDA, and common ML tools pre-installed.

    \b
    Interactive Mode (NEW):
        gpu-dev reserve                          # Interactive mode - guided setup

    The interactive mode will:
    - Show GPU availability table
    - Let you select GPU type with arrow keys
    - Choose number of GPUs
    - Select duration with presets
    - Optional Jupyter Lab and naming

    \b
    Command-line Mode:
        gpu-dev reserve -g 4 -h 2.5             # 4 GPUs for 2.5 hours
        gpu-dev reserve -g 8 -h 12 -n "training" # 8 GPUs, named reservation
        gpu-dev reserve --jupyter                # Include Jupyter Lab access
        gpu-dev reserve --gpu-type h200 -g 2    # 2 H200 GPUs

    GPU Options:
        1, 2, 4, 8: Single server with specified GPU count
        16: Two connected servers with 8 GPUs each (high-speed interconnect)

    Authentication: Uses your AWS credentials and GitHub SSH keys
    """
    try:
        # Determine if we should use interactive mode
        use_interactive = interactive
        if use_interactive is None:
            # Auto-detect: use interactive if no key parameters provided
            use_interactive = (
                gpus is None or gpu_type is None or hours is None
            ) and check_interactive_support()

        # GPU config for validation
        gpu_configs = {
            "t4": {"max_gpus": 4, "instance_type": "g4dn.12xlarge"},
            "l4": {"max_gpus": 4, "instance_type": "g6.12xlarge"},
            "t4-small": {"max_gpus": 1, "instance_type": "g4dn.xlarge"},
            "a100": {"max_gpus": 8, "instance_type": "p4d.24xlarge"},
            "h100": {"max_gpus": 8, "instance_type": "p5.48xlarge"},
            "h200": {"max_gpus": 8, "instance_type": "p5e.48xlarge"},
            "b200": {"max_gpus": 8, "instance_type": "p6-b200.48xlarge"},
        }

        if use_interactive:
            # Interactive mode - gather parameters interactively
            rprint("[cyan]🎯 Interactive reservation mode[/cyan]")
            rprint("[dim]Use --no-interactive flag to disable interactive mode[/dim]\n")

            # Setup config early for availability check
            with Live(
                Spinner("dots", text="📡 Loading GPU availability..."), console=console
            ) as live:
                config = load_config()
                try:
                    user_info = authenticate_user(config)
                except RuntimeError as e:
                    live.stop()
                    rprint(f"[red]❌ {str(e)}[/red]")
                    return

                # Validate SSH key matches configured GitHub username
                live.update(Spinner("dots", text="🔐 Validating SSH key..."))
                if not _validate_ssh_key_or_exit(config, live):
                    return

                live.update(Spinner("dots", text="📡 Loading GPU availability..."))
                reservation_mgr = ReservationManager(config)
                availability_info = reservation_mgr.get_gpu_availability_by_type()

            live.stop()

            if not availability_info:
                rprint("[red]❌ Could not get GPU availability information[/red]")
                return

            # Interactive GPU type selection
            if gpu_type is None:
                gpu_type = select_gpu_type_interactive(availability_info)
                if gpu_type is None:
                    rprint("[yellow]Reservation cancelled.[/yellow]")
                    return

            # Interactive GPU count selection
            if gpus is None:
                gpu_type_lower = gpu_type.lower()
                if gpu_type_lower not in gpu_configs:
                    rprint(f"[red]❌ Invalid GPU type '{gpu_type}'[/red]")
                    return

                max_gpus = gpu_configs[gpu_type_lower]["max_gpus"]
                gpu_count = select_gpu_count_interactive(gpu_type_lower, max_gpus)
                if gpu_count is None:
                    rprint("[yellow]Reservation cancelled.[/yellow]")
                    return
            else:
                gpu_count = int(gpus)

            # Interactive duration selection
            if hours is None:
                hours = select_duration_interactive()
                if hours is None:
                    rprint("[yellow]Reservation cancelled.[/yellow]")
                    return

            # Interactive Jupyter selection (if not already set via flag)
            if not jupyter:  # Only ask if not already enabled via flag
                jupyter_interactive = select_jupyter_interactive()
                if jupyter_interactive is None:
                    rprint("[yellow]Reservation cancelled.[/yellow]")
                    return
                jupyter = jupyter_interactive

            # Interactive name selection
            if name is None:
                name = ask_name_interactive()
                # name can be None, that's fine

        else:
            # Non-interactive mode - use defaults and validate
            if gpus is None:
                gpus = "1"
            if gpu_type is None:
                gpu_type = "a100"
            if hours is None:
                hours = 8.0

            gpu_count = int(gpus)

        # Validate GPU type and count (for both modes)
        gpu_type = gpu_type.lower()  # Normalize to lowercase

        if gpu_type not in gpu_configs:
            valid_types = ", ".join(sorted(gpu_configs.keys()))
            rprint(
                f"[red]❌ Invalid GPU type '{gpu_type}'. Valid types: {valid_types}[/red]"
            )
            return

        max_gpus = gpu_configs[gpu_type]["max_gpus"]
        if gpu_count > max_gpus:
            rprint(
                f"[red]❌ GPU type '{gpu_type}' supports maximum {max_gpus} GPUs per node, requested {gpu_count}[/red]"
            )
            return

        # Validate parameters
        if hours > 24:
            rprint("[red]❌ Maximum reservation time is 24 hours[/red]")
            return

        if hours < 0.0833:  # Less than 5 minutes
            rprint("[red]❌ Minimum reservation time is 5 minutes (0.0833 hours)[/red]")
            return

        # Use a single spinner context for the entire process
        with Live(
            Spinner("dots", text="📡 Starting reservation process..."), console=console
        ) as live:
            # Setup config and reservation manager
            if use_interactive:
                # Already have config, user_info, and reservation_mgr from interactive setup
                pass
            else:
                # Load config for non-interactive mode
                live.update(
                    Spinner("dots", text="📡 Contacting reservation service...")
                )
                config = load_config()

                live.update(Spinner("dots", text="📡 Authenticating..."))

                # Authenticate using AWS credentials - if you can call AWS, you're authorized
                try:
                    user_info = authenticate_user(config)
                except RuntimeError as e:
                    live.stop()
                    rprint(f"[red]❌ {str(e)}[/red]")
                    return

                # Validate SSH key matches configured GitHub username
                live.update(Spinner("dots", text="🔐 Validating SSH key..."))
                if not _validate_ssh_key_or_exit(config, live):
                    return

                live.update(
                    Spinner("dots", text="📡 Setting up reservation manager...")
                )
                reservation_mgr = ReservationManager(config)

            # Check for existing reservations with persistent disks (persistent disk warning)
            live.update(Spinner("dots", text="📡 Checking existing reservations..."))

            persistent_reservations = []
            if not ignore_no_persist:
                existing_reservations = reservation_mgr.list_reservations(
                    user_filter=user_info["user_id"],
                    statuses_to_include=["active", "preparing", "queued", "pending"],
                )

                # Find reservations that actually have persistent disks
                persistent_reservations = [
                    res
                    for res in existing_reservations
                    if res.get("ebs_volume_id") and res.get("ebs_volume_id").strip()
                ]

            # Stop spinner before user interaction
            if persistent_reservations:
                live.stop()
                persistent_res = persistent_reservations[0]  # Should only be one
                persistent_res_id = persistent_res.get("reservation_id", "unknown")[:8]

                rprint(
                    f"\n[yellow]⚠️  Warning: Your persistent disk is currently mounted on reservation {persistent_res_id}[/yellow]"
                )
                rprint(
                    "[yellow]This new reservation will NOT have a persistent disk and will start empty.[/yellow]"
                )
                rprint(
                    "[yellow]Your data will NOT be automatically backed up when it expires.[/yellow]"
                )
                rprint("\n[cyan]Options:[/cyan]")
                rprint(
                    "1. Continue and make this new reservation without persistent data disk"
                )
                rprint(
                    f"2. Cancel existing reservation with persistent disk: [cyan]gpu-dev cancel {persistent_res_id}[/cyan]"
                )
                rprint(
                    f"3. Use [cyan]--ignore-no-persist[/cyan] flag to skip this warning"
                )

                # Ask for confirmation
                try:
                    choice = click.confirm(
                        "\nDo you want to continue with a new reservation (no persistent disk)?"
                    )
                    if not choice:
                        rprint("[yellow]Reservation cancelled by user[/yellow]")
                        return
                except (KeyboardInterrupt, click.Abort):
                    rprint("\n[yellow]Reservation cancelled by user[/yellow]")
                    return

                # Restart spinner for submission
                live.start()
                live.update(
                    Spinner("dots", text="📡 Submitting reservation request...")
                )
            else:
                # No persistent reservations - continue with same spinner
                live.update(
                    Spinner("dots", text="📡 Submitting reservation request...")
                )

            # Submit reservation
            reservation_id = reservation_mgr.create_reservation(
                user_id=user_info["user_id"],
                gpu_count=gpu_count,
                gpu_type=gpu_type,
                duration_hours=hours,
                name=name,
                github_user=user_info["github_user"],
                jupyter_enabled=jupyter,
                recreate_env=recreate_env,
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
        with Live(
            Spinner("dots", text="📡 Fetching reservations..."), console=console
        ) as live:
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
                            live.stop()
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
                live.stop()
                rprint(f"[red]❌ {str(e)}[/red]")
                return

        # Stop spinner after getting results
        live.stop()

        if not reservations:
            rprint("[yellow]📋 No reservations found[/yellow]")
            return

        # Create table with enhanced columns for queue info
        table = Table(title="GPU Reservations")
        table.add_column("ID", style="cyan", no_wrap=True)
        table.add_column("User", style="green")
        table.add_column("GPUs", style="magenta")
        table.add_column("Status", style="yellow")
        table.add_column("Storage", style="dim", no_wrap=True)
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

                # Extract persistent disk info for storage indicator
                ebs_volume_id = reservation.get("ebs_volume_id", None)

                # Format user display (part before @)
                user_display = user_id
                if "@" in user_id:
                    user_display = user_id.split("@")[0]

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

                # Format storage indicator
                if ebs_volume_id and ebs_volume_id.strip():
                    storage_display = "persistent"
                else:
                    storage_display = "temporary"

                # Format created_at datetime (similar to expires formatting)
                created_formatted = "N/A"
                if created_at and created_at != "N/A":
                    try:
                        from datetime import datetime

                        if isinstance(created_at, str):
                            # Handle different ISO format variations
                            if created_at.endswith("Z"):
                                created_dt_utc = datetime.fromisoformat(
                                    created_at.replace("Z", "+00:00")
                                )
                            elif "+" in created_at or created_at.endswith("00:00"):
                                created_dt_utc = datetime.fromisoformat(created_at)
                            else:
                                # Assume naive datetime is UTC
                                from datetime import timezone

                                naive_dt = datetime.fromisoformat(created_at)
                                created_dt_utc = naive_dt.replace(tzinfo=timezone.utc)

                            created_dt = created_dt_utc.astimezone()  # Convert to local
                            created_formatted = created_dt.strftime("%m-%d %H:%M")
                        else:
                            # Legacy timestamp
                            created_dt = datetime.fromtimestamp(created_at)
                            created_formatted = created_dt.strftime("%m-%d %H:%M")
                    except (ValueError, TypeError):
                        # Fallback to old format
                        if len(str(created_at)) > 10:
                            created_formatted = str(created_at)[:10]
                        else:
                            created_formatted = str(created_at)

                table.add_row(
                    str(reservation_id)[:8],
                    user_display,
                    gpu_display,
                    str(status),
                    storage_display,
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
@click.argument("reservation_id", required=False)
@click.option(
    "--all",
    is_flag=True,
    help="Cancel all your cancellable reservations (requires confirmation)",
)
@click.option(
    "--interactive/--no-interactive",
    default=None,
    help="Force interactive mode on/off (auto-detected by default)",
)
@click.pass_context
def cancel(
    ctx: click.Context,
    reservation_id: Optional[str],
    all: bool,
    interactive: Optional[bool],
) -> None:
    """Cancel a GPU reservation

    Cancels an active, queued, or pending reservation and releases resources.
    You can only cancel your own reservations.

    \b
    Interactive Mode (NEW):
        gpu-dev cancel                           # Interactive mode - select from list

    Interactive mode shows a table of your cancellable reservations and lets you
    select one with arrow keys. If you have multiple reservations, an "All" option
    will be available to cancel all reservations at once.

    \b
    Command-line Mode:
        gpu-dev cancel abc12345                  # Cancel reservation abc12345
        gpu-dev cancel abc1                      # Short form also works
        gpu-dev cancel --all                     # Cancel ALL your reservations (with confirmation)

    Note: Cancelled reservations cannot be restored. Active pods will be terminated.
    """
    try:
        # Validate conflicting options
        if all and reservation_id:
            rprint("[red]❌ Cannot specify both --all and a reservation ID[/red]")
            return

        # Handle --all flag (non-interactive)
        if all:
            with Live(
                Spinner("dots", text="📡 Loading your reservations..."), console=console
            ) as live:
                config = load_config()
                try:
                    user_info = authenticate_user(config)
                except RuntimeError as e:
                    live.stop()
                    rprint(f"[red]❌ {str(e)}[/red]")
                    return

                reservation_mgr = ReservationManager(config)

                # Get cancellable reservations
                reservations = reservation_mgr.list_reservations(
                    user_filter=user_info["user_id"],
                    statuses_to_include=["active", "queued", "pending", "preparing"],
                )

            live.stop()

            if not reservations:
                rprint("[yellow]📋 No cancellable reservations found[/yellow]")
                return

            # Show reservations and confirm
            rprint(
                f"[yellow]⚠️  You are about to cancel {len(reservations)} reservation(s):[/yellow]\n"
            )

            # Create table of reservations to be cancelled
            table = Table()
            table.add_column("ID", style="cyan", no_wrap=True)
            table.add_column("GPUs", style="magenta")
            table.add_column("Status", style="yellow")
            table.add_column("Created", style="blue")

            for reservation in reservations:
                reservation_id_display = reservation.get("reservation_id", "unknown")[
                    :8
                ]
                gpu_count = reservation.get("gpu_count", 1)
                gpu_type = reservation.get("gpu_type", "unknown")
                status = reservation.get("status", "unknown")
                created_at = reservation.get("created_at", "N/A")

                # Format GPU information
                if gpu_type and gpu_type not in ["unknown", "Unknown"]:
                    gpu_display = f"{gpu_count}x {gpu_type.upper()}"
                else:
                    gpu_display = str(gpu_count)

                # Format created_at
                created_formatted = "N/A"
                if created_at and created_at != "N/A":
                    try:
                        from datetime import datetime

                        if isinstance(created_at, str):
                            if created_at.endswith("Z"):
                                created_dt_utc = datetime.fromisoformat(
                                    created_at.replace("Z", "+00:00")
                                )
                            elif "+" in created_at or created_at.endswith("00:00"):
                                created_dt_utc = datetime.fromisoformat(created_at)
                            else:
                                from datetime import timezone

                                naive_dt = datetime.fromisoformat(created_at)
                                created_dt_utc = naive_dt.replace(tzinfo=timezone.utc)

                            created_dt = created_dt_utc.astimezone()
                            created_formatted = created_dt.strftime("%m-%d %H:%M")
                        else:
                            created_dt = datetime.fromtimestamp(created_at)
                            created_formatted = created_dt.strftime("%m-%d %H:%M")
                    except (ValueError, TypeError):
                        created_formatted = (
                            str(created_at)[:10]
                            if len(str(created_at)) > 10
                            else str(created_at)
                        )

                table.add_row(
                    reservation_id_display, gpu_display, status, created_formatted
                )

            console.print(table)

            # Confirmation prompt
            try:
                confirmed = click.confirm(
                    f"\n[red]⚠️  Are you sure you want to cancel ALL {len(reservations)} reservations? This cannot be undone.[/red]"
                )
                if not confirmed:
                    rprint("[yellow]Cancellation cancelled by user[/yellow]")
                    return
            except (KeyboardInterrupt, click.Abort):
                rprint("\n[yellow]Cancellation cancelled by user[/yellow]")
                return

            # Cancel all reservations
            cancelled_count = 0
            failed_count = 0

            with Live(
                Spinner("dots", text="📡 Cancelling reservations..."), console=console
            ) as live:
                for reservation in reservations:
                    res_id = reservation.get("reservation_id", "")
                    if res_id:
                        success = reservation_mgr.cancel_reservation(
                            res_id, user_info["user_id"]
                        )
                        if success:
                            cancelled_count += 1
                        else:
                            failed_count += 1

            live.stop()

            # Report results
            if cancelled_count > 0:
                rprint(
                    f"[green]✅ Successfully cancelled {cancelled_count} reservation(s)[/green]"
                )
            if failed_count > 0:
                rprint(f"[red]❌ Failed to cancel {failed_count} reservation(s)[/red]")

            return

        # Determine if we should use interactive mode
        use_interactive = interactive
        if use_interactive is None:
            # Auto-detect: use interactive if no reservation_id provided
            use_interactive = reservation_id is None and check_interactive_support()

        if use_interactive:
            # Interactive mode - show reservations and let user select
            rprint("[cyan]🎯 Interactive cancellation mode[/cyan]")
            rprint("[dim]Use --no-interactive flag to disable interactive mode[/dim]\n")

            with Live(
                Spinner("dots", text="📡 Loading your reservations..."), console=console
            ) as live:
                config = load_config()
                try:
                    user_info = authenticate_user(config)
                except RuntimeError as e:
                    live.stop()
                    rprint(f"[red]❌ {str(e)}[/red]")
                    return

                reservation_mgr = ReservationManager(config)

                # Get cancellable reservations (active, queued, pending, preparing)
                reservations = reservation_mgr.list_reservations(
                    user_filter=user_info["user_id"],
                    statuses_to_include=["active", "queued", "pending", "preparing"],
                )

            live.stop()

            if not reservations:
                rprint("[yellow]📋 No cancellable reservations found[/yellow]")
                return

            # Interactive selection
            selected_id = select_reservation_interactive(reservations, "cancel")
            if selected_id is None:
                rprint("[yellow]Cancellation cancelled.[/yellow]")
                return

            # Handle "all" selection
            if selected_id == "__ALL__":
                # Confirmation prompt for cancelling all
                try:
                    confirmed = click.confirm(
                        f"\n[red]⚠️  Are you sure you want to cancel ALL {len(reservations)} reservations? This cannot be undone.[/red]"
                    )
                    if not confirmed:
                        rprint("[yellow]Cancellation cancelled by user[/yellow]")
                        return
                except (KeyboardInterrupt, click.Abort):
                    rprint("\n[yellow]Cancellation cancelled by user[/yellow]")
                    return

                # Cancel all reservations
                cancelled_count = 0
                failed_count = 0

                with Live(
                    Spinner("dots", text="📡 Cancelling all reservations..."),
                    console=console,
                ) as live:
                    for reservation in reservations:
                        res_id = reservation.get("reservation_id", "")
                        if res_id:
                            success = reservation_mgr.cancel_reservation(
                                res_id, user_info["user_id"]
                            )
                            if success:
                                cancelled_count += 1
                            else:
                                failed_count += 1

                live.stop()

                # Report results
                if cancelled_count > 0:
                    rprint(
                        f"[green]✅ Successfully cancelled {cancelled_count} reservation(s)[/green]"
                    )
                if failed_count > 0:
                    rprint(
                        f"[red]❌ Failed to cancel {failed_count} reservation(s)[/red]"
                    )

                return

            reservation_id = selected_id

        if not reservation_id:
            rprint("[red]❌ No reservation ID provided[/red]")
            return

        # Proceed with cancellation
        with Live(
            Spinner("dots", text="📡 Contacting reservation service..."),
            console=console,
        ) as live:
            if not use_interactive:
                # Load config if not already loaded
                config = load_config()
                try:
                    user_info = authenticate_user(config)
                    reservation_mgr = ReservationManager(config)
                except RuntimeError as e:
                    live.stop()
                    rprint(f"[red]❌ {str(e)}[/red]")
                    return

            success = reservation_mgr.cancel_reservation(
                reservation_id, user_info["user_id"]
            )

        live.stop()

        if success:
            rprint(f"[green]✅ Reservation {reservation_id[:8]} cancelled[/green]")
        else:
            rprint(f"[red]❌ Failed to cancel reservation {reservation_id[:8]}[/red]")

    except Exception as e:
        rprint(f"[red]❌ Error: {str(e)}[/red]")


@main.command()
@click.argument("reservation_id", required=False)
@click.pass_context
def show(ctx: click.Context, reservation_id: Optional[str]) -> None:
    """Show detailed information for reservations

    Shows comprehensive details for reservations. If no reservation ID is provided,
    shows details for your active and pending reservations. If a reservation ID is provided,
    shows detailed information for that specific reservation.

    Arguments:
        RESERVATION_ID: Optional reservation ID (8-character prefix is sufficient)

    \b
    Examples:
        gpu-dev show                             # Show details for active/pending reservations
        gpu-dev show abc12345                    # Show details for abc12345
        gpu-dev show abc1                        # Short form works too

    When showing multiple reservations, the output includes:
        - Your active and pending reservations with full details
        - SSH connection commands for active reservations
        - Status information for all shown reservations

    When showing a specific reservation, the output includes:
        - SSH connection command
        - Pod name and namespace
        - GPU count and type
        - Reservation start time
        - Expiration time
        - Current status

    Works for reservations in any status.
    """
    try:
        with Live(
            Spinner("dots", text="📡 Fetching reservation details..."), console=console
        ) as live:
            config = load_config()

            # Authenticate using AWS credentials
            try:
                user_info = authenticate_user(config)
                reservation_mgr = ReservationManager(config)
                
                if reservation_id is None:
                    # Show user's active and pending reservations
                    reservations = reservation_mgr.list_reservations(
                        user_filter=user_info["user_id"],
                        statuses_to_include=["active", "preparing", "queued", "pending"]
                    )
                    
                    live.stop()
                    
                    if not reservations:
                        rprint("[yellow]📋 No reservations found[/yellow]")
                        return

                    # Show detailed info for each reservation
                    for i, reservation in enumerate(reservations):
                        if i > 0:
                            rprint("")  # Add spacing between reservations
                        
                        res_id = reservation.get("reservation_id", "unknown")
                        connection_info = reservation_mgr.get_connection_info(
                            res_id, user_info["user_id"]
                        )
                        
                        if connection_info:
                            # Use the existing display logic from the original show command
                            _show_single_reservation(connection_info)
                    
                    return
                else:
                    # Show specific reservation
                    connection_info = reservation_mgr.get_connection_info(
                        reservation_id, user_info["user_id"]
                    )
                    
            except RuntimeError as e:
                live.stop()
                rprint(f"[red]❌ {str(e)}[/red]")
                return

        live.stop()

        if connection_info:
            _show_single_reservation(connection_info)
        else:
            rprint(f"[red]❌ Could not get connection info for {reservation_id}[/red]")

    except Exception as e:
        rprint(f"[red]❌ Error: {str(e)}[/red]")


def _show_availability() -> None:
    """Shared function to show GPU availability"""
    try:
        with Live(
            Spinner("dots", text="📡 Checking GPU availability..."), console=console
        ) as live:
            config = load_config()

            # Authenticate using AWS credentials
            try:
                user_info = authenticate_user(config)
                reservation_mgr = ReservationManager(config)
                availability_info = reservation_mgr.get_gpu_availability_by_type()
            except RuntimeError as e:
                live.stop()
                rprint(f"[red]❌ {str(e)}[/red]")
                return

        # Stop spinner after getting results

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
def help(ctx: click.Context) -> None:
    """Show help information (equivalent to --help)

    Displays the same help information as using --help flag.

    \b
    Examples:
        gpu-dev help                            # Show main help
        gpu-dev help                            # Same as gpu-dev --help
    """
    click.echo(ctx.parent.get_help())


@main.command(name="avail")
@click.pass_context
def avail(ctx: click.Context) -> None:
    """Show GPU availability by type and queue estimates

    Displays real-time information about GPU availability for each GPU type.
    Shows immediate availability and estimated queue times when resources are full.

    Information shown per GPU type:
        - Available GPUs: GPUs ready for immediate reservation
        - Queue Length: Number of pending reservations for this GPU type
        - Estimated Wait: Expected time until resources become available

    \b
    Examples:
        gpu-dev avail                           # Show availability for all GPU types

    This helps you choose the right GPU type and understand wait times before reserving.
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
        with Live(
            Spinner("dots", text="📡 Checking cluster status..."), console=console
        ) as live:
            config = load_config()

            # Authenticate using AWS credentials
            try:
                user_info = authenticate_user(config)
                reservation_mgr = ReservationManager(config)
                cluster_status = reservation_mgr.get_cluster_status()
            except RuntimeError as e:
                live.stop()
                rprint(f"[red]❌ {str(e)}[/red]")
                return

        # Stop spinner after getting results

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

        # Get current environment info
        env_config = getattr(config, "environment_config", {})
        current_env = env_config.get("current_environment", "Not set")
        env_source = "Environment config" if env_config else "Default/ENV vars"

        config_text = (
            f"[green]Configuration (Zero-Config)[/green]\n\n"
            f"[blue]Environment:[/blue] {current_env}\n"
            f"[blue]Region:[/blue] {config.aws_region} ({env_source})\n"
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


@config.command()
@click.argument("env_name", type=click.Choice(["test", "prod"]))
def environment(env_name: str) -> None:
    """Set the environment (test or prod)

    Sets the AWS region and Terraform workspace for the specified environment.
    This configuration is used by the switch-to.sh script.

    Arguments:
        ENV_NAME: Environment name (test or prod)

    \b
    Examples:
        gpu-dev config environment test   # Set to test environment (us-west-1)
        gpu-dev config environment prod   # Set to prod environment (us-east-2)

    Environment configurations:
        test: us-west-1, Terraform workspace 'default'
        prod: us-east-2, Terraform workspace 'prod'
    """
    import os
    import json
    from pathlib import Path

    try:
        # Environment configurations
        environments = {
            "test": {
                "region": "us-west-1",
                "workspace": "default",
                "description": "Test environment",
            },
            "prod": {
                "region": "us-east-2",
                "workspace": "prod",
                "description": "Production environment",
            },
        }

        env_config = environments[env_name]

        # Save environment configuration
        config_file = Path.home() / ".gpu-dev-environment.json"
        config_data = {
            "current_environment": env_name,
            "region": env_config["region"],
            "workspace": env_config["workspace"],
        }

        with open(config_file, "w") as f:
            json.dump(config_data, f, indent=2)

        # Set environment variable for current session
        os.environ["AWS_DEFAULT_REGION"] = env_config["region"]

        rprint(f"[green]✅ Environment set to {env_name}[/green]")
        rprint(f"[blue]Region:[/blue] {env_config['region']}")
        rprint(f"[blue]Workspace:[/blue] {env_config['workspace']}")
        rprint(f"[blue]Description:[/blue] {env_config['description']}")
        rprint(f"[dim]Configuration saved to {config_file}[/dim]")

        # Instructions for shell export
        rprint(f"\n[yellow]💡 To apply in your current shell:[/yellow]")
        rprint(f"   export AWS_DEFAULT_REGION={env_config['region']}")
        rprint(f"\n[yellow]💡 Or use the switch-to.sh script:[/yellow]")
        rprint(f"   ./switch-to.sh {env_name}")

    except Exception as e:
        rprint(f"[red]❌ Error setting environment: {str(e)}[/red]")


@main.command()
@click.argument("reservation_id", required=False)
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
@click.option(
    "--extend",
    type=float,
    help="Extend reservation by specified hours (max extension: 24h)",
)
@click.option(
    "--interactive/--no-interactive",
    default=None,
    help="Force interactive mode on/off (auto-detected by default)",
)
@click.pass_context
def edit(
    ctx: click.Context,
    reservation_id: Optional[str],
    enable_jupyter: bool,
    disable_jupyter: bool,
    add_user: Optional[str],
    extend: Optional[float],
    interactive: Optional[bool],
) -> None:
    """Edit an active reservation's settings

    Modify settings for an existing active reservation such as enabling/disabling Jupyter Lab,
    adding secondary users with SSH access, or extending the reservation duration.

    \b
    Interactive Mode (NEW):
        gpu-dev edit                            # Interactive mode - select reservation & action

    Interactive mode will:
    - Show your active reservations to select from
    - Let you choose what to edit (Jupyter, users, duration)
    - Guide you through the specific changes

    \b
    Command-line Mode:
        gpu-dev edit abc12345 --enable-jupyter  # Enable Jupyter Lab
        gpu-dev edit abc12345 --disable-jupyter # Disable Jupyter Lab
        gpu-dev edit abc12345 --add-user johndoe # Add GitHub user 'johndoe' SSH access
        gpu-dev edit abc12345 --extend 8        # Extend by 8 hours
    """
    try:
        # Determine if we should use interactive mode
        use_interactive = interactive
        if use_interactive is None:
            # Auto-detect: use interactive if no reservation_id or no action provided
            no_action = (
                not enable_jupyter
                and not disable_jupyter
                and not add_user
                and extend is None
            )
            use_interactive = (
                reservation_id is None or no_action
            ) and check_interactive_support()

        if use_interactive:
            # Interactive mode
            rprint("[cyan]🎯 Interactive edit mode[/cyan]")
            rprint("[dim]Use --no-interactive flag to disable interactive mode[/dim]\n")

            # Load reservations and let user select
            with Live(
                Spinner("dots", text="📡 Loading your reservations..."), console=console
            ) as live:
                config = load_config()
                try:
                    user_info = authenticate_user(config)
                except RuntimeError as e:
                    live.stop()
                    rprint(f"[red]❌ {str(e)}[/red]")
                    return

                reservation_mgr = ReservationManager(config)

                if reservation_id is None:
                    # Get active reservations (only active can be edited)
                    reservations = reservation_mgr.list_reservations(
                        user_filter=user_info["user_id"], statuses_to_include=["active"]
                    )

                    live.stop()

                    if not reservations:
                        rprint(
                            "[yellow]📋 No active reservations found to edit[/yellow]"
                        )
                        return

                    # Interactive reservation selection
                    selected_id = select_reservation_interactive(reservations, "edit")
                    if selected_id is None:
                        rprint("[yellow]Edit cancelled.[/yellow]")
                        return

                    reservation_id = selected_id
                else:
                    live.stop()

            # Interactive action selection if no action specified
            no_action = (
                not enable_jupyter
                and not disable_jupyter
                and not add_user
                and extend is None
            )
            if no_action:
                action = select_edit_action_interactive()
                if action is None:
                    rprint("[yellow]Edit cancelled.[/yellow]")
                    return

                # Set appropriate flags based on selected action
                if action == "enable_jupyter":
                    enable_jupyter = True
                elif action == "disable_jupyter":
                    disable_jupyter = True
                elif action == "add_user":
                    add_user = ask_github_username_interactive()
                    if add_user is None:
                        rprint("[yellow]Edit cancelled.[/yellow]")
                        return
                elif action == "extend":
                    extend = ask_extension_hours_interactive()
                    if extend is None:
                        rprint("[yellow]Edit cancelled.[/yellow]")
                        return

        # Validation
        if enable_jupyter and disable_jupyter:
            rprint("[red]❌ Cannot enable and disable Jupyter at the same time[/red]")
            return

        if (
            not enable_jupyter
            and not disable_jupyter
            and not add_user
            and extend is None
        ):
            rprint(
                "[red]❌ Please specify --enable-jupyter, --disable-jupyter, --add-user, or --extend[/red]"
            )
            return

        if not reservation_id:
            rprint("[red]❌ No reservation ID provided[/red]")
            return

        # Authenticate and validate reservation (skip if already done in interactive mode)
        with Live(
            Spinner("dots", text="📡 Contacting reservation service..."),
            console=console,
        ) as live:
            if not use_interactive:
                config = load_config()
                user_info = authenticate_user(config)
                if not user_info:
                    live.stop()
                    return
                reservation_mgr = ReservationManager(config)

            # Check if reservation exists and belongs to user
            connection_info = reservation_mgr.get_connection_info(
                reservation_id, user_info["user_id"]
            )
            if not connection_info:
                live.stop()
                rprint(
                    f"[red]❌ Reservation {reservation_id[:8]} not found or doesn't belong to you[/red]"
                )
                return

        # Stop spinner before validation and operations
        live.stop()

        if connection_info["status"] != "active":
            rprint(
                f"[red]❌ Can only edit active reservations (current status: {connection_info['status']})[/red]"
            )
            return

        # Handle extension request
        if extend is not None:
            # Validate extension limits
            if extend <= 0:
                rprint("[red]❌ Extension hours must be positive[/red]")
                return
            if extend > 24:
                rprint("[red]❌ Maximum extension is 24 hours[/red]")
                return

            success = reservation_mgr.extend_reservation(reservation_id, extend)
            if success:
                rprint(
                    f"[green]✅ Extended reservation {reservation_id} by {extend} hours[/green]"
                )
            else:
                rprint(f"[red]❌ Failed to extend reservation {reservation_id}[/red]")
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
