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

        # Set up Kubernetes client once for all GPU types
        k8s_client = None
        try:
            logger.info("Setting up shared Kubernetes client for all GPU types")
            from shared import setup_kubernetes_client
            k8s_client = setup_kubernetes_client()
            logger.info("Shared Kubernetes client ready")
        except Exception as k8s_setup_error:
            logger.error(f"Failed to setup Kubernetes client: {k8s_setup_error}")
            k8s_client = None

        # Update availability for ALL GPU types (use any ASG event as trigger to refresh all)
        updated_types = []
        for gpu_type in SUPPORTED_GPU_TYPES.keys():
            try:
                logger.info(f"=== Starting update for GPU type: {gpu_type} ===")
                update_gpu_availability(gpu_type, k8s_client)
                updated_types.append(gpu_type)
                logger.info(f"=== Successfully updated availability for GPU type: {gpu_type} ===")
            except Exception as gpu_error:
                logger.error(f"=== Failed to update availability for {gpu_type}: {gpu_error} ===")
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


def update_gpu_availability(gpu_type: str, k8s_client=None) -> None:
    """Update availability information for a specific GPU type"""
    try:
        logger.info(f"Starting availability update for GPU type: {gpu_type}")

        # Get current ASG capacity - handle multiple ASGs per GPU type (e.g., capacity reservations)
        asg_name_prefix = f"pytorch-gpu-dev-gpu-nodes-{gpu_type}"
        logger.info(f"Checking ASGs matching pattern: {asg_name_prefix}*")

        # Get all ASGs and filter by name pattern
        all_asgs_response = autoscaling.describe_auto_scaling_groups()
        matching_asgs = [
            asg for asg in all_asgs_response["AutoScalingGroups"]
            if asg["AutoScalingGroupName"].startswith(asg_name_prefix)
        ]

        if not matching_asgs:
            logger.warning(f"No ASGs found matching pattern: {asg_name_prefix}*")
            return

        asg_names = [asg["AutoScalingGroupName"] for asg in matching_asgs]
        logger.info(f"Found {len(matching_asgs)} ASGs: {asg_names}")

        # Calculate total availability metrics across all matching ASGs
        desired_capacity = sum(asg["DesiredCapacity"] for asg in matching_asgs)
        running_instances = sum(
            len([
                instance for instance in asg["Instances"]
                if instance["LifecycleState"] == "InService"
            ]) for asg in matching_asgs
        )

        # Get GPU configuration for this type
        gpu_config = SUPPORTED_GPU_TYPES.get(gpu_type, {})
        gpus_per_instance = gpu_config.get("gpus_per_instance", 8)

        total_gpus = running_instances * gpus_per_instance
        logger.info(
            f"ASG calculation: {running_instances} instances * {gpus_per_instance} GPUs = {total_gpus} total GPUs")

        # Query Kubernetes API for actual GPU allocations
        if k8s_client is not None:
            try:
                logger.info(f"Starting Kubernetes query for {gpu_type} GPU availability")
                available_gpus = check_schedulable_gpus_for_type(k8s_client, gpu_type)
                logger.info(f"Kubernetes reports {available_gpus} schedulable {gpu_type.upper()} GPUs")

            except Exception as k8s_error:
                logger.warning(f"Failed to query Kubernetes for {gpu_type} availability: {k8s_error}")
                # Fallback to ASG-based calculation (assume all GPUs available)
                available_gpus = total_gpus
        else:
            logger.warning(f"No Kubernetes client available for {gpu_type}, using ASG-based calculation")
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
        logger.info(f"Starting schedulable GPU check for type: {gpu_type}")
        from kubernetes import client

        v1 = client.CoreV1Api(k8s_client)
        logger.info(f"Created CoreV1Api client for {gpu_type}")

        # Get all nodes with the specified GPU type
        gpu_type_selector = f"GpuType={gpu_type}"
        logger.info(f"Querying nodes with label selector: {gpu_type_selector}")

        nodes = v1.list_node(label_selector=gpu_type_selector)
        logger.info(f"Retrieved {len(nodes.items) if nodes.items else 0} nodes for {gpu_type}")

        if not nodes.items:
            logger.warning(f"No nodes found for GPU type {gpu_type}")
            return 0

        total_schedulable = 0

        for i, node in enumerate(nodes.items):
            logger.info(f"Processing node {i + 1}/{len(nodes.items)}: {node.metadata.name}")

            if not is_node_ready_and_schedulable(node):
                logger.info(f"Node {node.metadata.name} is not ready/schedulable, skipping")
                continue

            logger.info(f"Node {node.metadata.name} is ready, checking GPU availability")
            # Get available GPUs on this node
            available_on_node = get_available_gpus_on_node(v1, node)
            total_schedulable += available_on_node
            logger.info(f"Node {node.metadata.name}: {available_on_node} GPUs available")

        logger.info(f"Found {total_schedulable} schedulable {gpu_type.upper()} GPUs across {len(nodes.items)} nodes")
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
        logger.info(f"Checking GPU availability on node: {node_name}")

        # Get all pods on this node
        logger.info(f"Querying pods on node {node_name}")
        pods = v1_api.list_pod_for_all_namespaces(field_selector=f"spec.nodeName={node_name}")
        logger.info(f"Found {len(pods.items)} pods on node {node_name}")

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
