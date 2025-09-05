"""Interactive CLI components for GPU Developer CLI"""

import sys
from typing import Dict, List, Optional, Any

try:
    import questionary
    from questionary import Style

    INTERACTIVE_AVAILABLE = True
except ImportError:
    INTERACTIVE_AVAILABLE = False

from rich.console import Console
from rich.table import Table
from rich.panel import Panel

console = Console()

# Custom style for questionary - softer colors
custom_style = Style(
    [
        ("question", "fg:#5f87af bold"),  # Soft blue
        ("answer", "fg:#5f87af bold"),  # Soft blue
        ("pointer", "fg:#5f87af bold"),  # Soft blue
        ("highlighted", "fg:#5f87af"),  # Soft blue, no bold
        ("selected", "fg:#87af87"),  # Soft green
        ("separator", "fg:#808080"),  # Neutral gray
        ("instruction", ""),
        ("text", ""),
        ("disabled", "fg:#858585 italic"),
    ]
)


def check_interactive_support() -> bool:
    """Check if interactive mode is available"""
    if not INTERACTIVE_AVAILABLE:
        console.print(
            "[red]❌ Interactive mode requires 'questionary'. Install with: pip install questionary[/red]"
        )
        return False

    if not sys.stdin.isatty():
        console.print(
            "[yellow]⚠️  Non-interactive terminal detected. Use command-line flags instead.[/yellow]"
        )
        return False

    return True


