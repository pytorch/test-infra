"""Minimal reservation management for GPU Dev CLI"""

import json
import os
import select
import signal
import sys
import time
import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Optional, List, Dict, Any, Union

from botocore.exceptions import ClientError
from rich.console import Console
from rich.live import Live
from rich.spinner import Spinner

from .config import Config

console = Console()


class ReservationManager:
    """Minimal GPU reservations manager - AWS-only"""

    def __init__(self, config: Config):
        self.config = config
        self.reservations_table = config.dynamodb.Table(config.reservations_table)
        self.servers_table = config.dynamodb.Table(config.servers_table)

    def create_reservation(
        self,
        user_id: str,
        gpu_count: int,
        duration_hours: Union[int, float],
        name: Optional[str] = None,
        github_user: Optional[str] = None,
    ) -> Optional[str]:
        """Create a new GPU reservation"""
        try:
            reservation_id = str(uuid.uuid4())
            created_at = datetime.utcnow().isoformat()

            # Create initial reservation record for polling
            # Convert float to Decimal for DynamoDB compatibility
            duration_decimal = Decimal(str(duration_hours))

            initial_reservation = {
                "reservation_id": reservation_id,
                "user_id": user_id,
                "gpu_count": gpu_count,
                "duration_hours": duration_decimal,
                "name": name or f"{gpu_count}-GPU reservation",
                "created_at": created_at,
                "status": "pending",
                "expires_at": (datetime.utcnow() + timedelta(hours=duration_hours)).isoformat(),
            }

            # Add github_user if provided
            if github_user:
                initial_reservation["github_user"] = github_user

            # Store in DynamoDB for immediate polling
            self.reservations_table.put_item(Item=initial_reservation)

            # Send processing request to SQS queue
            # Use float for SQS message (JSON serializable)
            message = {
                "reservation_id": reservation_id,
                "user_id": user_id,
                "gpu_count": gpu_count,
                "duration_hours": float(duration_hours),
                "name": name or f"{gpu_count}-GPU reservation",
                "created_at": created_at,
                "status": "pending",
            }

            # Add github_user if provided
            if github_user:
                message["github_user"] = github_user

            queue_url = self.config.get_queue_url()
            self.config.sqs_client.send_message(
                QueueUrl=queue_url, MessageBody=json.dumps(message)
            )

            return reservation_id

        except Exception as e:
            console.print(f"[red]❌ Error creating reservation: {str(e)}[/red]")
            return None

    def list_reservations(
        self,
        user_filter: Optional[str] = None,
        statuses_to_include: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """List GPU reservations with flexible filtering"""
        try:
            all_reservations = []

            if user_filter:
                # Query by specific user
                response = self.reservations_table.query(
                    IndexName="UserIndex",
                    KeyConditionExpression="user_id = :user_id",
                    ExpressionAttributeValues={":user_id": user_filter},
                )
                all_reservations = response.get("Items", [])
            else:
                # Get all reservations (scan with higher limit for admin use)
                response = self.reservations_table.scan(Limit=200)
                all_reservations = response.get("Items", [])

            # Filter by status if specified
            if statuses_to_include:
                filtered_reservations = [
                    reservation
                    for reservation in all_reservations
                    if reservation.get("status") in statuses_to_include
                ]
                return filtered_reservations

            return all_reservations

        except Exception as e:
            console.print(f"[red]❌ Error listing reservations: {str(e)}[/red]")
            return []

    def cancel_reservation(self, reservation_id: str, user_id: str) -> bool:
        """Cancel a GPU reservation by sending cancellation message to queue"""
        try:
            # Send cancellation request to SQS queue for processing
            message = {
                "type": "cancellation",
                "reservation_id": reservation_id,
                "user_id": user_id,
                "requested_at": datetime.utcnow().isoformat(),
            }

            queue_url = self.config.get_queue_url()
            self.config.sqs_client.send_message(
                QueueUrl=queue_url, MessageBody=json.dumps(message)
            )

            console.print(
                f"[yellow]⏳ Cancellation request submitted for reservation {reservation_id[:8]}...[/yellow]"
            )
            console.print(
                "[yellow]💡 The reservation will be cancelled shortly. Use 'gpu-dev list' to check status.[/yellow]"
            )
            return True

        except Exception as e:
            console.print(f"[red]❌ Error submitting cancellation request: {str(e)}[/red]")
            return False

    def get_connection_info(
        self, reservation_id: str, user_id: str
    ) -> Optional[Dict[str, Any]]:
        """Get SSH connection information for a reservation"""
        try:
            # Search by prefix - allows short reservation IDs
            scan_response = self.reservations_table.scan(
                FilterExpression="begins_with(reservation_id, :prefix) AND user_id = :user_id",
                ExpressionAttributeValues={
                    ":prefix": reservation_id,
                    ":user_id": user_id
                }
            )

            items = scan_response.get("Items", [])
            if len(items) == 0:
                return None
            elif len(items) > 1:
                return None  # Ambiguous - need longer prefix

            reservation = items[0]

            return {
                "ssh_command": reservation.get("ssh_command", "ssh user@pending"),
                "pod_name": reservation.get("pod_name", "pending"),
                "namespace": reservation.get("namespace", "default"),
                "gpu_count": reservation["gpu_count"],
                "status": reservation["status"],
                "launched_at": reservation.get("launched_at"),
                "expires_at": reservation.get("expires_at"),
                "created_at": reservation.get("created_at"),
                "reservation_id": reservation["reservation_id"],
                "instance_type": reservation.get("instance_type", "unknown"),
                "gpu_type": reservation.get("gpu_type", "unknown"),
                "failure_reason": reservation.get("failure_reason", ""),
                "pod_logs": reservation.get("pod_logs", ""),
            }

        except Exception as e:
            console.print(f"[red]❌ Error getting connection info: {str(e)}[/red]")
            return None

    def get_cluster_status(self) -> Optional[Dict[str, Any]]:
        """Get overall GPU cluster status"""
        try:
            # Get reservations
            reservations_response = self.reservations_table.scan()
            reservations = reservations_response.get("Items", [])

            # Get servers
            servers_response = self.servers_table.scan()
            servers = servers_response.get("Items", [])

            # Calculate stats
            active_reservations = [
                r for r in reservations if r.get("status") == "active"
            ]
            reserved_gpus = sum(int(r.get("gpu_count", 0)) for r in active_reservations)
            total_gpus = sum(int(s.get("gpu_count", 0)) for s in servers)

            # Get queue length
            try:
                queue_url = self.config.get_queue_url()
                queue_attrs = self.config.sqs_client.get_queue_attributes(
                    QueueUrl=queue_url, AttributeNames=["ApproximateNumberOfMessages"]
                )
                queue_length = int(
                    queue_attrs["Attributes"]["ApproximateNumberOfMessages"]
                )
            except:
                queue_length = len(
                    [r for r in reservations if r.get("status") == "pending"]
                )

            return {
                "total_gpus": total_gpus,
                "available_gpus": max(0, total_gpus - reserved_gpus),
                "reserved_gpus": reserved_gpus,
                "active_reservations": len(active_reservations),
                "queue_length": queue_length,
            }

        except Exception as e:
            console.print(f"[red]❌ Error getting cluster status: {str(e)}[/red]")
            return None

    def wait_for_reservation_completion(
        self, reservation_id: str, timeout_minutes: int = 10
    ) -> Optional[Dict[str, Any]]:
        """Poll for reservation completion with status updates, queue info, and keyboard controls"""

        status_messages = {
            "pending": "⏳ Reservation request submitted, waiting for processing...",
            "queued": "📋 In queue - waiting for GPU resources...",
            "preparing": "🚀 GPUs found! Preparing your development environment...",
            "active": "✅ Reservation complete!",
            "failed": "❌ Reservation failed",
            "cancelled": "🛑 Reservation cancelled",
        }

        start_time = time.time()
        timeout_seconds = timeout_minutes * 60
        last_status = None
        cancelled = False
        close_tool = False
        show_queue_help = True
        queue_state = {"initial_estimated_wait": None, "queue_start_time": None}

        def handle_interrupt(signum, frame):
            """Handle Ctrl+C to cancel reservation"""
            nonlocal cancelled
            cancelled = True

        # Use SIGTERM for clean exit (can be sent with kill command or Ctrl+\)
        clean_exit_requested = False

        def handle_clean_exit(signum, frame):
            """Handle clean exit signal (SIGTERM)"""
            nonlocal clean_exit_requested
            clean_exit_requested = True
            console.print(
                "\n[cyan]🔄 Clean exit requested - keeping reservation active...[/cyan]"
            )

        def check_keyboard_input():
            """Check if clean exit was requested via signal"""
            return clean_exit_requested

        # Set up signal handlers
        # SIGTERM for clean exit (kill <pid> or Ctrl+\ in some terminals)
        signal.signal(signal.SIGTERM, handle_clean_exit)
        # Try to catch Ctrl+\ (SIGQUIT) for clean exit too
        try:
            signal.signal(signal.SIGQUIT, handle_clean_exit)
            console.print(
                "[dim]💡 Press [cyan]Ctrl+C[/cyan] to cancel reservation • Press [cyan]Ctrl+backslash[/cyan] to exit but keep reservation[/dim]"
            )
        except (AttributeError, OSError):
            console.print(
                "[dim]💡 Press [cyan]Ctrl+C[/cyan] to cancel reservation • Send [cyan]SIGTERM[/cyan] to exit but keep reservation[/dim]"
            )
            console.print(
                f"[dim]   (From another terminal: [cyan]kill {os.getpid()}[/cyan])[/dim]"
            )

        # Set up signal handler for Ctrl+C
        old_handler = signal.signal(signal.SIGINT, handle_interrupt)

        try:
            with Live(console=console, refresh_per_second=4) as live:
                spinner = Spinner("dots", text="🔄 Sending reservation request...")
                live.update(spinner)

                while (
                    time.time() - start_time < timeout_seconds
                    and not cancelled
                    and not close_tool
                ):
                    try:
                        # Check for keyboard input (q to exit cleanly)
                        if check_keyboard_input():
                            close_tool = True
                            break

                        # Get current reservation status
                        response = self.reservations_table.get_item(
                            Key={"reservation_id": reservation_id}
                        )

                        if "Item" not in response:
                            # No reservation found yet, keep waiting
                            spinner.text = "📡 Waiting for reservation status update..."
                            live.update(spinner)
                            time.sleep(2)
                            continue

                        reservation = response["Item"]
                        current_status = reservation.get("status", "pending")

                        # Build status message with queue info for queued reservations
                        if current_status == "queued":
                            # Try to get queue information from reservation or estimate
                            gpu_count = reservation.get("gpu_count", 1)

                            # Get queue position and wait time (from reservation or estimate)
                            queue_position = reservation.get("queue_position", "?")
                            estimated_wait = reservation.get(
                                "estimated_wait_minutes", "?"
                            )

                            # Initialize countdown on first time seeing queue status OR if we have new wait time
                            if (
                                current_status != last_status and estimated_wait != "?"
                            ) or (
                                estimated_wait != "?"
                                and queue_state["initial_estimated_wait"] is None
                            ):
                                try:
                                    wait_minutes = (
                                        int(estimated_wait)
                                        if isinstance(estimated_wait, (int, str))
                                        and str(estimated_wait).isdigit()
                                        else None
                                    )
                                    if wait_minutes is not None:
                                        queue_state["initial_estimated_wait"] = (
                                            wait_minutes
                                        )
                                        queue_state["queue_start_time"] = time.time()
                                except (ValueError, TypeError):
                                    pass

                            # Calculate dynamic countdown
                            if (
                                queue_state["initial_estimated_wait"] is not None
                                and queue_state["queue_start_time"] is not None
                            ):
                                elapsed_minutes = (
                                    time.time() - queue_state["queue_start_time"]
                                ) / 60
                                remaining_wait = max(
                                    0,
                                    queue_state["initial_estimated_wait"]
                                    - elapsed_minutes,
                                )
                                wait_display = (
                                    f"{remaining_wait:.0f} min"
                                    if remaining_wait > 0
                                    else "Soon"
                                )
                            else:
                                wait_display = (
                                    f"{estimated_wait} min"
                                    if estimated_wait != "?"
                                    else "Calculating..."
                                )

                            message = f"📋 You are #{queue_position} in queue • Estimated wait: {wait_display} • {gpu_count} GPU(s) requested"

                            # Show help message once when entering queue
                            if show_queue_help and current_status != last_status:
                                help_text = "\n[dim]💡 Press [cyan]Ctrl+C[/cyan] to cancel reservation • Use [cyan]gpu-dev list[/cyan] to check status[/dim]"
                                console.print(help_text)
                                show_queue_help = False

                        elif current_status == "preparing":
                            # Show dynamic pod events from failure_reason field
                            failure_reason = reservation.get("failure_reason", "")
                            if failure_reason:
                                message = f"🚀 Preparing: {failure_reason}"
                            else:
                                message = status_messages.get(current_status, f"Status: {current_status}")
                        else:
                            message = status_messages.get(
                                current_status, f"Status: {current_status}"
                            )

                        # Update spinner if status changed or we're in queue/preparing (to show updated info)
                        if current_status != last_status or current_status in ["queued", "preparing"]:
                            spinner.text = message
                            last_status = current_status
                            live.update(spinner)

                        # Check for completion states
                        if current_status == "active":
                            live.stop()

                            # Get connection info
                            ssh_command = reservation.get(
                                "ssh_command", "ssh user@pending"
                            )
                            duration_hours = reservation.get("duration_hours", 8)

                            console.print(f"\n[green]✅ Reservation complete![/green]")
                            console.print(
                                f"[cyan]📋 Reservation ID:[/cyan] {reservation_id}"
                            )
                            console.print(
                                f"[cyan]⏰ Valid for:[/cyan] {duration_hours} hours"
                            )
                            console.print(
                                f"[cyan]🖥️  Connect with:[/cyan] {ssh_command}"
                            )

                            return reservation

                        elif current_status in ["failed", "cancelled"]:
                            live.stop()
                            failure_reason = reservation.get(
                                "failure_reason", "Unknown error"
                            )

                            if current_status == "failed":
                                console.print(
                                    f"\n[red]❌ Reservation failed: {failure_reason}[/red]"
                                )
                                console.print(
                                    f"[red]📋 Reservation ID: {reservation_id}[/red]"
                                )
                                
                                # Show pod logs if available
                                pod_logs = reservation.get("pod_logs", "")
                                if pod_logs and pod_logs.strip():
                                    from rich.panel import Panel
                                    from rich.text import Text
                                    
                                    console.print("\n[red]🔍 Pod logs (last 20 lines) - Details:[/red]")
                                    
                                    # Create logs panel that's always visible but styled nicely
                                    log_text = Text(pod_logs)
                                    log_panel = Panel(
                                        log_text,
                                        title="🐚 Container Startup Logs",
                                        title_align="left",
                                        border_style="red",
                                        expand=False
                                    )
                                    console.print(log_panel)
                            else:
                                console.print(
                                    f"\n[yellow]🛑 Reservation was cancelled[/yellow]"
                                )

                            return None

                        # Continue polling
                        time.sleep(3)

                    except Exception as e:
                        console.print(
                            f"\n[red]❌ Error polling reservation status: {str(e)}[/red]"
                        )
                        return None

            # Handle cancellation
            if cancelled:
                live.stop()
                console.print("\n[yellow]⚠️  Cancelling reservation request...[/yellow]")

                # Get user_id for cancellation
                try:
                    response = self.reservations_table.get_item(
                        Key={"reservation_id": reservation_id}
                    )
                    if "Item" in response:
                        user_id = response["Item"].get("user_id", "unknown")
                        if self.cancel_reservation(reservation_id, user_id):
                            console.print(
                                "[green]✅ Reservation cancelled successfully[/green]"
                            )
                        else:
                            console.print("[red]❌ Failed to cancel reservation[/red]")
                except Exception as e:
                    console.print(
                        f"[red]❌ Error cancelling reservation: {str(e)}[/red]"
                    )

                return None

            # Handle clean exit (q key)
            if close_tool:
                live.stop()
                console.print(
                    f"\n[cyan]📱 Exiting - reservation {reservation_id[:8]} continues in background...[/cyan]"
                )
                console.print("[cyan]💡 Use 'gpu-dev list' to check status[/cyan]")
                console.print(
                    "[cyan]💡 Use 'gpu-dev show {id}' to get connection details when ready[/cyan]".format(
                        id=reservation_id[:8]
                    )
                )
                return None

            # Timeout reached
            live.stop()
            console.print(
                f"\n[yellow]⏰ Timeout reached after {timeout_minutes} minutes[/yellow]"
            )
            console.print(
                "[yellow]🔍 Check reservation status manually with: gpu-dev list[/yellow]"
            )
            return None

        finally:
            # Restore original signal handlers
            signal.signal(signal.SIGINT, old_handler)
            try:
                signal.signal(signal.SIGTERM, signal.SIG_DFL)
                signal.signal(signal.SIGQUIT, signal.SIG_DFL)
            except (AttributeError, OSError):
                pass
