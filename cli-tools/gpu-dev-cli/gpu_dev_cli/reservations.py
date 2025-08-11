"""Minimal reservation management for GPU Dev CLI"""

import json
import time
import uuid
from datetime import datetime
from typing import Optional, List, Dict, Any, Union
from decimal import Decimal
from botocore.exceptions import ClientError
from rich.console import Console
from rich.spinner import Spinner
from rich.live import Live

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
        github_user: Optional[str] = None
    ) -> Optional[str]:
        """Create a new GPU reservation"""
        try:
            reservation_id = str(uuid.uuid4())
            created_at = datetime.utcnow().isoformat()

            # Create initial reservation record for polling
            # Convert float to Decimal for DynamoDB compatibility
            duration_decimal = Decimal(str(duration_hours))
            
            initial_reservation = {
                'reservation_id': reservation_id,
                'user_id': user_id,
                'gpu_count': gpu_count,
                'duration_hours': duration_decimal,
                'name': name or f"{gpu_count}-GPU reservation",
                'created_at': created_at,
                'status': 'pending',
                'expires_at': int((datetime.utcnow().timestamp() + (duration_hours * 3600))),
            }
            
            # Add github_user if provided
            if github_user:
                initial_reservation['github_user'] = github_user

            # Store in DynamoDB for immediate polling
            self.reservations_table.put_item(Item=initial_reservation)

            # Send processing request to SQS queue
            # Use float for SQS message (JSON serializable)
            message = {
                'reservation_id': reservation_id,
                'user_id': user_id,
                'gpu_count': gpu_count,
                'duration_hours': float(duration_hours),
                'name': name or f"{gpu_count}-GPU reservation",
                'created_at': created_at,
                'status': 'pending'
            }
            
            # Add github_user if provided
            if github_user:
                message['github_user'] = github_user

            queue_url = self.config.get_queue_url()
            self.config.sqs_client.send_message(
                QueueUrl=queue_url,
                MessageBody=json.dumps(message)
            )

            return reservation_id

        except Exception as e:
            console.print(f"[red]❌ Error creating reservation: {str(e)}[/red]")
            return None

    def list_reservations(
        self,
        user_filter: Optional[str] = None,
        status_filter: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """List GPU reservations"""
        try:
            if user_filter:
                response = self.reservations_table.query(
                    IndexName='UserIndex',
                    KeyConditionExpression='user_id = :user_id',
                    ExpressionAttributeValues={':user_id': user_filter}
                )
            elif status_filter:
                response = self.reservations_table.query(
                    IndexName='StatusIndex',
                    KeyConditionExpression='status = :status',
                    ExpressionAttributeValues={':status': status_filter}
                )
            else:
                # Scan all reservations (limited for security)
                response = self.reservations_table.scan(Limit=50)

            return response.get('Items', [])

        except Exception as e:
            console.print(f"[red]❌ Error listing reservations: {str(e)}[/red]")
            return []

    def cancel_reservation(self, reservation_id: str, user_id: str) -> bool:
        """Cancel a GPU reservation"""
        try:
            self.reservations_table.update_item(
                Key={'reservation_id': reservation_id},
                UpdateExpression='SET #status = :status, cancelled_at = :cancelled_at',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={
                    ':status': 'cancelled',
                    ':cancelled_at': datetime.utcnow().isoformat(),
                    ':user_id': user_id
                },
                ConditionExpression='user_id = :user_id'
            )
            return True

        except Exception as e:
            console.print(f"[red]❌ Error cancelling reservation: {str(e)}[/red]")
            return False

    def get_connection_info(self, reservation_id: str, user_id: str) -> Optional[Dict[str, Any]]:
        """Get SSH connection information for a reservation"""
        try:
            response = self.reservations_table.get_item(
                Key={'reservation_id': reservation_id}
            )

            if 'Item' not in response:
                return None

            reservation = response['Item']

            # Verify user owns this reservation
            if reservation['user_id'] != user_id:
                return None

            return {
                'ssh_command': reservation.get('ssh_command', 'ssh user@pending'),
                'pod_name': reservation.get('pod_name', 'pending'),
                'namespace': reservation.get('namespace', 'default'),
                'gpu_count': reservation['gpu_count'],
                'status': reservation['status']
            }

        except Exception as e:
            console.print(f"[red]❌ Error getting connection info: {str(e)}[/red]")
            return None

    def get_cluster_status(self) -> Optional[Dict[str, Any]]:
        """Get overall GPU cluster status"""
        try:
            # Get reservations
            reservations_response = self.reservations_table.scan()
            reservations = reservations_response.get('Items', [])

            # Get servers
            servers_response = self.servers_table.scan()
            servers = servers_response.get('Items', [])

            # Calculate stats
            active_reservations = [r for r in reservations if r.get('status') == 'active']
            reserved_gpus = sum(int(r.get('gpu_count', 0)) for r in active_reservations)
            total_gpus = sum(int(s.get('gpu_count', 0)) for s in servers)

            # Get queue length
            try:
                queue_url = self.config.get_queue_url()
                queue_attrs = self.config.sqs_client.get_queue_attributes(
                    QueueUrl=queue_url,
                    AttributeNames=['ApproximateNumberOfMessages']
                )
                queue_length = int(queue_attrs['Attributes']['ApproximateNumberOfMessages'])
            except:
                queue_length = len([r for r in reservations if r.get('status') == 'pending'])

            return {
                'total_gpus': total_gpus,
                'available_gpus': max(0, total_gpus - reserved_gpus),
                'reserved_gpus': reserved_gpus,
                'active_reservations': len(active_reservations),
                'queue_length': queue_length
            }

        except Exception as e:
            console.print(f"[red]❌ Error getting cluster status: {str(e)}[/red]")
            return None

    def wait_for_reservation_completion(self, reservation_id: str, timeout_minutes: int = 10) -> Optional[Dict[str, Any]]:
        """Poll for reservation completion with status updates and spinner"""
        import signal

        status_messages = {
            'pending': '⏳ Reservation request submitted, waiting for processing...',
            'queued': '📋 No resources available, trying again...',
            'preparing': '🚀 Reservation found, preparing machine...',
            'active': '✅ Reservation complete!',
            'failed': '❌ Reservation failed',
            'cancelled': '🛑 Reservation cancelled'
        }

        start_time = time.time()
        timeout_seconds = timeout_minutes * 60
        last_status = None
        cancelled = False

        def handle_interrupt(signum, frame):
            """Handle Ctrl+C to cancel reservation"""
            nonlocal cancelled
            cancelled = True

        # Set up signal handler for Ctrl+C
        old_handler = signal.signal(signal.SIGINT, handle_interrupt)

        try:
            with Live(console=console, refresh_per_second=4) as live:
                spinner = Spinner("dots", text="🔄 Sending reservation request...")
                live.update(spinner)

                while time.time() - start_time < timeout_seconds and not cancelled:
                    try:
                        # Get current reservation status
                        response = self.reservations_table.get_item(
                            Key={'reservation_id': reservation_id}
                        )

                        if 'Item' not in response:
                            # No reservation found yet, keep waiting
                            spinner.text = "📡 Waiting for reservation status update..."
                            live.update(spinner)
                            time.sleep(2)
                            continue

                        reservation = response['Item']
                        current_status = reservation.get('status', 'pending')

                        # Update message if status changed
                        if current_status != last_status:
                            message = status_messages.get(current_status, f"Status: {current_status}")
                            spinner.text = message
                            last_status = current_status
                            live.update(spinner)

                        # Check for completion states
                        if current_status == 'active':
                            live.stop()

                            # Get connection info
                            ssh_command = reservation.get('ssh_command', 'ssh user@pending')
                            duration_hours = reservation.get('duration_hours', 8)

                            console.print(f"\n[green]✅ Reservation complete![/green]")
                            console.print(f"[cyan]📋 Reservation ID:[/cyan] {reservation_id}")
                            console.print(f"[cyan]⏰ Valid for:[/cyan] {duration_hours} hours")
                            console.print(f"[cyan]🖥️  Connect with:[/cyan] {ssh_command}")

                            return reservation

                        elif current_status in ['failed', 'cancelled']:
                            live.stop()
                            failure_reason = reservation.get('failure_reason', 'Unknown error')

                            if current_status == 'failed':
                                console.print(f"\n[red]❌ Reservation failed: {failure_reason}[/red]")
                                console.print(f"[red]📋 Reservation ID: {reservation_id}[/red]")
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
                console.print("\n[yellow]⚠️  Cancelling reservation request...[/yellow]")

                # Get user_id for cancellation
                try:
                    response = self.reservations_table.get_item(
                        Key={'reservation_id': reservation_id}
                    )
                    if 'Item' in response:
                        user_id = response['Item'].get('user_id', 'unknown')
                        if self.cancel_reservation(reservation_id, user_id):
                            console.print("[green]✅ Reservation cancelled successfully[/green]")
                        else:
                            console.print("[red]❌ Failed to cancel reservation[/red]")
                except Exception as e:
                    console.print(f"[red]❌ Error cancelling reservation: {str(e)}[/red]")

                return None

            # Timeout reached
            live.stop()
            console.print(f"\n[yellow]⏰ Timeout reached after {timeout_minutes} minutes[/yellow]")
            console.print(f"[yellow]🔍 Check reservation status manually with: gpu-dev list[/yellow]")
            return None

        finally:
            # Restore original signal handler
            signal.signal(signal.SIGINT, old_handler)
