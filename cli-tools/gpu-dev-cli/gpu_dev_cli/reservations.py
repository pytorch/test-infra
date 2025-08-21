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


def _generate_vscode_command(ssh_command: str) -> Optional[str]:
    """Generate VS Code remote connection command from SSH command"""
    try:
        # Extract remote server from SSH command
        # Expected format: ssh dev@<hostname> -p <port> or ssh -p <port> dev@<hostname>
        if not ssh_command or not ssh_command.startswith("ssh "):
            return None

        # Parse SSH command to extract user@host and port
        parts = ssh_command.split()
        user_host = None
        port = None

        for i, part in enumerate(parts):
            if "@" in part and not part.startswith("-"):
                user_host = part
            elif part == "-p" and i + 1 < len(parts):
                port = parts[i + 1]

        if not user_host:
            return None

        # Build VS Code remote server string
        if port:
            remote_server = f"{user_host}:{port}"
        else:
            remote_server = user_host

        # Generate VS Code command
        return f"code --remote ssh-remote+{remote_server} /home/dev"

    except Exception:
        return None


class ReservationManager:
    """Minimal GPU reservations manager - AWS-only"""

    def __init__(self, config: Config):
        self.config = config
        self.reservations_table = config.dynamodb.Table(config.reservations_table)

    def create_reservation(
        self,
        user_id: str,
        gpu_count: int,
        gpu_type: str,
        duration_hours: Union[int, float],
        name: Optional[str] = None,
        github_user: Optional[str] = None,
        jupyter_enabled: bool = False,
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
                "gpu_type": gpu_type,
                "duration_hours": duration_decimal,
                "name": name or f"{gpu_count}x {gpu_type.upper()} reservation",
                "created_at": created_at,
                "status": "pending",
                "expires_at": (
                    datetime.utcnow() + timedelta(hours=duration_hours)
                ).isoformat(),
                "jupyter_enabled": jupyter_enabled,
            }

            # Add github_user if provided
            if github_user:
                initial_reservation["github_user"] = github_user

            # Send processing request to SQS queue (Lambda will create the initial record)
            # Use float for SQS message (JSON serializable)
            message = {
                "reservation_id": reservation_id,
                "user_id": user_id,
                "gpu_count": gpu_count,
                "gpu_type": gpu_type,
                "duration_hours": float(duration_hours),
                "name": name or f"{gpu_count}x {gpu_type.upper()} reservation",
                "created_at": created_at,
                "status": "pending",
                "jupyter_enabled": jupyter_enabled,
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
            console.print(
                f"[red]❌ Error submitting cancellation request: {str(e)}[/red]"
            )
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
                    ":user_id": user_id,
                },
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
                "jupyter_url": reservation.get("jupyter_url", ""),
                "jupyter_port": reservation.get("jupyter_port", ""),
                "jupyter_token": reservation.get("jupyter_token", ""),
                "jupyter_enabled": reservation.get("jupyter_enabled", False),
                "jupyter_error": reservation.get("jupyter_error", ""),
            }

        except Exception as e:
            console.print(f"[red]❌ Error getting connection info: {str(e)}[/red]")
            return None

    def enable_jupyter(self, reservation_id: str, user_id: str) -> bool:
        """Enable Jupyter Lab for an active reservation"""
        try:
            # Send message to Lambda to start Jupyter service in pod
            # Lambda will handle both the pod changes and DynamoDB updates
            message = {
                "action": "enable_jupyter",
                "reservation_id": reservation_id,
                "user_id": user_id,
            }

            queue_url = self.config.get_queue_url()
            self.config.sqs_client.send_message(
                QueueUrl=queue_url, MessageBody=json.dumps(message)
            )

            console.print(
                f"[yellow]⏳ Jupyter enable request submitted for reservation {reservation_id[:8]}...[/yellow]"
            )

            # Poll for 3 minutes to show the outcome
            return self._poll_jupyter_action_result(
                reservation_id, "enable", timeout_minutes=3
            )

        except Exception as e:
            console.print(
                f"[red]❌ Error submitting Jupyter enable request: {str(e)}[/red]"
            )
            return False

    def disable_jupyter(self, reservation_id: str, user_id: str) -> bool:
        """Disable Jupyter Lab for an active reservation"""
        try:
            # Send message to Lambda to stop Jupyter service in pod
            # Lambda will handle both the pod changes and DynamoDB updates
            message = {
                "action": "disable_jupyter",
                "reservation_id": reservation_id,
                "user_id": user_id,
            }

            queue_url = self.config.get_queue_url()
            self.config.sqs_client.send_message(
                QueueUrl=queue_url, MessageBody=json.dumps(message)
            )

            console.print(
                f"[yellow]⏳ Jupyter disable request submitted for reservation {reservation_id[:8]}...[/yellow]"
            )

            # Poll for 3 minutes to show the outcome
            return self._poll_jupyter_action_result(
                reservation_id, "disable", timeout_minutes=3
            )

        except Exception as e:
            console.print(
                f"[red]❌ Error submitting Jupyter disable request: {str(e)}[/red]"
            )
            return False

    def add_user(self, reservation_id: str, user_id: str, github_username: str) -> bool:
        """Add a secondary user to an active reservation"""
        try:
            # Validate GitHub username format (basic validation)
            if (
                not github_username
                or not github_username.replace("-", "").replace("_", "").isalnum()
            ):
                console.print(
                    f"[red]❌ Invalid GitHub username: {github_username}[/red]"
                )
                return False

            # Send message to Lambda to add user SSH keys to pod
            # Lambda will handle fetching GitHub keys and updating the pod
            message = {
                "action": "add_user",
                "reservation_id": reservation_id,
                "user_id": user_id,
                "github_username": github_username,
            }

            queue_url = self.config.get_queue_url()
            self.config.sqs_client.send_message(
                QueueUrl=queue_url, MessageBody=json.dumps(message)
            )

            console.print(
                f"[yellow]⏳ Adding user {github_username} to reservation {reservation_id[:8]}...[/yellow]"
            )

            # Poll for 3 minutes to show the outcome
            return self._poll_add_user_result(
                reservation_id, github_username, timeout_minutes=3
            )

        except Exception as e:
            console.print(
                f"[red]❌ Error adding user {github_username}: {str(e)}[/red]"
            )
            return False

    def get_gpu_availability_by_type(self) -> Optional[Dict[str, Dict[str, Any]]]:
        """Get GPU availability information by GPU type from real-time availability table"""
        try:
            # Try to get real-time availability from the availability table
            availability_table_name = self.config.availability_table
            availability_table = self.config.dynamodb.Table(availability_table_name)

            # Get supported GPU types
            supported_types = ["h200", "h100", "a100", "t4"]
            availability_info = {}

            for gpu_type in supported_types:
                # Get queue length for this GPU type
                queue_length = self._get_queue_length_for_gpu_type(gpu_type)

                # Estimate wait time based on queue length (15 min per position)
                estimated_wait = queue_length * 15 if queue_length > 0 else 0

                try:
                    # Query real-time availability table
                    response = availability_table.get_item(Key={"gpu_type": gpu_type})

                    if "Item" in response:
                        item = response["Item"]
                        availability_info[gpu_type] = {
                            "available": int(item.get("available_gpus", 0)),
                            "total": int(item.get("total_gpus", 0)),
                            "queue_length": queue_length,
                            "estimated_wait_minutes": estimated_wait,
                            "running_instances": int(item.get("running_instances", 0)),
                            "desired_capacity": int(item.get("desired_capacity", 0)),
                            "last_updated": item.get("last_updated_timestamp", 0),
                        }
                    else:
                        # Fallback to static configuration if no real-time data
                        availability_info[gpu_type] = self._get_static_gpu_config(
                            gpu_type, queue_length, estimated_wait
                        )

                except Exception as table_error:
                    console.print(
                        f"[dim]Warning: Could not get real-time data for {gpu_type}: {table_error}[/dim]"
                    )
                    # Fallback to static configuration
                    availability_info[gpu_type] = self._get_static_gpu_config(
                        gpu_type, queue_length, estimated_wait
                    )

            return availability_info

        except Exception as e:
            console.print(f"[red]❌ Error getting GPU availability: {str(e)}[/red]")
            return None

    def _get_static_gpu_config(
        self, gpu_type: str, queue_length: int, estimated_wait: int
    ) -> Dict[str, Any]:
        """Get static GPU configuration as fallback when real-time data unavailable"""
        static_configs = {
            "a100": {"available": 0, "total": 16},  # 2x p4d.24xlarge = 16 A100s
            "h200": {"available": 0, "total": 16},  # 2x p5e.48xlarge = 16 H200s
            "h100": {"available": 0, "total": 16},  # 2x p5.48xlarge = 16 H100s
            "t4": {"available": 0, "total": 8},  # 2x g4dn.12xlarge = 8 T4s
        }

        config = static_configs.get(gpu_type, {"available": 0, "total": 0})
        return {
            "available": config["available"],
            "total": config["total"],
            "queue_length": queue_length,
            "estimated_wait_minutes": estimated_wait,
            "running_instances": 0,
            "desired_capacity": 0,
            "last_updated": 0,
        }

    def _get_queue_length_for_gpu_type(self, gpu_type: str) -> int:
        """Get the number of queued reservations for a specific GPU type"""
        try:
            total_count = 0

            # Count queued reservations for this GPU type
            for status in ["queued", "pending"]:
                try:
                    response = self.reservations_table.query(
                        IndexName="StatusGpuTypeIndex",
                        KeyConditionExpression="#status = :status AND gpu_type = :gpu_type",
                        ExpressionAttributeNames={"#status": "status"},
                        ExpressionAttributeValues={
                            ":status": status,
                            ":gpu_type": gpu_type,
                        },
                    )
                    total_count += len(response.get("Items", []))
                except Exception as query_error:
                    # Fallback to scanning if the composite index doesn't exist yet
                    console.print(
                        f"[dim]Fallback: scanning for {status} {gpu_type} reservations[/dim]"
                    )
                    response = self.reservations_table.scan(
                        FilterExpression="contains(#status, :status) AND contains(gpu_type, :gpu_type)",
                        ExpressionAttributeNames={"#status": "status"},
                        ExpressionAttributeValues={
                            ":status": status,
                            ":gpu_type": gpu_type,
                        },
                    )
                    total_count += len(response.get("Items", []))

            return total_count

        except Exception as e:
            console.print(
                f"[red]❌ Error getting queue length for {gpu_type}: {str(e)}[/red]"
            )
            return 0

    def _poll_jupyter_action_result(
        self, reservation_id: str, action: str, timeout_minutes: int = 3
    ) -> bool:
        """Poll reservation table for Jupyter action result"""
        try:
            start_time = time.time()
            timeout_seconds = timeout_minutes * 60

            with Live(console=console, refresh_per_second=2) as live:
                spinner = Spinner(
                    "dots", text=f"🔄 Processing Jupyter {action} request..."
                )
                live.update(spinner)

                initial_state = None

                while time.time() - start_time < timeout_seconds:
                    try:
                        # Get current reservation state - support partial reservation IDs
                        scan_response = self.reservations_table.scan(
                            FilterExpression="begins_with(reservation_id, :prefix)",
                            ExpressionAttributeValues={":prefix": reservation_id},
                        )

                        items = scan_response.get("Items", [])
                        if len(items) == 0:
                            spinner.text = f"🔄 Waiting for reservation data..."
                            live.update(spinner)
                            time.sleep(2)
                            continue
                        elif len(items) > 1:
                            spinner.text = f"🔄 Multiple reservations found for {reservation_id}, using first match..."
                            live.update(spinner)

                        reservation = items[0]

                        # Capture initial state on first iteration
                        if initial_state is None:
                            initial_state = {
                                "jupyter_enabled": reservation.get(
                                    "jupyter_enabled", False
                                ),
                                "jupyter_url": reservation.get("jupyter_url", ""),
                                "jupyter_port": reservation.get("jupyter_port", 0),
                            }

                        current_jupyter_enabled = reservation.get(
                            "jupyter_enabled", False
                        )
                        jupyter_url = reservation.get("jupyter_url", "")
                        jupyter_port = reservation.get("jupyter_port", 0)

                        # Check if the action has completed
                        if action == "enable":
                            if current_jupyter_enabled and jupyter_url:
                                live.stop()
                                console.print(
                                    f"[green]✅ Jupyter Lab enabled successfully![/green]"
                                )
                                console.print(
                                    f"[cyan]🔗 Jupyter URL:[/cyan] {jupyter_url}"
                                )
                                console.print(f"[cyan]🔌 Port:[/cyan] {jupyter_port}")
                                return True
                            elif (
                                current_jupyter_enabled
                                != initial_state["jupyter_enabled"]
                            ):
                                spinner.text = f"🔄 Jupyter enabled, waiting for URL..."
                        else:  # disable
                            if not current_jupyter_enabled and not jupyter_url:
                                live.stop()
                                console.print(
                                    f"[green]✅ Jupyter Lab disabled successfully![/green]"
                                )
                                return True
                            elif (
                                current_jupyter_enabled
                                != initial_state["jupyter_enabled"]
                            ):
                                spinner.text = f"🔄 Stopping Jupyter service..."

                        live.update(spinner)
                        time.sleep(3)

                    except Exception as poll_error:
                        console.print(
                            f"[red]❌ Error polling Jupyter status: {poll_error}[/red]"
                        )
                        return False

                # Timeout reached
                live.stop()
                console.print(
                    f"[yellow]⏰ Timeout after {timeout_minutes} minutes[/yellow]"
                )
                console.print(
                    f"[yellow]💡 Use 'gpu-dev show {reservation_id[:8]}' to check Jupyter status[/yellow]"
                )
                return False

        except Exception as e:
            console.print(
                f"[red]❌ Error during Jupyter {action} polling: {str(e)}[/red]"
            )
            return False

    def _poll_add_user_result(
        self, reservation_id: str, github_username: str, timeout_minutes: int = 3
    ) -> bool:
        """Poll reservation table for add user action result"""
        try:
            start_time = time.time()
            timeout_seconds = timeout_minutes * 60

            with Live(console=console, refresh_per_second=2) as live:
                spinner = Spinner("dots", text=f"🔄 Adding user {github_username}...")
                live.update(spinner)

                initial_secondary_users = None

                while time.time() - start_time < timeout_seconds:
                    try:
                        # Get current reservation state - support partial reservation IDs
                        scan_response = self.reservations_table.scan(
                            FilterExpression="begins_with(reservation_id, :prefix)",
                            ExpressionAttributeValues={":prefix": reservation_id},
                        )

                        items = scan_response.get("Items", [])
                        if len(items) == 0:
                            spinner.text = f"🔄 Waiting for reservation data..."
                            live.update(spinner)
                            time.sleep(2)
                            continue
                        elif len(items) > 1:
                            spinner.text = f"🔄 Multiple reservations found for {reservation_id}, using first match..."
                            live.update(spinner)

                        reservation = items[0]

                        # Capture initial state on first iteration
                        if initial_secondary_users is None:
                            initial_secondary_users = reservation.get(
                                "secondary_users", []
                            )

                        current_secondary_users = reservation.get("secondary_users", [])

                        # Check if the user has been added
                        if github_username in current_secondary_users:
                            live.stop()
                            console.print(
                                f"[green]✅ User {github_username} added successfully![/green]"
                            )
                            console.print(
                                f"[cyan]👥 Secondary users:[/cyan] {', '.join(current_secondary_users)}"
                            )
                            return True
                        elif len(current_secondary_users) != len(
                            initial_secondary_users
                        ):
                            spinner.text = (
                                f"🔄 User list updated, verifying {github_username}..."
                            )

                        live.update(spinner)
                        time.sleep(3)

                    except Exception as poll_error:
                        console.print(
                            f"[red]❌ Error polling add user status: {poll_error}[/red]"
                        )
                        return False

                # Timeout reached
                live.stop()
                console.print(
                    f"[yellow]⏰ Timeout after {timeout_minutes} minutes[/yellow]"
                )
                console.print(
                    f"[yellow]💡 Use 'gpu-dev show {reservation_id[:8]}' to check user status[/yellow]"
                )
                return False

        except Exception as e:
            console.print(f"[red]❌ Error during add user polling: {str(e)}[/red]")
            return False

    def get_cluster_status(self) -> Optional[Dict[str, Any]]:
        """Get overall GPU cluster status from availability table"""
        try:
            # Get reservations
            reservations_response = self.reservations_table.scan()
            reservations = reservations_response.get("Items", [])

            # Get total GPUs from availability table
            availability_info = self.get_gpu_availability_by_type()
            total_gpus = 0
            available_gpus = 0

            if availability_info:
                for gpu_type, info in availability_info.items():
                    total_gpus += info.get("total", 0)
                    available_gpus += info.get("available", 0)

            # Calculate stats
            active_reservations = [
                r for r in reservations if r.get("status") == "active"
            ]
            reserved_gpus = sum(int(r.get("gpu_count", 0)) for r in active_reservations)

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
                "available_gpus": available_gpus,
                "reserved_gpus": reserved_gpus,
                "active_reservations": len(active_reservations),
                "queue_length": queue_length,
            }

        except Exception as e:
            console.print(f"[red]❌ Error getting cluster status: {str(e)}[/red]")
            return None

    def wait_for_reservation_completion(
        self, reservation_id: str, timeout_minutes: Optional[int] = 10
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
        timeout_seconds = timeout_minutes * 60 if timeout_minutes is not None else None
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
                    (
                        timeout_seconds is None
                        or time.time() - start_time < timeout_seconds
                    )
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
                                message = status_messages.get(
                                    current_status, f"Status: {current_status}"
                                )
                        else:
                            message = status_messages.get(
                                current_status, f"Status: {current_status}"
                            )

                        # Update spinner if status changed or we're in queue/preparing (to show updated info)
                        if current_status != last_status or current_status in [
                            "queued",
                            "preparing",
                        ]:
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

                            # Show VS Code remote command
                            vscode_command = _generate_vscode_command(ssh_command)
                            if vscode_command:
                                console.print(
                                    f"[cyan]💻 VS Code Remote:[/cyan] {vscode_command}"
                                )

                            # Show Jupyter link if enabled
                            jupyter_enabled = reservation.get("jupyter_enabled", False)
                            jupyter_url = reservation.get("jupyter_url", "")
                            if jupyter_enabled and jupyter_url:
                                console.print(
                                    f"[cyan]📊 Jupyter Lab:[/cyan] {jupyter_url}"
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

                                    console.print(
                                        "\n[red]🔍 Pod logs (last 20 lines) - Details:[/red]"
                                    )

                                    # Create logs panel that's always visible but styled nicely
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

            # Timeout reached (should not happen when timeout_minutes is None)
            live.stop()
            if timeout_minutes is not None:
                console.print(
                    f"\n[yellow]⏰ Timeout reached after {timeout_minutes} minutes[/yellow]"
                )
            else:
                console.print(f"\n[yellow]⏰ Polling stopped unexpectedly[/yellow]")
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
