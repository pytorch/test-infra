"""
GPU Availability Updater Lambda
Updates GPU availability table when ASG instances launch/terminate
"""

import json
import logging
import os
from typing import Dict, Any

import boto3

# Setup logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# AWS clients
dynamodb = boto3.resource("dynamodb")
autoscaling = boto3.client("autoscaling")

# Environment variables
AVAILABILITY_TABLE = os.environ["AVAILABILITY_TABLE"]
SUPPORTED_GPU_TYPES = json.loads(os.environ["SUPPORTED_GPU_TYPES"])


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Handle ASG capacity change events - update all GPU types"""
    try:
        logger.info(f"Processing availability update event: {json.dumps(event)}")
        
        # Extract event details for logging
        detail = event.get("detail", {})
        event_type = event.get("detail-type", "")
        asg_name = detail.get("AutoScalingGroupName", "")
        instance_id = detail.get("EC2InstanceId", "")
        
        logger.info(f"Event: {event_type}, ASG: {asg_name}, Instance: {instance_id}")
        logger.info("Updating availability for ALL GPU types...")
        
        # Update availability for ALL GPU types (use any ASG event as trigger to refresh all)
        updated_types = []
        for gpu_type in SUPPORTED_GPU_TYPES.keys():
            try:
                update_gpu_availability(gpu_type)
                updated_types.append(gpu_type)
                logger.info(f"Successfully updated availability for GPU type: {gpu_type}")
            except Exception as gpu_error:
                logger.error(f"Failed to update availability for {gpu_type}: {gpu_error}")
                # Continue with other GPU types
        
        return {
            "statusCode": 200,
            "body": json.dumps({
                "message": "Availability update completed",
                "trigger_asg": asg_name,
                "trigger_instance": instance_id,
                "updated_gpu_types": updated_types,
                "total_updated": len(updated_types)
            })
        }
        
    except Exception as e:
        logger.error(f"Error processing availability update: {str(e)}")
        raise


def update_gpu_availability(gpu_type: str) -> None:
    """Update availability information for a specific GPU type"""
    try:
        # Get current ASG capacity
        asg_name = f"pytorch-gpu-dev-gpu-nodes-self-managed-{gpu_type}"
        
        asg_response = autoscaling.describe_auto_scaling_groups(
            AutoScalingGroupNames=[asg_name]
        )
        
        if not asg_response["AutoScalingGroups"]:
            logger.warning(f"ASG not found: {asg_name}")
            return
        
        asg = asg_response["AutoScalingGroups"][0]
        
        # Calculate availability metrics
        desired_capacity = asg["DesiredCapacity"]
        running_instances = len([
            instance for instance in asg["Instances"]
            if instance["LifecycleState"] == "InService"
        ])
        
        # Get GPU configuration for this type
        gpu_config = SUPPORTED_GPU_TYPES.get(gpu_type, {})
        gpus_per_instance = gpu_config.get("gpus_per_instance", 8)
        
        total_gpus = running_instances * gpus_per_instance
        
        # For now, assume all GPUs are available (no K8s integration yet)
        # In production, we'd query K8s API for actual allocations
        available_gpus = total_gpus
        
        # Update DynamoDB table
        table = dynamodb.Table(AVAILABILITY_TABLE)
        
        table.put_item(
            Item={
                "gpu_type": gpu_type,
                "total_gpus": total_gpus,
                "available_gpus": available_gpus,
                "running_instances": running_instances,
                "desired_capacity": desired_capacity,
                "gpus_per_instance": gpus_per_instance,
                "last_updated": context.aws_request_id if 'context' in locals() else "unknown",
                "last_updated_timestamp": int(time.time()) if 'time' in dir() else 0
            }
        )
        
        logger.info(f"Updated {gpu_type}: {available_gpus}/{total_gpus} GPUs available ({running_instances} instances)")
        
    except Exception as e:
        logger.error(f"Error updating availability for {gpu_type}: {str(e)}")
        raise


import time