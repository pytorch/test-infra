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
                logger.info(
                    f"Successfully updated availability for GPU type: {gpu_type}"
                )
            except Exception as gpu_error:
                logger.error(
                    f"Failed to update availability for {gpu_type}: {gpu_error}"
                )
                # Continue with other GPU types

        return {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "message": "Availability update completed",
                    "trigger_asg": asg_name,
                    "trigger_instance": instance_id,
                    "updated_gpu_types": updated_types,
                    "total_updated": len(updated_types),
                }
            ),
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
        running_instances = len(
            [
                instance
                for instance in asg["Instances"]
                if instance["LifecycleState"] == "InService"
            ]
        )

        # Get GPU configuration for this type
        gpu_config = SUPPORTED_GPU_TYPES.get(gpu_type, {})
        gpus_per_instance = gpu_config.get("gpus_per_instance", 8)

        total_gpus = running_instances * gpus_per_instance

        # Query Kubernetes API for actual GPU allocations
        try:
            from shared.k8s_client import setup_kubernetes_client

            k8s_client = setup_kubernetes_client()
            available_gpus = check_schedulable_gpus_for_type(k8s_client, gpu_type)

            logger.info(
                f"Kubernetes reports {available_gpus} schedulable {gpu_type.upper()} GPUs"
            )

        except Exception as k8s_error:
            logger.warning(
                f"Failed to query Kubernetes for {gpu_type} availability: {k8s_error}"
            )
            # Fallback to ASG-based calculation (assume all GPUs available)
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
                "last_updated": context.aws_request_id
                if "context" in locals()
                else "unknown",
                "last_updated_timestamp": int(time.time()) if "time" in dir() else 0,
            }
        )

        logger.info(
            f"Updated {gpu_type}: {available_gpus}/{total_gpus} GPUs available ({running_instances} instances)"
        )

    except Exception as e:
        logger.error(f"Error updating availability for {gpu_type}: {str(e)}")
        raise


import time


def check_schedulable_gpus_for_type(k8s_client, gpu_type: str) -> int:
    """Check how many GPUs of a specific type are schedulable (available for new pods)"""
    try:
        from kubernetes import client

        v1 = client.CoreV1Api(k8s_client)

        # Get all nodes with the specified GPU type
        gpu_type_selector = f"GpuType={gpu_type}"
        nodes = v1.list_node(label_selector=gpu_type_selector)

        if not nodes.items:
            logger.warning(f"No nodes found for GPU type {gpu_type}")
            return 0

        total_schedulable = 0

        for node in nodes.items:
            if not is_node_ready_and_schedulable(node):
                continue

            # Get available GPUs on this node
            available_on_node = get_available_gpus_on_node(v1, node)
            total_schedulable += available_on_node

        logger.info(
            f"Found {total_schedulable} schedulable {gpu_type.upper()} GPUs across {len(nodes.items)} nodes"
        )
        return total_schedulable

    except Exception as e:
        logger.error(f"Error checking schedulable GPUs for type {gpu_type}: {str(e)}")
        return 0


def is_node_ready_and_schedulable(node) -> bool:
    """Check if a node is ready and schedulable"""
    try:
        # Check node conditions
        conditions = node.status.conditions or []
        is_ready = False

        for condition in conditions:
            if condition.type == "Ready":
                is_ready = condition.status == "True"
                break

        if not is_ready:
            return False

        # Check if node is schedulable (not cordoned)
        return not node.spec.unschedulable

    except Exception as e:
        logger.error(f"Error checking node readiness: {str(e)}")
        return False


def get_available_gpus_on_node(v1_api, node) -> int:
    """Get number of available GPUs on a specific node"""
    try:
        node_name = node.metadata.name

        # Get all pods on this node
        pods = v1_api.list_pod_for_all_namespaces(
            field_selector=f"spec.nodeName={node_name}"
        )

        # Calculate GPU usage
        used_gpus = 0
        for pod in pods.items:
            if pod.status.phase in ["Running", "Pending"]:
                for container in pod.spec.containers:
                    if container.resources and container.resources.requests:
                        gpu_request = container.resources.requests.get(
                            "nvidia.com/gpu", "0"
                        )
                        try:
                            used_gpus += int(gpu_request)
                        except (ValueError, TypeError):
                            pass

        # Get total GPUs on this node
        total_gpus = 0
        if node.status.allocatable:
            gpu_allocatable = node.status.allocatable.get("nvidia.com/gpu", "0")
            try:
                total_gpus = int(gpu_allocatable)
            except (ValueError, TypeError):
                pass

        available_gpus = max(0, total_gpus - used_gpus)
        logger.debug(f"Node {node_name}: {available_gpus}/{total_gpus} GPUs available")

        return available_gpus

    except Exception as e:
        logger.error(
            f"Error getting available GPUs on node {node.metadata.name}: {str(e)}"
        )
        return 0