def select_gpu_type_interactive(
    availability_info: Dict[str, Dict[str, Any]],
) -> Optional[str]:
    """Interactive GPU type selection with availability table"""
    if not check_interactive_support():
        return None

    # Display availability table first
    console.print("\n[cyan]🖥️  GPU Availability:[/cyan]")
    table = Table()
    table.add_column("GPU Type", style="cyan")
    table.add_column("Available", style="green")
    table.add_column("Total", style="blue")
    table.add_column("Queue Length", style="yellow")
    table.add_column("Est. Wait Time", style="magenta")

    choices = []
    for gpu_type, info in availability_info.items():
        available = info.get("available", 0)
        total = info.get("total", 0)
        queue_length = info.get("queue_length", 0)
        est_wait = info.get("estimated_wait_minutes", 0)

        # Format wait time
        if available > 0:
            wait_display = "Available now"
            status_indicator = "✅"
        elif est_wait == 0:
            wait_display = "Unknown"
            status_indicator = "⚠️"
        elif est_wait < 60:
            wait_display = f"{int(est_wait)}min"
            status_indicator = "⏳"
        else:
            hours = int(est_wait // 60)
            minutes = int(est_wait % 60)
            if minutes == 0:
                wait_display = f"{hours}h"
            else:
                wait_display = f"{hours}h {minutes}min"
            status_indicator = "⏳"

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

        # Create choice label with status
        choice_label = (
            f"{status_indicator} {gpu_type.upper()} ({available}/{total} available)"
        )
        if queue_length > 0:
            choice_label += f" - {queue_length} in queue"

        choices.append(questionary.Choice(title=choice_label, value=gpu_type))

    console.print(table)
    console.print()

    # Interactive selection
    try:
        answer = questionary.select(
            "Select GPU type:", choices=choices, style=custom_style
        ).ask()

        return answer
    except (KeyboardInterrupt, EOFError):
        console.print("\n[yellow]Selection cancelled.[/yellow]")
        return None


def select_gpu_count_interactive(gpu_type: str, max_gpus: int) -> Optional[int]:
    """Interactive GPU count selection"""
    if not check_interactive_support():
        return None

    # Generate valid choices based on GPU type limits
    if gpu_type in ["t4", "l4"]:
        valid_counts = [1, 2, 4]
        # Add multinode options
        multinode_counts = [8, 12, 16, 20, 24]  # multiples of 4
    elif gpu_type == "t4-small":
        valid_counts = [1]
        multinode_counts = [2, 3, 4, 5, 6]  # multiples of 1
    else:  # a100, h100, h200, b200
        valid_counts = [1, 2, 4, 8]
        # Add multinode options
        multinode_counts = [16, 24, 32, 40, 48]  # multiples of 8

    # Filter single-node by actual max for this GPU type
    valid_counts = [count for count in valid_counts if count <= max_gpus]
    
    # Add multinode options (multiples of max_gpus)
    multinode_counts = [count for count in multinode_counts if count % max_gpus == 0]

    choices = []
    
    # Add single-node options
    for count in valid_counts:
        if count == 1:
            label = f"1 GPU (single node)"
        else:
            label = f"{count} GPUs (single node)"
        choices.append(questionary.Choice(title=label, value=count))
    
    # Add separator and multinode options
    if multinode_counts:
        choices.append(questionary.Separator("--- Multinode (Distributed) ---"))
        for count in multinode_counts:
            nodes = count // max_gpus
            label = f"{count} GPUs ({nodes} nodes × {max_gpus} GPUs)"
            choices.append(questionary.Choice(title=label, value=count))

    try:
        answer = questionary.select(
            f"How many {gpu_type.upper()} GPUs?", choices=choices, style=custom_style
        ).ask()

        return answer
    except (KeyboardInterrupt, EOFError):
        console.print("\n[yellow]Selection cancelled.[/yellow]")
        return None


def select_duration_interactive() -> Optional[float]:
    """Interactive duration selection"""
    if not check_interactive_support():
        return None

    # Common duration choices - cleaner labels
    choices = [
        questionary.Choice("15 minutes", 0.25),
        questionary.Choice("30 minutes", 0.5),
        questionary.Choice("1 hour", 1.0),
        questionary.Choice("2 hours", 2.0),
        questionary.Choice("4 hours", 4.0),
        questionary.Choice("8 hours (default)", 8.0),
        questionary.Choice("12 hours", 12.0),
        questionary.Choice("24 hours (max)", 24.0),
        questionary.Choice("Custom duration", "custom"),
    ]

    try:
        answer = questionary.select(
            "How long do you need the reservation?", choices=choices, style=custom_style
        ).ask()

        if answer == "custom":
            # Ask for custom duration
            custom_duration = questionary.text(
                "Enter duration in hours (decimal allowed, max 24):",
                validate=lambda x: _validate_duration(x),
                style=custom_style,
            ).ask()

            if custom_duration:
                return float(custom_duration)
            else:
                return None

        return answer
    except (KeyboardInterrupt, EOFError):
        console.print("\n[yellow]Selection cancelled.[/yellow]")
        return None


def select_jupyter_interactive() -> Optional[bool]:
    """Interactive Jupyter Lab selection"""
    if not check_interactive_support():
        return None

    try:
        answer = questionary.confirm(
            "Enable Jupyter Lab? (can be enabled later)",
            default=False,
            style=custom_style,
        ).ask()

        return answer
    except (KeyboardInterrupt, EOFError):
        console.print("\n[yellow]Selection cancelled.[/yellow]")
        return None


def select_reservation_interactive(
    reservations: List[Dict[str, Any]], action: str
) -> Optional[str]:
    """Interactive reservation selection for cancel/edit operations"""
    if not check_interactive_support():
        return None

    if not reservations:
        console.print(f"[yellow]No reservations available to {action}.[/yellow]")
        return None

    # Display reservations table
    console.print(f"\n[cyan]📋 Your reservations (available to {action}):[/cyan]")

    table = Table()
    table.add_column("ID", style="cyan", no_wrap=True)
    table.add_column("GPUs", style="magenta")
    table.add_column("Status", style="yellow")
    table.add_column("Created", style="blue")
    table.add_column("Expires/ETA", style="red")

    choices = []

    for reservation in reservations:
        try:
            reservation_id = reservation.get("reservation_id", "unknown")
            gpu_count = reservation.get("gpu_count", 1)
            gpu_type = reservation.get("gpu_type", "unknown")
            status = reservation.get("status", "unknown")
            created_at = reservation.get("created_at", "N/A")

            # Format GPU information
            if gpu_type and gpu_type not in ["unknown", "Unknown"]:
                gpu_display = f"{gpu_count}x {gpu_type.upper()}"
            else:
                gpu_display = str(gpu_count)

            # Format expiration time or ETA
            expires_at = reservation.get("expires_at", "N/A")
            if status == "active" and expires_at != "N/A":
                from datetime import datetime

                try:
                    if isinstance(expires_at, str):
                        if expires_at.endswith("Z"):
                            expires_dt_utc = datetime.fromisoformat(
                                expires_at.replace("Z", "+00:00")
                            )
                        elif "+" in expires_at or expires_at.endswith("00:00"):
                            expires_dt_utc = datetime.fromisoformat(expires_at)
                        else:
                            from datetime import timezone

                            naive_dt = datetime.fromisoformat(expires_at)
                            expires_dt_utc = naive_dt.replace(tzinfo=timezone.utc)

                        expires_dt = expires_dt_utc.astimezone()
                        expires_formatted = expires_dt.strftime("%m-%d %H:%M")
                    else:
                        expires_dt = datetime.fromtimestamp(expires_at)
                        expires_formatted = expires_dt.strftime("%m-%d %H:%M")
                except (ValueError, TypeError):
                    expires_formatted = "Invalid"
            elif status in ["queued", "pending"]:
                estimated_wait = reservation.get("estimated_wait_minutes", "?")
                if estimated_wait != "?" and estimated_wait is not None:
                    expires_formatted = f"~{estimated_wait}min"
                else:
                    expires_formatted = "Calculating..."
            else:
                expires_formatted = "N/A"

            # Format created_at datetime
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
                    if len(str(created_at)) > 10:
                        created_formatted = str(created_at)[:10]
                    else:
                        created_formatted = str(created_at)

            table.add_row(
                str(reservation_id)[:8],
                gpu_display,
                str(status),
                created_formatted,
                expires_formatted,
            )

            # Create choice for interactive selection
            choice_label = f"{reservation_id[:8]} - {gpu_display} ({status})"
            choices.append(questionary.Choice(title=choice_label, value=reservation_id))

        except Exception as row_error:
            console.print(
                f"[yellow]⚠️  Skipping malformed reservation: {str(row_error)}[/yellow]"
            )
            continue

    console.print(table)
    console.print()

    if not choices:
        console.print(f"[yellow]No valid reservations found to {action}.[/yellow]")
        return None

    # Add "all" option for cancel action when there are multiple reservations
    if action == "cancel" and len(choices) > 1:
        choices.append(
            questionary.Choice(
                title="🗑️  Cancel ALL reservations above", value="__ALL__"
            )
        )

    try:
        answer = questionary.select(
            f"Select reservation to {action}:", choices=choices, style=custom_style
        ).ask()

        return answer
    except (KeyboardInterrupt, EOFError):
        console.print("\n[yellow]Selection cancelled.[/yellow]")
        return None


def _validate_duration(duration_str: str) -> bool:
    """Validate duration input"""
    try:
        duration = float(duration_str)
        if duration < 0.0833:  # Less than 5 minutes
            return "Minimum duration is 5 minutes (0.0833 hours)"
        if duration > 24:
            return "Maximum duration is 24 hours"
        return True
    except ValueError:
        return "Please enter a valid number"


def ask_name_interactive() -> Optional[str]:
    """Ask for optional reservation name"""
    if not check_interactive_support():
        return None

    try:
        answer = questionary.text(
            "Reservation name (optional, press Enter to skip):", style=custom_style
        ).ask()

        # Return None if empty string
        return answer.strip() if answer and answer.strip() else None
    except (KeyboardInterrupt, EOFError):
        console.print("\n[yellow]Selection cancelled.[/yellow]")
        return None


def select_edit_action_interactive() -> Optional[str]:
    """Interactive edit action selection"""
    if not check_interactive_support():
        return None

    choices = [
        questionary.Choice("Enable Jupyter Lab", "enable_jupyter"),
        questionary.Choice("Disable Jupyter Lab", "disable_jupyter"),
        questionary.Choice("Add secondary user", "add_user"),
        questionary.Choice("Extend reservation duration", "extend"),
    ]

    try:
        answer = questionary.select(
            "What would you like to edit?", choices=choices, style=custom_style
        ).ask()

        return answer
    except (KeyboardInterrupt, EOFError):
        console.print("\n[yellow]Selection cancelled.[/yellow]")
        return None


def ask_github_username_interactive() -> Optional[str]:
    """Ask for GitHub username to add"""
    if not check_interactive_support():
        return None

    try:
        answer = questionary.text(
            "Enter GitHub username to add:",
            validate=lambda x: _validate_github_username(x),
            style=custom_style,
        ).ask()

        return answer.strip() if answer else None
    except (KeyboardInterrupt, EOFError):
        console.print("\n[yellow]Selection cancelled.[/yellow]")
        return None


def ask_extension_hours_interactive() -> Optional[float]:
    """Ask for extension hours"""
    if not check_interactive_support():
        return None

    try:
        # Offer common extension choices
        choices = [
            questionary.Choice("1 hour", 1.0),
            questionary.Choice("2 hours", 2.0),
            questionary.Choice("4 hours", 4.0),
            questionary.Choice("8 hours", 8.0),
            questionary.Choice("12 hours", 12.0),
            questionary.Choice("24 hours (max)", 24.0),
            questionary.Choice("Custom extension", "custom"),
        ]

        answer = questionary.select(
            "How many hours to extend?", choices=choices, style=custom_style
        ).ask()

        if answer == "custom":
            # Ask for custom extension
            custom_extension = questionary.text(
                "Enter extension hours (decimal allowed, max 24):",
                validate=lambda x: _validate_extension(x),
                style=custom_style,
            ).ask()

            if custom_extension:
                return float(custom_extension)
            else:
                return None

        return answer
    except (KeyboardInterrupt, EOFError):
        console.print("\n[yellow]Selection cancelled.[/yellow]")
        return None


def _validate_github_username(username: str) -> bool:
    """Validate GitHub username format"""
    if not username or not username.strip():
        return "GitHub username cannot be empty"

    username = username.strip()
    if not username.replace("-", "").replace("_", "").replace(".", "").isalnum():
        return "Invalid GitHub username format"

    if len(username) > 39:  # GitHub's max username length
        return "GitHub username too long (max 39 characters)"

    return True


def _validate_extension(hours_str: str) -> bool:
    """Validate extension hours input"""
    try:
        hours = float(hours_str)
        if hours <= 0:
            return "Extension hours must be positive"
        if hours > 24:
            return "Maximum extension is 24 hours"
        return True
    except ValueError:
        return "Please enter a valid number"
