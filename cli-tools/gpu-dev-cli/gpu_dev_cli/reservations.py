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


def _add_agent_forwarding_to_ssh(ssh_command: str) -> str:
    """Add SSH agent forwarding (-A) flag to SSH command if not already present"""
    try:
        if not ssh_command or not ssh_command.startswith("ssh "):
            return ssh_command

        # Check if -A is already in the command
        if " -A" in ssh_command or ssh_command.endswith(" -A"):
            return ssh_command

        # Add -A flag after 'ssh'
        parts = ssh_command.split(" ", 1)
        if len(parts) == 2:
            return f"ssh -A {parts[1]}"
        else:
            return "ssh -A"

    except Exception:
        return ssh_command


def _extract_latest_pod_event(pod_events: str) -> str:
    """Extract the most relevant pod event for display - simplified since Lambda now provides formatted messages"""
    if not pod_events:
        return "Starting pod..."

    # Lambda now provides pre-formatted messages, so just return them
    # Handle multi-line messages by taking the first meaningful line
    lines = pod_events.split("\n")
    for line in lines:
        line = line.strip()
        if line and not line.startswith("Events:"):
            return line

    return "Starting pod..."


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

        # Generate VS Code command with SSH agent forwarding
        return f"code --remote ssh-remote+{remote_server} --ssh-option ForwardAgent=yes /home/dev"

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
        recreate_env: bool = False,
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
                "recreate_env": recreate_env,
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

    def create_multinode_reservation(
        self,
        user_id: str,
        gpu_count: int,
        gpu_type: str,
        duration_hours: Union[int, float],
        name: Optional[str] = None,
        github_user: Optional[str] = None,
        jupyter_enabled: bool = False,
        recreate_env: bool = False,
    ) -> Optional[List[str]]:
        """Create multiple GPU reservations for multinode setup"""
        try:
            # Determine GPU config
            gpu_configs = {
                "t4": {"max_gpus": 4},
                "l4": {"max_gpus": 4},
                "t4-small": {"max_gpus": 1},
                "a100": {"max_gpus": 8},
                "h100": {"max_gpus": 8},
                "h200": {"max_gpus": 8},
                "b200": {"max_gpus": 8},
            }
            
            max_gpus_per_node = gpu_configs[gpu_type]["max_gpus"]
            num_nodes = gpu_count // max_gpus_per_node
            
            if gpu_count % max_gpus_per_node != 0:
                console.print(f"[red]❌ GPU count must be multiple of {max_gpus_per_node} for {gpu_type}[/red]")
                return None
                
            # Generate a master reservation ID to group related nodes
            master_reservation_id = str(uuid.uuid4())
            created_at = datetime.utcnow().isoformat()
            reservation_ids = []
            
            # Create reservation for each node
            for node_idx in range(num_nodes):
                node_reservation_id = str(uuid.uuid4())
                reservation_ids.append(node_reservation_id)
                
                # Node-specific name
                node_name = f"{name or f'{gpu_count}x {gpu_type.upper()} multinode'} - Node {node_idx + 1}/{num_nodes}"
                
                # Create reservation message for this node
                message = {
                    "reservation_id": node_reservation_id,
                    "master_reservation_id": master_reservation_id,  # Group related nodes
                    "node_index": node_idx,
                    "total_nodes": num_nodes,
                    "user_id": user_id,
                    "gpu_count": max_gpus_per_node,  # GPUs per node
                    "total_gpu_count": gpu_count,  # Total GPUs across all nodes
                    "gpu_type": gpu_type,
                    "duration_hours": float(duration_hours),
                    "name": node_name,
                    "created_at": created_at,
                    "status": "pending",
                    "jupyter_enabled": jupyter_enabled and node_idx == 0,  # Only enable Jupyter on master node
                    "recreate_env": recreate_env,
                    "is_multinode": True,
                }
                
                if github_user:
                    message["github_user"] = github_user
                
                # Send to SQS queue
                queue_url = self.config.get_queue_url()
                self.config.sqs_client.send_message(
                    QueueUrl=queue_url, MessageBody=json.dumps(message)
                )
            
            return reservation_ids
            
        except Exception as e:
            console.print(f"[red]❌ Error creating multinode reservation: {str(e)}[/red]")
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

    def wait_for_multinode_reservation_completion(
        self, reservation_ids: List[str], timeout_minutes: Optional[int] = 10, verbose: bool = False
    ) -> Optional[List[Dict[str, Any]]]:
        """Poll for multiple reservation completion using shared polling logic"""
        return self._wait_for_reservations_completion(reservation_ids, timeout_minutes, is_multinode=True, verbose=verbose)

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
                "current_detailed_status": reservation.get("current_detailed_status", ""),
                "status_history": reservation.get("status_history", []),
                "pod_logs": reservation.get("pod_logs", ""),
                "jupyter_url": reservation.get("jupyter_url", ""),
                "jupyter_port": reservation.get("jupyter_port", ""),
                "jupyter_token": reservation.get("jupyter_token", ""),
                "jupyter_enabled": reservation.get("jupyter_enabled", False),
                "jupyter_error": reservation.get("jupyter_error", ""),
                "ebs_volume_id": reservation.get("ebs_volume_id", ""),
                "secondary_users": reservation.get("secondary_users", []),
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

    def extend_reservation(self, reservation_id: str, extension_hours: float) -> bool:
        """Extend an active reservation by the specified number of hours"""
        try:
            # Send message to Lambda to extend reservation
            # Lambda will handle both the expiration timestamp update and any necessary pod updates
            message = {
                "action": "extend_reservation",
                "reservation_id": reservation_id,
                "extension_hours": extension_hours,
            }

            queue_url = self.config.get_queue_url()
            self.config.sqs_client.send_message(
                QueueUrl=queue_url, MessageBody=json.dumps(message)
            )

            console.print(
                f"[yellow]⏳ Extension request submitted for reservation {reservation_id[:8]}...[/yellow]"
            )

            # Poll for 3 minutes to show the outcome
            return self._poll_extend_action_result(
                reservation_id, extension_hours, timeout_minutes=3
            )

        except Exception as e:
            console.print(f"[red]❌ Error submitting extension request: {str(e)}[/red]")
            return False

    def get_gpu_availability_by_type(self) -> Optional[Dict[str, Dict[str, Any]]]:
        """Get GPU availability information by GPU type from real-time availability table"""
        try:
            # Try to get real-time availability from the availability table
            availability_table_name = self.config.availability_table
            availability_table = self.config.dynamodb.Table(availability_table_name)

            # Just scan the whole availability table
            response = availability_table.scan()
            availability_info = {}

            for item in response.get("Items", []):
                gpu_type = item["gpu_type"]
                queue_length = self._get_queue_length_for_gpu_type(gpu_type)
                estimated_wait = queue_length * 15 if queue_length > 0 else 0

                availability_info[gpu_type] = {
                    "available": int(item.get("available_gpus", 0)),
                    "total": int(item.get("total_gpus", 0)),
                    "queue_length": queue_length,
                    "estimated_wait_minutes": estimated_wait,
                    "running_instances": int(item.get("running_instances", 0)),
                    "desired_capacity": int(item.get("desired_capacity", 0)),
                    "last_updated": item.get("last_updated_timestamp", 0),
                }

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
            "b200": {"available": 0, "total": 8},  # 1x p6-b200.48xlarge = 8 B200s
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

    def _poll_extend_action_result(
        self, reservation_id: str, extension_hours: float, timeout_minutes: int = 3
    ) -> bool:
        """Poll reservation table for extend action result"""
        try:
            start_time = time.time()
            timeout_seconds = timeout_minutes * 60

            with Live(console=console, refresh_per_second=2) as live:
                spinner = Spinner(
                    "dots",
                    text=f"🔄 Extending reservation by {extension_hours} hours...",
                )
                live.update(spinner)

                initial_expiration = None

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

                        # Capture initial expiration on first iteration
                        if initial_expiration is None:
                            initial_expiration = reservation.get("expires_at", "")

                        current_expiration = reservation.get("expires_at", "")

                        # Check for extension failure indicators
                        last_updated = reservation.get("last_updated", 0)
                        extension_error = reservation.get("extension_error", "")

                        # If there's an extension error, fail immediately
                        if extension_error:
                            live.stop()
                            console.print(
                                f"[red]❌ Extension failed: {extension_error}[/red]"
                            )
                            return False

                        # Check if the expiration has been updated (different from initial)
                        if (
                            current_expiration != initial_expiration
                            and current_expiration
                        ):
                            live.stop()
                            from datetime import datetime

                            try:
                                exp_dt = datetime.fromisoformat(
                                    current_expiration.replace("Z", "+00:00")
                                )
                                # Convert to local timezone for display
                                try:
                                    # Try to get local timezone (Python 3.9+)
                                    local_exp = exp_dt.astimezone()
                                    formatted_expiration = local_exp.strftime(
                                        "%Y-%m-%d %H:%M:%S %Z"
                                    )
                                except:
                                    # Fallback to UTC if timezone conversion fails
                                    formatted_expiration = exp_dt.strftime(
                                        "%Y-%m-%d %H:%M:%S UTC"
                                    )
                                console.print(
                                    f"[green]✅ Extended reservation {reservation_id} by {extension_hours} hours -- your new expiration is {formatted_expiration}[/green]"
                                )
                                return True
                            except Exception:
                                # Fallback to UTC display if timezone conversion fails
                                try:
                                    exp_dt = datetime.fromisoformat(
                                        current_expiration.replace("Z", "+00:00")
                                    )
                                    formatted_expiration = exp_dt.strftime(
                                        "%Y-%m-%d %H:%M:%S UTC"
                                    )
                                    console.print(
                                        f"[green]✅ Extended reservation {reservation_id} by {extension_hours} hours -- your new expiration is {formatted_expiration}[/green]"
                                    )
                                except:
                                    console.print(
                                        f"[green]✅ Extended reservation {reservation_id} by {extension_hours} hours -- your new expiration is {current_expiration}[/green]"
                                    )
                                return True

                        spinner.text = f"🔄 Processing extension request..."
                        live.update(spinner)
                        time.sleep(2)

                    except Exception as poll_error:
                        spinner.text = f"🔄 Checking extension status (retry)..."
                        live.update(spinner)
                        time.sleep(2)

                live.stop()
                console.print(
                    f"[red]❌ Extension request timed out after {timeout_minutes} minutes[/red]"
                )
                console.print(
                    f"[yellow]The extension may still be processing. Check status with: gpu-dev list[/yellow]"
                )
                return False  # Return failure on timeout

        except Exception as e:
            console.print(f"[red]❌ Error polling extension result: {str(e)}[/red]")
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

    def _wait_for_reservations_completion(
        self, reservation_ids: List[str], timeout_minutes: Optional[int] = 10, is_multinode: bool = False, verbose: bool = False
    ) -> Optional[List[Dict[str, Any]]]:
        """Shared polling logic for both single and multinode reservations"""
        
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
        total_nodes = len(reservation_ids)
        
        # Track previous node statuses to only show changes
        previous_node_statuses = {}

        def handle_interrupt(signum, frame):
            """Handle Ctrl+C to cancel reservation(s)"""
            nonlocal cancelled
            cancelled = True

        def handle_clean_exit(signum, frame):
            """Handle clean exit signal (SIGTERM)"""
            nonlocal close_tool
            close_tool = True
            reservation_text = "reservations" if is_multinode else "reservation"
            console.print(
                f"\n[cyan]🔄 Clean exit requested - keeping {reservation_text} active...[/cyan]"
            )

        def check_keyboard_input():
            """Check if clean exit was requested via signal"""
            return close_tool

        # Set up signal handlers
        signal.signal(signal.SIGTERM, handle_clean_exit)
        try:
            signal.signal(signal.SIGQUIT, handle_clean_exit)
            action_text = "cancel all reservations" if is_multinode else "cancel reservation"
            keep_text = "keep reservations" if is_multinode else "keep reservation"
            console.print(
                f"[dim]💡 Press [cyan]Ctrl+C[/cyan] to {action_text} • Press [cyan]Ctrl+backslash[/cyan] to exit but {keep_text}[/dim]"
            )
        except (AttributeError, OSError):
            action_text = "cancel all reservations" if is_multinode else "cancel reservation"
            keep_text = "keep reservations" if is_multinode else "keep reservation"
            console.print(
                f"[dim]💡 Press [cyan]Ctrl+C[/cyan] to {action_text} • Send [cyan]SIGTERM[/cyan] to exit but {keep_text}[/dim]"
            )
            console.print(
                f"[dim]   (From another terminal: [cyan]kill {os.getpid()}[/cyan])[/dim]"
            )

        # Set up signal handler for Ctrl+C
        old_handler = signal.signal(signal.SIGINT, handle_interrupt)

        try:
            with Live(console=console, refresh_per_second=4) as live:
                initial_text = f"📡 Starting multinode reservation..." if is_multinode else "🔄 Sending reservation request..."
                spinner = Spinner("dots", text=initial_text)
                live.update(spinner)

                while (
                    (timeout_seconds is None or time.time() - start_time < timeout_seconds)
                    and not cancelled
                    and not close_tool
                ):
                    try:
                        # Check for keyboard input (clean exit)
                        if check_keyboard_input():
                            break

                        # Get current status of all reservations
                        all_reservations = []
                        node_details = []
                        
                        for i, res_id in enumerate(reservation_ids):
                            try:
                                response = self.reservations_table.get_item(Key={"reservation_id": res_id})
                                if "Item" in response:
                                    reservation = response["Item"]
                                    all_reservations.append(reservation)
                                    
                                    status = reservation.get("status", "unknown")
                                    failure_reason = reservation.get("failure_reason", "")
                                    current_detailed_status = reservation.get("current_detailed_status", "")
                                    queue_position = reservation.get("queue_position", "?")
                                    estimated_wait = reservation.get("estimated_wait_minutes", "?")
                                    gpu_count = reservation.get("gpu_count", 1)
                                    
                                    # Debug what we're reading from DynamoDB - only show if status changed
                                    if verbose:
                                        node_key = f"node_{i+1}_{res_id[:8]}"
                                        current_node_status = f"status={status}, detailed={current_detailed_status}"
                                        if previous_node_statuses.get(node_key) != current_node_status:
                                            print(f"[DEBUG] Node {i+1} ({res_id[:8]}): {current_node_status}")
                                            previous_node_statuses[node_key] = current_node_status
                                    
                                    node_details.append({
                                        "index": i,
                                        "status": status,
                                        "failure_reason": failure_reason,
                                        "current_detailed_status": current_detailed_status,
                                        "queue_position": queue_position,
                                        "estimated_wait": estimated_wait,
                                        "gpu_count": gpu_count,
                                        "reservation": reservation
                                    })
                                else:
                                    # No reservation found yet, keep waiting
                                    if not is_multinode:
                                        spinner.text = "📡 Waiting for reservation status update..."
                                        live.update(spinner)
                                        time.sleep(2)
                                        continue
                                    else:
                                        node_details.append({
                                            "index": i, "status": "unknown", "failure_reason": "",
                                            "current_detailed_status": "", "queue_position": "?",
                                            "estimated_wait": "?", "gpu_count": 0, "reservation": None
                                        })
                            except Exception as e:
                                if verbose:
                                    print(f"[DEBUG] Exception querying {res_id[:8]}: {e}")
                                node_details.append({
                                    "index": i, "status": "error", "failure_reason": "Connection error",
                                    "current_detailed_status": "", "queue_position": "?",
                                    "estimated_wait": "?", "gpu_count": 0, "reservation": None
                                })

                        # Calculate aggregate status
                        statuses = [node["status"] for node in node_details]
                        active_count = statuses.count("active")
                        failed_count = statuses.count("failed")
                        cancelled_count = statuses.count("cancelled")
                        preparing_count = statuses.count("preparing")
                        queued_count = statuses.count("queued")
                        
                        # Debug multinode status calculation - only show when aggregate status changes
                        if is_multinode and verbose and len(set(statuses)) > 1:  # Only when there are mixed statuses
                            print(f"[DEBUG] Mixed node statuses: active={active_count}, preparing={preparing_count}, queued={queued_count}, failed={failed_count}, total={total_nodes}")
                        
                        # Determine aggregate status for multinode reservations
                        # Only consider it failed if ALL nodes are explicitly failed/cancelled
                        # or if there's a significant portion failed (more than half)
                        if is_multinode:
                            # For multinode, be more conservative about declaring failure
                            if failed_count + cancelled_count >= total_nodes:
                                # All nodes failed - definitely failed
                                aggregate_status = "failed"
                            elif active_count == total_nodes:
                                # All nodes active - success
                                aggregate_status = "active"
                            elif active_count + preparing_count == total_nodes:
                                # All nodes either active or preparing - still working
                                aggregate_status = "preparing" if preparing_count > 0 else "active"
                            elif queued_count > 0:
                                # Any nodes queued - still in queue
                                aggregate_status = "queued"
                            elif failed_count + cancelled_count > total_nodes // 2:
                                # More than half failed - likely a real failure
                                aggregate_status = "failed"
                            else:
                                # Mixed state - keep preparing/pending
                                aggregate_status = "preparing" if preparing_count > 0 else "pending"
                        
                        # Debug aggregate status decision - only show when status changes
                        if is_multinode and verbose and aggregate_status != last_status:
                            print(f"[DEBUG] Calculated aggregate_status: {aggregate_status}")
                        
                        else:
                            # Single node - use original logic
                            if failed_count > 0 or cancelled_count > 0:
                                aggregate_status = "failed"
                            elif active_count == total_nodes:
                                aggregate_status = "active"
                            elif preparing_count > 0:
                                aggregate_status = "preparing"
                            elif queued_count > 0:
                                aggregate_status = "queued"
                            else:
                                aggregate_status = "pending"

                        # Build status message based on aggregate status and mode
                        message = ""
                        
                        if aggregate_status == "queued":
                            # Use first queued node's info for display
                            queued_nodes = [node for node in node_details if node["status"] == "queued"]
                            if queued_nodes:
                                first_queued = queued_nodes[0]
                                queue_position = first_queued["queue_position"]
                                estimated_wait = first_queued["estimated_wait"]
                                
                                # Initialize countdown logic
                                if (
                                    aggregate_status != last_status and estimated_wait != "?"
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
                                            queue_state["initial_estimated_wait"] = wait_minutes
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
                                        queue_state["initial_estimated_wait"] - elapsed_minutes,
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
                                
                                if is_multinode:
                                    total_gpus = sum(node["gpu_count"] for node in node_details if node["reservation"])
                                    message = f"📋 Position #{queue_position} in queue • Estimated wait: {wait_display} • {total_gpus} GPUs across {total_nodes} nodes"
                                else:
                                    gpu_count = first_queued["gpu_count"]
                                    message = f"📋 You are #{queue_position} in queue • Estimated wait: {wait_display} • {gpu_count} GPU(s) requested"

                                # Show help message once when entering queue
                                if show_queue_help and aggregate_status != last_status:
                                    help_text = "\n[dim]💡 Press [cyan]Ctrl+C[/cyan] to cancel reservation • Use [cyan]gpu-dev list[/cyan] to check status[/dim]"
                                    console.print(help_text)
                                    show_queue_help = False
                            else:
                                message = f"📋 Nodes in queue... ({active_count}/{total_nodes} ready)" if is_multinode else "📋 In queue..."

                        elif aggregate_status == "preparing":
                            if is_multinode:
                                # Show detailed preparation info for multinode - show ALL nodes, not just preparing ones
                                detailed_events = []
                                for node in node_details:
                                    node_status = node["status"]
                                    if node_status == "active":
                                        detailed_events.append(f"✓ Ready")
                                    elif node.get("current_detailed_status"):
                                        detailed_events.append(node["current_detailed_status"])
                                    elif node.get("failure_reason") and node_status == "failed":
                                        detailed_events.append(node["failure_reason"])
                                    elif node_status == "preparing":
                                        detailed_events.append("Preparing environment...")
                                    elif node_status in ["pending", "queued"]:
                                        detailed_events.append(f"{node_status.title()}...")
                                    else:
                                        detailed_events.append(node_status)
                                
                                if detailed_events and len(detailed_events) <= 16:  # Increased from 4 to 16
                                    # For multinode, create a custom multi-line display with individual spinners
                                    from rich.table import Table
                                    from rich.text import Text
                                    from rich.panel import Panel
                                    from rich.console import Group
                                    
                                    # Create a list of renderable items
                                    node_lines = []
                                    
                                    for i, event in enumerate(detailed_events):
                                        node_num = i + 1
                                        node_status = node_details[i]["status"]
                                        
                                        # Create individual spinner or checkmark for each node
                                        if node_status == "active":
                                            # Ready node - show checkmark without spinner
                                            line = Text(f"✓ Node {node_num}: Ready", style="green")
                                        else:
                                            # Not ready - create a spinner for this specific node
                                            node_spinner = Spinner("dots", text=f"Node {node_num}: {event}")
                                            line = node_spinner
                                        
                                        node_lines.append(line)
                                    
                                    # Group all lines together
                                    group = Group(*node_lines)
                                    
                                    # Add summary line
                                    summary = Text(f"({active_count}/{total_nodes} ready)", style="cyan")
                                    full_display = Group(group, summary)
                                    
                                    # Update live display with all spinners
                                    panel = Panel(full_display, title="🚀 Multinode Setup", expand=False)
                                    live.update(panel)
                                    
                                    # Don't set message since we're using custom display
                                    message = None
                                else:
                                    # Summarize if we have many nodes
                                    preparing_count = statuses.count("preparing")
                                    message = f"🚀 Preparing {preparing_count} nodes... ({active_count}/{total_nodes} ready)"
                            else:
                                # Show detailed preparation info for single node
                                preparing_nodes = [node for node in node_details if node["status"] == "preparing"]
                                node = preparing_nodes[0] if preparing_nodes else node_details[0]
                                
                                # Use unified status tracking - prefer current_detailed_status, fall back to failure_reason for actual failures
                                current_detailed_status = node.get("current_detailed_status", "")
                                failure_reason = node.get("failure_reason", "") if node.get("status") == "failed" else ""
                                
                                if current_detailed_status:
                                    message = f"🚀 {current_detailed_status}"
                                elif failure_reason:
                                    message = f"🚀 Failed: {failure_reason}"
                                else:
                                    message = status_messages.get(aggregate_status, f"Status: {aggregate_status}")
                        
                        elif aggregate_status == "failed":
                            failed_nodes = [node for node in node_details if node["status"] in ["failed", "cancelled"]]
                            if is_multinode:
                                failure_details = []
                                for node in failed_nodes:
                                    reason = node["failure_reason"] if node["failure_reason"] else node["status"]
                                    failure_details.append(f"Node {node['index']+1}: {reason}")
                                
                                # Add debug info about all node statuses for troubleshooting
                                debug_details = []
                                for node in node_details:
                                    status = node["status"]
                                    debug_details.append(f"Node {node['index']+1}: {status}")
                                
                                status_display = "\n".join([f"  {detail}" for detail in failure_details])
                                debug_display = "\n".join([f"  {detail}" for detail in debug_details])
                                message = f"❌ Multinode failed ({failed_count + cancelled_count}/{total_nodes})\n{status_display}"
                                live.update(Spinner("dots", text=message))
                                time.sleep(2)
                                console.print(f"\n[red]❌ Multinode reservation failed ({failed_count + cancelled_count}/{total_nodes} nodes failed)[/red]")
                                for detail in failure_details:
                                    console.print(f"[red]  {detail}[/red]")
                                console.print(f"\n[dim]Debug - All node statuses:[/dim]")
                                for detail in debug_details:
                                    console.print(f"[dim]  {detail}[/dim]")
                                return None
                            else:
                                # Handle single node failure below in completion check
                                pass
                        
                        elif aggregate_status == "active":
                            if is_multinode:
                                # Check if all nodes are truly ready: "active" status AND valid SSH command
                                nodes_ready = 0
                                for node in node_details:
                                    if (node["status"] == "active" and 
                                        node["reservation"] and
                                        node["reservation"].get("ssh_command", "ssh user@pending") not in ["ssh user@pending"] and
                                        not node["reservation"].get("ssh_command", "").endswith(".cluster.local")):
                                        nodes_ready += 1
                                
                                if nodes_ready == total_nodes:
                                    # All nodes truly ready with SSH access
                                    live.update(Spinner("dots", text=f"✅ All {total_nodes} nodes ready!"))
                                    time.sleep(1)
                                    console.print(f"\n[green]✅ Multinode reservation complete! All {total_nodes} nodes are ready.[/green]")
                                    
                                    # Show connection info for each node
                                    for node in node_details:
                                        if node["reservation"]:
                                            res = node["reservation"]
                                            ssh_command = res.get("ssh_command", "ssh user@pending")
                                            ssh_with_forwarding = _add_agent_forwarding_to_ssh(ssh_command)
                                            console.print(f"[cyan]🖥️  Node {node['index']+1}:[/cyan] {ssh_with_forwarding}")
                                    
                                    return all_reservations
                                else:
                                    # Some nodes are "active" but SSH not ready yet - keep preparing
                                    # For multinode, don't override detailed Panel display with summary message
                                    # The preparing logic above will show detailed per-node status
                                    message = f"🚀 Setting up SSH access... ({nodes_ready}/{total_nodes} ready)"
                                    # Don't directly update spinner here - let the main logic handle display
                            else:
                                # Handle single node completion below in completion check
                                pass
                        
                        else:
                            # Default pending/unknown status
                            if is_multinode:
                                message = f"⏳ Processing multinode reservation... ({active_count}/{total_nodes} ready)"
                            else:
                                message = status_messages.get(aggregate_status, f"Status: {aggregate_status}")

                        # Update spinner if status changed or we're in certain states
                        # BUT: Don't override custom Panel display for multinode with spinner
                        if aggregate_status != last_status or aggregate_status in ["queued", "preparing"]:
                            if message and not (is_multinode and aggregate_status == "preparing"):
                                # Only use spinner for single-node or non-preparing multinode states
                                spinner.text = message
                                last_status = aggregate_status
                                live.update(spinner)
                            elif not is_multinode and message:
                                # Single node - always use spinner
                                spinner.text = message
                                last_status = aggregate_status
                                live.update(spinner)
                            # For multinode preparing with custom display, we already updated above with Panel

                        # Check for single-node completion states (when not multinode or already handled above)
                        if not is_multinode and aggregate_status == "active":
                            reservation = all_reservations[0]
                            ssh_command = reservation.get("ssh_command", "ssh user@pending")
                            
                            # Only complete if we have a real SSH command (not pending/placeholder)
                            if ssh_command != "ssh user@pending" and not ssh_command.endswith(".cluster.local"):
                                live.stop()
                                duration_hours = reservation.get("duration_hours", 8)
                                reservation_id = reservation["reservation_id"]

                                console.print(f"\n[green]✅ Reservation complete![/green]")
                                console.print(f"[cyan]📋 Reservation ID:[/cyan] {reservation_id}")
                                console.print(f"[cyan]⏰ Valid for:[/cyan] {duration_hours} hours")
                                
                                # Add agent forwarding to SSH command
                                ssh_with_forwarding = _add_agent_forwarding_to_ssh(ssh_command)
                                console.print(f"[cyan]🖥️  Connect with:[/cyan] {ssh_with_forwarding}")

                                # Show VS Code remote command
                                vscode_command = _generate_vscode_command(ssh_command)
                                if vscode_command:
                                    console.print(f"[cyan]💻 VS Code Remote:[/cyan] {vscode_command}")

                                # Show Jupyter link if enabled
                                jupyter_enabled = reservation.get("jupyter_enabled", False)
                                jupyter_url = reservation.get("jupyter_url", "")
                                if jupyter_enabled and jupyter_url:
                                    console.print(f"[cyan]📊 Jupyter Lab:[/cyan] {jupyter_url}")

                                return all_reservations
                            else:
                                # Still preparing - show status but don't complete yet
                                current_detailed_status = reservation.get("current_detailed_status", "")
                                if current_detailed_status:
                                    message = f"🚀 {current_detailed_status}"
                                else:
                                    message = "🚀 Setting up external SSH access..."
                                
                                if message != (last_status if isinstance(last_status, str) else ""):
                                    spinner.text = message
                                    live.update(spinner)

                        elif not is_multinode and aggregate_status in ["failed", "cancelled"]:
                            live.stop()
                            reservation = all_reservations[0] if all_reservations else {}
                            failure_reason = reservation.get("failure_reason", "Unknown error")
                            reservation_id = reservation.get("reservation_id", "unknown")

                            if aggregate_status == "failed":
                                console.print(f"\n[red]❌ Reservation failed: {failure_reason}[/red]")
                                console.print(f"[red]📋 Reservation ID: {reservation_id}[/red]")

                                # Show pod logs if available
                                pod_logs = reservation.get("pod_logs", "")
                                if pod_logs and pod_logs.strip():
                                    from rich.panel import Panel
                                    from rich.text import Text

                                    console.print("\n[red]🔍 Pod logs (last 20 lines) - Details:[/red]")
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
                                console.print(f"\n[yellow]🛑 Reservation was cancelled[/yellow]")

                            return None

                        # Continue polling
                        time.sleep(3)

                    except Exception as e:
                        console.print(f"\n[red]❌ Error polling reservation status: {str(e)}[/red]")
                        return None

            # Handle cancellation
            if cancelled:
                live.stop()
                action_text = "multinode reservation" if is_multinode else "reservation request"
                console.print(f"\n[yellow]⚠️  Cancelling {action_text}...[/yellow]")

                # Cancel all reservations
                success_count = 0
                for res_id in reservation_ids:
                    try:
                        response = self.reservations_table.get_item(Key={"reservation_id": res_id})
                        if "Item" in response:
                            user_id = response["Item"].get("user_id", "unknown")
                            if self.cancel_reservation(res_id, user_id):
                                success_count += 1
                    except Exception as e:
                        console.print(f"[red]❌ Error cancelling reservation {res_id[:8]}: {str(e)}[/red]")

                if success_count == len(reservation_ids):
                    success_text = "All reservations cancelled successfully" if is_multinode else "Reservation cancelled successfully"
                    console.print(f"[green]✅ {success_text}[/green]")
                elif success_count > 0:
                    console.print(f"[yellow]⚠️  {success_count}/{len(reservation_ids)} reservations cancelled[/yellow]")
                else:
                    fail_text = "Failed to cancel reservations" if is_multinode else "Failed to cancel reservation"
                    console.print(f"[red]❌ {fail_text}[/red]")

                return None

            # Handle clean exit
            if close_tool:
                live.stop()
                if is_multinode:
                    id_display = ", ".join([res_id[:8] for res_id in reservation_ids])
                    console.print(f"\n[cyan]📱 Exiting - multinode reservations {id_display} continue in background...[/cyan]")
                else:
                    console.print(f"\n[cyan]📱 Exiting - reservation {reservation_ids[0][:8]} continues in background...[/cyan]")
                console.print("[cyan]💡 Use 'gpu-dev list' to check status[/cyan]")
                if not is_multinode:
                    console.print(f"[cyan]💡 Use 'gpu-dev show {reservation_ids[0][:8]}' to get connection details when ready[/cyan]")
                return None

            # Timeout reached
            live.stop()
            if timeout_minutes is not None:
                console.print(f"\n[yellow]⏰ Timeout reached after {timeout_minutes} minutes[/yellow]")
            else:
                console.print(f"\n[yellow]⏰ Polling stopped unexpectedly[/yellow]")
            console.print("[yellow]🔍 Check reservation status manually with: gpu-dev list[/yellow]")
            return None

        finally:
            # Restore original signal handlers
            signal.signal(signal.SIGINT, old_handler)
            try:
                signal.signal(signal.SIGTERM, signal.SIG_DFL)
                signal.signal(signal.SIGQUIT, signal.SIG_DFL)
            except (AttributeError, OSError):
                pass

    def wait_for_reservation_completion(
        self, reservation_id: str, timeout_minutes: Optional[int] = 10, verbose: bool = False
    ) -> Optional[Dict[str, Any]]:
        """Poll for single reservation completion using shared polling logic"""
        results = self._wait_for_reservations_completion([reservation_id], timeout_minutes, is_multinode=False, verbose=verbose)
        return results[0] if results else None
