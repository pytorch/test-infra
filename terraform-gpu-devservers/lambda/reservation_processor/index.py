"""
GPU Reservation Processor Lambda
Handles reservation requests and manages K8s pod allocation
"""

import json
import os
import boto3
import logging
from datetime import datetime, timedelta
from typing import Dict, Any, Optional
import uuid

# Setup logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# AWS clients
dynamodb = boto3.resource('dynamodb')
eks_client = boto3.client('eks')
ec2_client = boto3.client('ec2')

# Environment variables
RESERVATIONS_TABLE = os.environ['RESERVATIONS_TABLE']
SERVERS_TABLE = os.environ['SERVERS_TABLE']
EKS_CLUSTER_NAME = os.environ['EKS_CLUSTER_NAME']
REGION = os.environ['REGION']
MAX_RESERVATION_HOURS = int(os.environ['MAX_RESERVATION_HOURS'])
DEFAULT_TIMEOUT_HOURS = int(os.environ['DEFAULT_TIMEOUT_HOURS'])

def handler(event, context):
    """Main Lambda handler"""
    try:
        logger.info(f"Processing event: {json.dumps(event)}")
        
        # Process SQS messages
        for record in event.get('Records', []):
            if record.get('eventSource') == 'aws:sqs':
                process_reservation_request(record)
        
        return {
            'statusCode': 200,
            'body': json.dumps({'message': 'Processing completed'})
        }
    
    except Exception as e:
        logger.error(f"Error processing event: {str(e)}")
        raise

def process_reservation_request(record: Dict[str, Any]) -> None:
    """Process individual reservation request"""
    try:
        # Parse the reservation request
        message_body = json.loads(record['body'])
        reservation_request = json.loads(message_body.get('Message', message_body))
        
        logger.info(f"Processing reservation: {reservation_request}")
        
        # Validate request
        if not validate_reservation_request(reservation_request):
            logger.error(f"Invalid reservation request: {reservation_request}")
            return
        
        # Check availability
        available_gpus = check_gpu_availability()
        requested_gpus = reservation_request.get('gpu_count', 1)
        
        if available_gpus >= requested_gpus:
            # Create reservation
            reservation_id = create_reservation(reservation_request)
            logger.info(f"Created reservation: {reservation_id}")
            
            # Allocate resources (K8s pod creation would go here)
            allocate_gpu_resources(reservation_id, reservation_request)
        else:
            logger.info(f"Insufficient GPUs available. Requested: {requested_gpus}, Available: {available_gpus}")
            # Could implement queuing logic here
    
    except Exception as e:
        logger.error(f"Error processing reservation request: {str(e)}")
        raise

def validate_reservation_request(request: Dict[str, Any]) -> bool:
    """Validate reservation request parameters"""
    required_fields = ['user_id', 'gpu_count']
    
    for field in required_fields:
        if field not in request:
            logger.error(f"Missing required field: {field}")
            return False
    
    # Validate GPU count
    gpu_count = request.get('gpu_count', 1)
    if gpu_count not in [1, 2, 4, 8, 16]:  # 16 for 2x8 GPU setup
        logger.error(f"Invalid GPU count: {gpu_count}")
        return False
    
    # Validate duration
    duration_hours = request.get('duration_hours', DEFAULT_TIMEOUT_HOURS)
    if duration_hours > MAX_RESERVATION_HOURS:
        logger.error(f"Duration exceeds maximum: {duration_hours} > {MAX_RESERVATION_HOURS}")
        return False
    
    return True

def check_gpu_availability() -> int:
    """Check available GPU capacity"""
    try:
        # Query server status from DynamoDB
        servers_table = dynamodb.Table(SERVERS_TABLE)
        response = servers_table.scan(
            FilterExpression='#status = :status',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':status': 'available'}
        )
        
        total_available_gpus = 0
        for server in response['Items']:
            available_gpus = server.get('available_gpus', 0)
            total_available_gpus += available_gpus
        
        logger.info(f"Total available GPUs: {total_available_gpus}")
        return total_available_gpus
    
    except Exception as e:
        logger.error(f"Error checking GPU availability: {str(e)}")
        return 0

def create_reservation(request: Dict[str, Any]) -> str:
    """Create a new reservation record"""
    try:
        reservation_id = str(uuid.uuid4())
        now = datetime.utcnow()
        duration_hours = request.get('duration_hours', DEFAULT_TIMEOUT_HOURS)
        expires_at = now + timedelta(hours=duration_hours)
        
        reservation = {
            'reservation_id': reservation_id,
            'user_id': request['user_id'],
            'gpu_count': request['gpu_count'],
            'status': 'active',
            'created_at': now.isoformat(),
            'expires_at': int(expires_at.timestamp()),
            'duration_hours': duration_hours,
            'pod_name': f"gpu-dev-{reservation_id[:8]}",
            'namespace': 'gpu-dev'
        }
        
        # Add optional fields
        if 'instance_preference' in request:
            reservation['instance_preference'] = request['instance_preference']
        
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        reservations_table.put_item(Item=reservation)
        
        logger.info(f"Created reservation record: {reservation_id}")
        return reservation_id
    
    except Exception as e:
        logger.error(f"Error creating reservation: {str(e)}")
        raise

def allocate_gpu_resources(reservation_id: str, request: Dict[str, Any]) -> None:
    """Allocate GPU resources via K8s pod creation"""
    try:
        # This would typically use boto3 kubernetes client or kubectl
        # For now, we'll log the intended allocation
        
        gpu_count = request['gpu_count']
        pod_name = f"gpu-dev-{reservation_id[:8]}"
        
        logger.info(f"Allocating {gpu_count} GPUs for reservation {reservation_id}")
        logger.info(f"Pod name: {pod_name}")
        
        # Update server allocation in DynamoDB
        update_server_allocation(gpu_count, reservation_id)
        
        # In a real implementation, this would:
        # 1. Create Kubernetes pod with GPU resource requests
        # 2. Set up SSH access with user's GitHub public key
        # 3. Configure networking and storage
        # 4. Return connection details to user
        
    except Exception as e:
        logger.error(f"Error allocating GPU resources: {str(e)}")
        raise

def update_server_allocation(gpu_count: int, reservation_id: str) -> None:
    """Update server allocation status"""
    try:
        # For simplicity, we'll track total allocated GPUs
        # In production, this would be more sophisticated
        
        servers_table = dynamodb.Table(SERVERS_TABLE)
        
        # Find available servers and allocate GPUs
        response = servers_table.scan(
            FilterExpression='#status = :status',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':status': 'available'}
        )
        
        remaining_gpus = gpu_count
        
        for server in response['Items']:
            if remaining_gpus <= 0:
                break
                
            server_id = server['server_id']
            available_gpus = server.get('available_gpus', 8)  # Default 8 GPUs per p5.48xlarge
            
            if available_gpus > 0:
                allocated = min(remaining_gpus, available_gpus)
                new_available = available_gpus - allocated
                
                # Update server record
                servers_table.update_item(
                    Key={'server_id': server_id},
                    UpdateExpression='SET available_gpus = :new_available, allocated_gpus = allocated_gpus + :allocated',
                    ExpressionAttributeValues={
                        ':new_available': new_available,
                        ':allocated': allocated
                    }
                )
                
                remaining_gpus -= allocated
                logger.info(f"Allocated {allocated} GPUs on server {server_id}")
        
        if remaining_gpus > 0:
            logger.warning(f"Could not allocate {remaining_gpus} GPUs")
    
    except Exception as e:
        logger.error(f"Error updating server allocation: {str(e)}")
        raise