"""Reservation management for GPU Dev CLI"""

import json
import boto3
import uuid
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from botocore.exceptions import ClientError

from .config import Config

class ReservationManager:
    """Manages GPU server reservations"""
    
    def __init__(self, config: Config):
        self.config = config
        self.sqs = boto3.client('sqs', region_name=config.aws_region)
        self.dynamodb = boto3.resource('dynamodb', region_name=config.aws_region)
        self.reservations_table = self.dynamodb.Table(config.reservations_table)
        self.servers_table = self.dynamodb.Table(config.servers_table)
    
    def create_reservation(
        self, 
        user_id: str, 
        gpu_count: int, 
        duration_hours: int,
        name: Optional[str] = None
    ) -> Optional[str]:
        """Create a new GPU reservation"""
        try:
            reservation_request = {
                'user_id': user_id,
                'gpu_count': gpu_count,
                'duration_hours': duration_hours,
                'timestamp': datetime.utcnow().isoformat(),
                'request_id': str(uuid.uuid4())
            }
            
            if name:
                reservation_request['name'] = name
            
            # Send to SQS queue
            response = self.sqs.send_message(
                QueueUrl=self.config.queue_url,
                MessageBody=json.dumps(reservation_request)
            )
            
            return reservation_request['request_id']
        
        except ClientError as e:
            print(f"❌ AWS Error: {e}")
            return None
        except Exception as e:
            print(f"❌ Error creating reservation: {e}")
            return None
    
    def list_reservations(
        self, 
        user_filter: Optional[str] = None,
        status_filter: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """List GPU reservations"""
        try:
            if user_filter:
                # Query by user
                response = self.reservations_table.query(
                    IndexName='UserIndex',
                    KeyConditionExpression='user_id = :user_id',
                    ExpressionAttributeValues={':user_id': user_filter}
                )
            else:
                # Scan all reservations
                response = self.reservations_table.scan()
            
            reservations = response.get('Items', [])
            
            # Filter by status if specified
            if status_filter:
                reservations = [r for r in reservations if r.get('status') == status_filter]
            
            # Sort by creation time (newest first)
            reservations.sort(key=lambda x: x.get('created_at', ''), reverse=True)
            
            return reservations
        
        except ClientError as e:
            print(f"❌ AWS Error: {e}")
            return []
        except Exception as e:
            print(f"❌ Error listing reservations: {e}")
            return []
    
    def cancel_reservation(self, reservation_id: str, user_id: str) -> bool:
        """Cancel a GPU reservation"""
        try:
            # Get the reservation
            response = self.reservations_table.get_item(
                Key={'reservation_id': reservation_id}
            )
            
            if 'Item' not in response:
                print(f"❌ Reservation {reservation_id} not found")
                return False
            
            reservation = response['Item']
            
            # Check if user owns the reservation
            if reservation.get('user_id') != user_id:
                print(f"❌ You don't have permission to cancel this reservation")
                return False
            
            # Update status to cancelled
            self.reservations_table.update_item(
                Key={'reservation_id': reservation_id},
                UpdateExpression='SET #status = :status, cancelled_at = :cancelled_at',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={
                    ':status': 'cancelled',
                    ':cancelled_at': datetime.utcnow().isoformat()
                }
            )
            
            return True
        
        except ClientError as e:
            print(f"❌ AWS Error: {e}")
            return False
        except Exception as e:
            print(f"❌ Error cancelling reservation: {e}")
            return False
    
    def get_connection_info(self, reservation_id: str, user_id: str) -> Optional[Dict[str, Any]]:
        """Get SSH connection information for a reservation"""
        try:
            # Get the reservation
            response = self.reservations_table.get_item(
                Key={'reservation_id': reservation_id}
            )
            
            if 'Item' not in response:
                print(f"❌ Reservation {reservation_id} not found")
                return None
            
            reservation = response['Item']
            
            # Check if user owns the reservation
            if reservation.get('user_id') != user_id:
                print(f"❌ You don't have permission to access this reservation")
                return None
            
            # Check if reservation is active
            if reservation.get('status') != 'active':
                print(f"❌ Reservation is not active (status: {reservation.get('status')})")
                return None
            
            # Build connection info
            pod_name = reservation.get('pod_name', f"gpu-dev-{reservation_id[:8]}")
            namespace = reservation.get('namespace', 'gpu-dev')
            
            connection_info = {
                'reservation_id': reservation_id,
                'pod_name': pod_name,
                'namespace': namespace,
                'gpu_count': reservation.get('gpu_count', 1),
                'ssh_command': f"kubectl exec -it {pod_name} -n {namespace} -- /bin/bash",
                'port_forward': f"kubectl port-forward {pod_name} -n {namespace} 8888:8888"
            }
            
            return connection_info
        
        except ClientError as e:
            print(f"❌ AWS Error: {e}")
            return None
        except Exception as e:
            print(f"❌ Error getting connection info: {e}")
            return None
    
    def get_cluster_status(self) -> Optional[Dict[str, Any]]:
        """Get overall cluster status"""
        try:
            # Get server status
            servers_response = self.servers_table.scan()
            servers = servers_response.get('Items', [])
            
            total_gpus = 0
            available_gpus = 0
            
            for server in servers:
                total_gpus += server.get('total_gpus', 8)  # Default 8 GPUs per p5.48xlarge
                available_gpus += server.get('available_gpus', 0)
            
            # Get active reservations
            reservations_response = self.reservations_table.query(
                IndexName='StatusIndex',
                KeyConditionExpression='#status = :status',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={':status': 'active'}
            )
            
            active_reservations = len(reservations_response.get('Items', []))
            reserved_gpus = total_gpus - available_gpus
            
            # Get queue length
            queue_attrs = self.sqs.get_queue_attributes(
                QueueUrl=self.config.queue_url,
                AttributeNames=['ApproximateNumberOfMessages']
            )
            queue_length = int(queue_attrs['Attributes']['ApproximateNumberOfMessages'])
            
            return {
                'total_gpus': total_gpus,
                'available_gpus': available_gpus,
                'reserved_gpus': reserved_gpus,
                'active_reservations': active_reservations,
                'queue_length': queue_length
            }
        
        except ClientError as e:
            print(f"❌ AWS Error: {e}")
            return None
        except Exception as e:
            print(f"❌ Error getting cluster status: {e}")
            return None