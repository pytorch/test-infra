"""
GPU Reservation Processor Lambda
Handles reservation requests and manages K8s pod allocation
"""

import json
import logging
import os
import time
import uuid
import socket
import random
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

import boto3

from shared import K8sGPUTracker, setup_kubernetes_client
from shared.snapshot_utils import create_pod_shutdown_snapshot, get_latest_snapshot

from kubernetes import client
from kubernetes.stream import stream

# Setup logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Environment variables
RESERVATIONS_TABLE = os.environ["RESERVATIONS_TABLE"]
EKS_CLUSTER_NAME = os.environ["EKS_CLUSTER_NAME"]
REGION = os.environ["REGION"]
MAX_RESERVATION_HOURS = int(os.environ["MAX_RESERVATION_HOURS"])
DEFAULT_TIMEOUT_HOURS = int(os.environ["DEFAULT_TIMEOUT_HOURS"])
QUEUE_URL = os.environ["QUEUE_URL"]
PRIMARY_AVAILABILITY_ZONE = os.environ["PRIMARY_AVAILABILITY_ZONE"]
GPU_DEV_CONTAINER_IMAGE = os.environ.get("GPU_DEV_CONTAINER_IMAGE", "pytorch/pytorch:2.8.0-cuda12.9-cudnn9-devel")
EFS_SECURITY_GROUP_ID = os.environ.get("EFS_SECURITY_GROUP_ID")
EFS_SUBNET_IDS = os.environ.get("EFS_SUBNET_IDS", "").split(",") if os.environ.get("EFS_SUBNET_IDS") else []

# AWS clients
dynamodb = boto3.resource("dynamodb", region_name=REGION)
eks_client = boto3.client("eks")
ec2_client = boto3.client("ec2")
efs_client = boto3.client("efs")
sqs_client = boto3.client("sqs")

# Global Kubernetes client (reused across Lambda execution)
_k8s_client = None

# Global monitoring threads registry (for cancellation cleanup)
_monitoring_threads = {}


def get_k8s_client():
    """Get or create the global Kubernetes client (singleton pattern)"""
    global _k8s_client
    if _k8s_client is None:
        logger.info("Initializing global Kubernetes client...")
        _k8s_client = setup_kubernetes_client()
        logger.info("Global Kubernetes client initialized successfully")
    return _k8s_client


def get_target_az_for_reservation(gpu_type, gpus_requested):
    """
    Dynamically determine which AZ the pod will land in based on available capacity.
    Returns the AZ where the pod will actually be scheduled.
    """
    try:
        k8s_client = get_k8s_client()

        v1 = client.CoreV1Api(k8s_client)

        # Get all nodes with the requested GPU type
        logger.info(f"Querying nodes for GPU type {gpu_type} with {gpus_requested} GPUs needed")
        nodes = v1.list_node(label_selector=f"GpuType={gpu_type}")

        candidate_nodes = []

        for node in nodes.items:
            # Check if node is ready and schedulable
            ready = False
            schedulable = True

            if node.status and node.status.conditions:
                for condition in node.status.conditions:
                    if condition.type == "Ready" and condition.status == "True":
                        ready = True
                        break

            if node.spec and node.spec.unschedulable:
                schedulable = False

            if not ready or not schedulable:
                logger.debug(f"Skipping node {node.metadata.name} - not ready or not schedulable")
                continue

            # Get node's availability zone
            node_az = None
            if node.metadata.labels:
                node_az = node.metadata.labels.get('topology.kubernetes.io/zone')
                if not node_az:
                    # Fallback to failure-domain label (older k8s versions)
                    node_az = node.metadata.labels.get('failure-domain.beta.kubernetes.io/zone')

            if not node_az:
                logger.warning(f"Node {node.metadata.name} has no AZ label")
                continue

            # Check available GPU capacity on this node
            available_gpus = get_available_gpus_on_node(v1, node)

            if available_gpus >= gpus_requested:
                candidate_nodes.append({
                    'node_name': node.metadata.name,
                    'az': node_az,
                    'available_gpus': available_gpus
                })
                logger.info(f"Node {node.metadata.name} in {node_az}: {available_gpus} available GPUs")

        if not candidate_nodes:
            logger.warning(f"No nodes found with {gpus_requested} available {gpu_type} GPUs")
            return None

        # Return the AZ of the first suitable node (Kubernetes scheduler will make the final decision)
        # This gives us the best prediction of where the pod will land
        selected_node = candidate_nodes[0]
        target_az = selected_node['az']

        logger.info(f"Target AZ for {gpu_type} reservation: {target_az} (node: {selected_node['node_name']})")
        return target_az

    except Exception as e:
        logger.error(f"Error determining target AZ for {gpu_type}: {str(e)}")
        # Fallback to primary AZ if detection fails
        return PRIMARY_AVAILABILITY_ZONE


def needs_ebs_migration(user_id, target_az):
    """Check if user's EBS volume needs to be migrated to a different AZ"""
    try:
        logger.info(f"Checking for existing EBS volumes for user {user_id}")

        # Look for ANY existing EBS volume with user tag, regardless of AZ
        response = ec2_client.describe_volumes(
            Filters=[
                {"Name": "tag:gpu-dev-user", "Values": [user_id]},
                {"Name": "status", "Values": ["available", "in-use"]},
            ]
        )

        volumes = response.get("Volumes", [])
        if not volumes:
            logger.info(f"No existing EBS volumes found for user {user_id} - no migration needed")
            return False, None, None

        # Get the most recent volume (by creation time)
        current_volume = max(volumes, key=lambda v: v["CreateTime"])
        current_volume_id = current_volume["VolumeId"]
        current_az = current_volume["AvailabilityZone"]

        if current_az == target_az:
            logger.info(
                f"User {user_id} EBS volume {current_volume_id} already in target AZ {target_az} - no migration needed")
            return False, current_volume_id, current_az

        logger.info(f"User {user_id} needs EBS migration: volume {current_volume_id} from {current_az} to {target_az}")
        return True, current_volume_id, current_az

    except Exception as e:
        logger.error(f"Error checking EBS migration need for user {user_id}: {str(e)}")
        return False, None, None


def migrate_ebs_across_az(user_id, current_volume_id, current_az, target_az):
    """
    Migrate EBS volume from current AZ to target AZ using snapshots.
    Returns (new_volume_id, snapshot_id) or raises exception.
    """
    try:
        logger.info(f"Starting EBS migration for user {user_id} from {current_az} to {target_az}")

        # Step 1: Create snapshot of current volume
        logger.info(f"Creating snapshot of volume {current_volume_id}")
        snapshot_response = ec2_client.create_snapshot(
            VolumeId=current_volume_id,
            Description=f"gpu-dev migration snapshot for {user_id} from {current_az} to {target_az}",
            TagSpecifications=[{
                "ResourceType": "snapshot",
                "Tags": [
                    {"Key": "gpu-dev-user", "Value": user_id},
                    {"Key": "Name", "Value": f"gpu-dev-migration-{user_id.split('@')[0]}-{int(time.time())}"},
                    {"Key": "Project", "Value": "gpu-dev-servers"},
                    {"Key": "ManagedBy", "Value": "gpu-dev-cli"},
                    {"Key": "MigrationType", "Value": "az-migration"},
                    {"Key": "SourceAZ", "Value": current_az},
                    {"Key": "TargetAZ", "Value": target_az}
                ]
            }]
        )

        snapshot_id = snapshot_response["SnapshotId"]
        logger.info(f"Created snapshot {snapshot_id}, waiting for completion...")

        # Wait for snapshot to complete
        waiter = ec2_client.get_waiter("snapshot_completed")
        waiter.wait(SnapshotIds=[snapshot_id], WaiterConfig={"Delay": 15, "MaxAttempts": 240})  # Up to 1 hour

        logger.info(f"Snapshot {snapshot_id} completed successfully")

        # Step 2: Create new volume from snapshot in target AZ
        logger.info(f"Creating new volume from snapshot {snapshot_id} in AZ {target_az}")
        new_volume_response = ec2_client.create_volume(
            AvailabilityZone=target_az,
            SnapshotId=snapshot_id,
            VolumeType="gp3",
            Iops=3000,
            Throughput=125,
            TagSpecifications=[{
                "ResourceType": "volume",
                "Tags": [
                    {"Key": "gpu-dev-user", "Value": user_id},
                    {"Key": "Name", "Value": f"gpu-dev-persistent-{user_id.split('@')[0]}"},
                    {"Key": "Project", "Value": "gpu-dev-servers"},
                    {"Key": "ManagedBy", "Value": "gpu-dev-cli"},
                    {"Key": "MigratedFrom", "Value": current_az},
                    {"Key": "SourceSnapshot", "Value": snapshot_id}
                ]
            }]
        )

        new_volume_id = new_volume_response["VolumeId"]
        logger.info(f"Created new volume {new_volume_id}, waiting for availability...")

        # Wait for new volume to be available
        waiter = ec2_client.get_waiter("volume_available")
        waiter.wait(VolumeIds=[new_volume_id], WaiterConfig={"Delay": 5, "MaxAttempts": 60})

        # Step 3: Delete old volume (after successful creation)
        logger.info(f"Deleting old volume {current_volume_id} from {current_az}")
        ec2_client.delete_volume(VolumeId=current_volume_id)

        logger.info(f"EBS migration completed: {current_volume_id} ({current_az}) -> {new_volume_id} ({target_az})")
        return new_volume_id, snapshot_id

    except Exception as e:
        logger.error(f"Error during EBS migration for user {user_id}: {str(e)}")
        raise


def get_latest_completed_snapshot(user_id, volume_id=None):
    """
    Get the most recent completed snapshot for a user.
    If volume_id provided, gets snapshots for that specific volume.
    Otherwise gets any user snapshot.
    """
    return get_latest_snapshot(user_id, volume_id, include_pending=False)


def restore_ebs_from_existing_snapshot(snapshot_id, target_az, user_id):
    """
    Create new EBS volume from existing snapshot in target AZ.
    Returns volume_id of the restored volume.
    """
    try:
        logger.info(f"Restoring EBS volume from snapshot {snapshot_id} in AZ {target_az}")

        # Create new volume from existing snapshot in target AZ
        new_volume_response = ec2_client.create_volume(
            AvailabilityZone=target_az,
            SnapshotId=snapshot_id,
            VolumeType="gp3",
            Iops=3000,
            Throughput=125,
            TagSpecifications=[{
                "ResourceType": "volume",
                "Tags": [
                    {"Key": "gpu-dev-user", "Value": user_id},
                    {"Key": "Name", "Value": f"gpu-dev-persistent-{user_id.split('@')[0]}"},
                    {"Key": "Project", "Value": "gpu-dev-servers"},
                    {"Key": "ManagedBy", "Value": "gpu-dev-cli"},
                    {"Key": "RestoredFrom", "Value": snapshot_id},
                    {"Key": "RestoredToAZ", "Value": target_az}
                ]
            }]
        )

        new_volume_id = new_volume_response["VolumeId"]
        logger.info(f"Created new volume {new_volume_id}, waiting for availability...")

        # Wait for new volume to be available
        waiter = ec2_client.get_waiter("volume_available")
        waiter.wait(VolumeIds=[new_volume_id], WaiterConfig={"Delay": 5, "MaxAttempts": 60})

        logger.info(f"EBS restore completed: snapshot {snapshot_id} -> volume {new_volume_id} in {target_az}")
        return new_volume_id

    except Exception as e:
        logger.error(f"Error restoring EBS from snapshot {snapshot_id}: {str(e)}")
        raise


def create_or_find_user_efs(user_id: str) -> str:
    """Create or find existing EFS filesystem for user shared storage"""
    try:
        logger.info(f"Looking for existing EFS filesystem for user {user_id}")

        # Check for existing EFS with user tag
        response = efs_client.describe_file_systems()

        for fs in response.get("FileSystems", []):
            fs_id = fs["FileSystemId"]

            # Get tags for this filesystem
            try:
                tags_response = efs_client.describe_tags(FileSystemId=fs_id)
                tags = {tag["Key"]: tag["Value"] for tag in tags_response.get("Tags", [])}

                if tags.get("gpu-dev-user") == user_id:
                    logger.info(f"Found existing EFS {fs_id} for user {user_id}")

                    # Ensure mount target exists
                    ensure_efs_mount_target(fs_id)
                    return fs_id

            except Exception as tag_error:
                logger.warning(f"Could not get tags for EFS {fs_id}: {tag_error}")
                continue

        # Create new EFS filesystem
        logger.info(f"Creating new EFS filesystem for user {user_id}")

        create_response = efs_client.create_file_system(
            CreationToken=f"gpu-dev-{user_id}-{int(time.time())}",
            PerformanceMode="generalPurpose",
            ThroughputMode="provisioned",
            ProvisionedThroughputInMibps=125,  # 125 MiB/s for good performance
            Tags=[
                {"Key": "gpu-dev-user", "Value": user_id},
                {"Key": "Name", "Value": f"gpu-dev-shared-{user_id.split('@')[0]}"},
                {"Key": "Project", "Value": "gpu-dev-servers"},
                {"Key": "ManagedBy", "Value": "gpu-dev-cli"},
            ]
        )

        fs_id = create_response["FileSystemId"]

        # Wait for filesystem to be available
        logger.info(f"Waiting for EFS {fs_id} to become available")

        max_wait = 300  # 5 minutes
        start_time = time.time()

        while time.time() - start_time < max_wait:
            fs_response = efs_client.describe_file_systems(FileSystemId=fs_id)
            fs_state = fs_response["FileSystems"][0]["LifeCycleState"]

            if fs_state == "available":
                logger.info(f"EFS {fs_id} is now available")
                break
            elif fs_state in ["error", "deleted"]:
                raise Exception(f"EFS {fs_id} entered error state: {fs_state}")

            logger.info(f"EFS {fs_id} state: {fs_state}, waiting...")
            time.sleep(10)
        else:
            raise Exception(f"EFS {fs_id} did not become available within {max_wait} seconds")

        # Create mount target
        ensure_efs_mount_target(fs_id)

        # Set up lifecycle policy to move files to cheaper storage after 30 days
        try:
            efs_client.put_lifecycle_configuration(
                FileSystemId=fs_id,
                LifecyclePolicies=[
                    {
                        'TransitionToIA': 'AFTER_30_DAYS',  # Move to Infrequent Access after 30 days (cheaper)
                        'TransitionToPrimaryStorageClass': 'AFTER_1_ACCESS'  # Move back to standard when accessed
                    }
                ]
            )
            logger.info(f"Set lifecycle policy for EFS {fs_id} - files move to IA after 30 days")
        except Exception as lifecycle_error:
            logger.warning(f"Failed to set lifecycle policy for EFS {fs_id}: {lifecycle_error}")
            # Don't fail EFS creation for this

        logger.info(f"Created new EFS filesystem {fs_id} for user {user_id}")
        return fs_id

    except Exception as e:
        logger.error(f"Error creating/finding EFS for user {user_id}: {str(e)}")
        raise


def ensure_efs_mount_target(fs_id: str) -> str:
    """Ensure EFS has mount targets in all configured subnets"""
    try:
        # Check for existing mount targets
        response = efs_client.describe_mount_targets(FileSystemId=fs_id)
        existing_mount_targets = {mt["SubnetId"]: mt for mt in response.get("MountTargets", [])}
        
        created_mount_target_id = None
        
        # Ensure we have mount targets in all subnets
        for subnet_id in EFS_SUBNET_IDS:
            if subnet_id in existing_mount_targets:
                mt = existing_mount_targets[subnet_id]
                if mt["LifeCycleState"] == "available":
                    logger.info(f"Found existing mount target {mt['MountTargetId']} for EFS {fs_id} in subnet {subnet_id}")
                    if created_mount_target_id is None:
                        created_mount_target_id = mt["MountTargetId"]
                    continue
            
            # Create mount target for this subnet
            logger.info(f"Creating mount target for EFS {fs_id} in subnet {subnet_id}")
            
            try:
                create_response = efs_client.create_mount_target(
                    FileSystemId=fs_id,
                    SubnetId=subnet_id,
                    SecurityGroups=[EFS_SECURITY_GROUP_ID]
                )
                
                mount_target_id = create_response["MountTargetId"]
                if created_mount_target_id is None:
                    created_mount_target_id = mount_target_id
                
                # Wait for this mount target to be available
                logger.info(f"Waiting for mount target {mount_target_id} to become available")
                
                max_wait = 180  # 3 minutes
                start_time = time.time()
                
                while time.time() - start_time < max_wait:
                    mt_response = efs_client.describe_mount_targets(MountTargetId=mount_target_id)
                    mt_state = mt_response["MountTargets"][0]["LifeCycleState"]
                    
                    if mt_state == "available":
                        logger.info(f"Mount target {mount_target_id} is now available")
                        break
                    elif mt_state in ["error", "deleted"]:
                        raise Exception(f"Mount target {mount_target_id} entered error state: {mt_state}")
                    
                    logger.info(f"Mount target {mount_target_id} state: {mt_state}, waiting...")
                    time.sleep(10)
                else:
                    raise Exception(f"Mount target {mount_target_id} did not become available within {max_wait} seconds")
                    
            except Exception as e:
                if "MountTargetConflict" in str(e):
                    logger.info(f"Mount target already exists for subnet {subnet_id}, continuing...")
                else:
                    logger.error(f"Error creating mount target in subnet {subnet_id}: {str(e)}")
                    raise
        
        return created_mount_target_id

    except Exception as e:
        logger.error(f"Error ensuring mount targets for EFS {fs_id}: {str(e)}")
        raise


def get_efs_mount_dns(fs_id: str) -> str:
    """Get the DNS name for mounting EFS filesystem"""
    return f"{fs_id}.efs.{REGION}.amazonaws.com"


def trigger_availability_update():
    """Trigger the availability updater Lambda function"""
    try:
        import boto3

        # Get the availability updater function name from environment variable
        # This will be set in the Terraform configuration
        availability_function_name = os.environ.get(
            "AVAILABILITY_UPDATER_FUNCTION_NAME"
        )
        if not availability_function_name:
            logger.warning(
                "AVAILABILITY_UPDATER_FUNCTION_NAME not set, skipping availability update"
            )
            return

        # Create Lambda client and invoke the availability updater
        lambda_client = boto3.client("lambda")

        # Invoke asynchronously to avoid blocking the reservation process
        response = lambda_client.invoke(
            FunctionName=availability_function_name,
            InvocationType="Event",  # Async invocation
            Payload="{}",  # Empty payload, the function will scan all GPU types
        )

        logger.info(
            f"Successfully triggered availability updater function: {availability_function_name}"
        )

    except Exception as e:
        logger.error(f"Failed to trigger availability update: {str(e)}")
        raise


def update_reservation_error(reservation_id: str, error_message: str, error_field: str = "failure_reason") -> None:
    """Update reservation with error message in any error field"""
    try:
        update_reservation_fields(reservation_id, **{error_field: error_message})
        logger.info(f"Updated reservation {reservation_id} with {error_field}: {error_message}")
    except Exception as e:
        logger.error(f"Failed to update reservation {reservation_id} with error: {e}")


def find_reservation_by_prefix(reservation_id: str, user_id: str = None) -> dict:
    """Find reservation by ID prefix with optional user validation"""
    try:
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)

        filter_expression = "begins_with(reservation_id, :prefix)"
        expression_values = {":prefix": reservation_id}

        if user_id:
            filter_expression += " AND user_id = :user_id"
            expression_values[":user_id"] = user_id

        scan_response = reservations_table.scan(
            FilterExpression=filter_expression,
            ExpressionAttributeValues=expression_values
        )

        items = scan_response.get("Items", [])
        if len(items) == 0:
            raise ValueError(f"Reservation {reservation_id} not found" + (f" for user {user_id}" if user_id else ""))
        elif len(items) > 1:
            raise ValueError(f"Ambiguous reservation ID {reservation_id} - found {len(items)} matches")

        return items[0]
    except Exception as e:
        logger.error(f"Error finding reservation {reservation_id}: {e}")
        raise


def handler(event, context):
    """Main Lambda handler"""
    try:
        logger.info(f"Processing event: {json.dumps(event)}")

        # Check if this is a scheduled event for queue processing
        if event.get("source") == "cloudwatch.schedule":
            logger.info("Processing scheduled queue management and ETA updates")
            return process_scheduled_queue_management()

        # Process SQS messages
        for record in event.get("Records", []):
            if record.get("eventSource") == "aws:sqs":
                # CRITICAL: Reset Lambda-wide state between each SQS record to prevent cross-contamination
                # Clear monitoring threads registry to prevent interference between reservations
                logger.info(f"Clearing {len(_monitoring_threads)} monitoring threads from previous processing")
                _monitoring_threads.clear()
                
                # Determine message type and process accordingly
                try:
                    message_body = json.loads(record["body"])
                    message_type = message_body.get("type", "reservation")

                    if message_type == "cancellation":
                        success = process_cancellation_request(record)
                    elif message_body.get("action") in [
                        "enable_jupyter",
                        "disable_jupyter",
                    ]:
                        success = process_jupyter_action(record)
                    elif message_body.get("action") == "add_user":
                        success = process_add_user_action(record)
                    elif message_body.get("action") == "extend_reservation":
                        success = process_extend_reservation_action(record)
                    elif message_body.get("action") == "process_multinode_individual":
                        success = process_multinode_individual_node(message_body)
                    else:
                        success = process_reservation_request(record)

                    # Delete message from queue if processed successfully
                    if success:
                        delete_sqs_message(record)

                except Exception as parse_error:
                    logger.error(f"Error parsing SQS message: {parse_error}")
                    # Don't delete malformed messages - let them go to DLQ
                    continue

        return {
            "statusCode": 200,
            "body": json.dumps({"message": "Processing completed"}),
        }

    except Exception as e:
        logger.error(f"Error processing event: {str(e)}")
        raise


def scan_dynamodb_paginated(table, **scan_kwargs) -> list:
    """Helper function to handle paginated DynamoDB scans"""
    items = []
    response = table.scan(**scan_kwargs)
    items.extend(response.get("Items", []))
    
    while "LastEvaluatedKey" in response:
        scan_kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]
        response = table.scan(**scan_kwargs)
        items.extend(response.get("Items", []))
    
    return items


def process_multinode_reservation_request(reservation_request: dict[str, Any]) -> bool:
    """Process multinode reservation with coordination"""
    try:
        master_reservation_id = reservation_request.get("master_reservation_id")
        node_index = reservation_request.get("node_index", 0)
        total_nodes = reservation_request.get("total_nodes", 1)
        reservation_id = reservation_request.get("reservation_id")
        
        logger.info(f"Processing multinode reservation node {node_index + 1}/{total_nodes}, master_id: {master_reservation_id}")
        
        # Create initial reservation record in DynamoDB with multinode info
        if reservation_id:
            try:
                from datetime import datetime, timedelta
                duration_hours = reservation_request.get("duration_hours", 8)
                # Convert to float for timedelta, then back to Decimal for DynamoDB
                duration_float = float(duration_hours)
                expires_at = (datetime.utcnow() + timedelta(hours=duration_float)).isoformat()
                duration_decimal = Decimal(str(duration_hours))

                initial_record = {
                    "reservation_id": reservation_id,
                    "master_reservation_id": master_reservation_id,
                    "node_index": node_index,
                    "total_nodes": total_nodes,
                    "user_id": reservation_request.get("user_id"),
                    "gpu_count": reservation_request.get("gpu_count", 1),
                    "total_gpu_count": reservation_request.get("total_gpu_count", 1),
                    "gpu_type": reservation_request.get("gpu_type", "a100"),
                    "duration_hours": duration_decimal,
                    "name": reservation_request.get("name", f"Multinode {node_index + 1}/{total_nodes}"),
                    "created_at": reservation_request.get("created_at", datetime.utcnow().isoformat()),
                    "status": "pending",
                    "expires_at": expires_at,
                    "is_multinode": True,
                }

                if reservation_request.get("github_user"):
                    initial_record["github_user"] = reservation_request["github_user"]

                reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
                reservations_table.put_item(Item=initial_record)
                logger.info(f"Created multinode reservation record: {reservation_id}")
            except Exception as record_error:
                logger.error(f"Failed to create multinode reservation record: {record_error}")

        # Check if all nodes in the multinode reservation are ready for coordination
        all_nodes_ready = check_all_multinode_nodes_ready(master_reservation_id, total_nodes)
        
        if not all_nodes_ready:
            logger.info(f"Waiting for other nodes in multinode reservation {master_reservation_id}")
            return True  # Successfully processed, but waiting for coordination
        
        # All nodes are ready - coordinate the multinode reservation
        return coordinate_multinode_reservation(master_reservation_id, total_nodes)
        
    except Exception as e:
        logger.error(f"Error processing multinode reservation: {str(e)}")
        # Update all related nodes to failed status
        if reservation_request.get("master_reservation_id"):
            fail_all_multinode_reservations(reservation_request["master_reservation_id"], str(e))
        return False


def check_all_multinode_nodes_ready(master_reservation_id: str, total_nodes: int) -> bool:
    """Check if all nodes in a multinode reservation are ready for coordination"""
    try:
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        
        # Query all reservations with the same master_reservation_id
        nodes = scan_dynamodb_paginated(
            reservations_table,
            FilterExpression="master_reservation_id = :master_id",
            ExpressionAttributeValues={":master_id": master_reservation_id}
        )
        logger.info(f"Found {len(nodes)} nodes for master reservation {master_reservation_id}, expected {total_nodes}")
        
        # Check if we have all expected nodes
        if len(nodes) < total_nodes:
            return False
            
        # Check if all nodes are in pending status (ready for coordination)
        for node in nodes:
            if node.get("status") != "pending":
                logger.info(f"Node {node.get('reservation_id')} has status {node.get('status')}, not ready for coordination")
                return False
                
        return True
        
    except Exception as e:
        logger.error(f"Error checking multinode readiness: {str(e)}")
        return False


def coordinate_multinode_reservation(master_reservation_id: str, total_nodes: int) -> bool:
    """Coordinate a complete multinode reservation - check resources and create all pods together"""
    try:
        # Acquire coordination lock to prevent concurrent coordinators
        if not acquire_multinode_lock(master_reservation_id):
            logger.info(f"Another coordinator holds the lock for {master_reservation_id}; skipping")
            return True

        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        
        # Get all nodes for this multinode reservation
        nodes = scan_dynamodb_paginated(
            reservations_table,
            FilterExpression="master_reservation_id = :master_id AND #status = :status",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":master_id": master_reservation_id,
                ":status": "pending"
            }
        )
        if len(nodes) != total_nodes:
            logger.error(f"Expected {total_nodes} nodes, found {len(nodes)} for {master_reservation_id}")
            fail_all_multinode_reservations(master_reservation_id, "Incomplete node set")
            return False
            
        # Calculate total GPU requirements
        first_node = nodes[0]
        gpu_type = first_node.get("gpu_type", "a100")
        gpus_per_node = first_node.get("gpu_count", 1)
        total_gpus_needed = gpus_per_node * total_nodes
        
        logger.info(f"Multinode reservation needs {total_gpus_needed} {gpu_type} GPUs ({total_nodes} nodes × {gpus_per_node} GPUs)")
        
        # Check if enough resources are available for the entire multinode reservation
        available_gpus = check_gpu_availability(gpu_type)  
        
        if available_gpus >= total_gpus_needed:
            # Sufficient resources - start parallel processing for all nodes
            logger.info(f"Found resources for {total_nodes} nodes - starting parallel pod creation")
            
            # Release the coordination lock early so individual nodes can process in parallel
            release_multinode_lock(master_reservation_id)
            
            # Process all nodes in parallel using ThreadPoolExecutor
            logger.info(f"Starting parallel processing for {total_nodes} nodes")
            
            def process_single_node(node_data):
                """Process a single node - to be run in parallel"""
                i, node = node_data
                try:
                    reservation_id = node.get("reservation_id")
                    node_index = node.get("node_index", i)
                    
                    message_body = {
                        'reservation_id': str(reservation_id),
                        'action': 'process_multinode_individual', 
                        'node_index': int(node_index),
                        'total_nodes': int(total_nodes),
                        'master_reservation_id': str(master_reservation_id)
                    }
                    
                    logger.info(f"Starting parallel processing for node {reservation_id} ({node_index+1}/{total_nodes})")
                    result = process_multinode_individual_node(message_body)
                    
                    if result:
                        logger.info(f"✓ Successfully processed node {reservation_id} ({node_index+1}/{total_nodes})")
                    else:
                        logger.error(f"✗ Failed to process node {reservation_id} ({node_index+1}/{total_nodes})")
                    
                    return result, reservation_id, node_index
                    
                except Exception as node_error:
                    logger.error(f"✗ Exception processing node {reservation_id}: {node_error}")
                    return False, reservation_id, node_index
            
            # Execute all nodes in parallel
            success_count = 0
            failed_nodes = []
            
            with ThreadPoolExecutor(max_workers=min(total_nodes, 4)) as executor:
                # Submit all node processing tasks
                future_to_node = {
                    executor.submit(process_single_node, (i, node)): node 
                    for i, node in enumerate(nodes)
                }
                
                # Collect results as they complete
                for future in as_completed(future_to_node):
                    success, reservation_id, node_index = future.result()
                    if success:
                        success_count += 1
                    else:
                        failed_nodes.append(f"{reservation_id} (node {node_index+1})")
            
            # Report results
            if success_count == total_nodes:
                logger.info(f"✓ Successfully processed all {total_nodes} nodes in parallel for multinode reservation {master_reservation_id}")
                return True
            else:
                logger.error(f"✗ Failed to process all nodes ({success_count}/{total_nodes} succeeded)")
                logger.error(f"Failed nodes: {', '.join(failed_nodes)}")
                fail_all_multinode_reservations(master_reservation_id, f"Partial processing failure ({success_count}/{total_nodes})")
                return False
        else:
            # Insufficient resources - queue all nodes together
            logger.info(f"Insufficient resources for multinode reservation: need {total_gpus_needed}, available {available_gpus}")
            queue_all_multinode_reservations(master_reservation_id, total_gpus_needed, gpu_type, available_gpus)
            return True
            
    except Exception as e:
        logger.error(f"Error coordinating multinode reservation {master_reservation_id}: {str(e)}")
        fail_all_multinode_reservations(master_reservation_id, str(e))
        return False
    finally:
        try:
            release_multinode_lock(master_reservation_id)
        except Exception as lock_release_error:
            logger.warning(f"Failed to release coordinator lock for {master_reservation_id}: {lock_release_error}")

def process_multinode_individual_node(message_body: dict) -> bool:
    """Process an individual node in a multinode reservation (called asynchronously)"""
    try:
        reservation_id = message_body.get("reservation_id")
        node_index = message_body.get("node_index")
        total_nodes = message_body.get("total_nodes")
        master_reservation_id = message_body.get("master_reservation_id")
        
        logger.info(f"Processing individual multinode node {reservation_id} ({node_index+1}/{total_nodes})")
        
        # Get the reservation data
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        response = reservations_table.get_item(Key={"reservation_id": reservation_id})
        
        if "Item" not in response:
            logger.error(f"Reservation {reservation_id} not found")
            update_multinode_pod_status(reservation_id, "not found", node_index, total_nodes)
            return False
        
        node_data = response["Item"]
        
        # Update status to preparing pod
        update_multinode_pod_status(reservation_id, "preparing pod", node_index, total_nodes)
        
        # Create individual reservation for this node
        created_reservation_id = create_reservation(node_data)
        if not created_reservation_id:
            logger.error(f"Failed to create reservation for node {reservation_id}")
            update_multinode_pod_status(reservation_id, "failed to create", node_index, total_nodes)
            return False
        
        # Update status to allocating resources
        update_multinode_pod_status(reservation_id, "allocating resources", node_index, total_nodes)
        
        # Allocate GPU resources for this node
        allocate_gpu_resources(created_reservation_id, node_data)
        
        # Don't update status here - the main flow will handle setting to "active"
        # update_multinode_pod_status would override the main flow's status
        
        logger.info(f"Successfully processed multinode node {reservation_id} ({node_index+1}/{total_nodes})")
        return True
        
    except Exception as e:
        logger.error(f"Error processing individual multinode node {reservation_id}: {str(e)}")
        if 'reservation_id' in locals() and 'node_index' in locals() and 'total_nodes' in locals():
            update_multinode_pod_status(reservation_id, "processing failed", node_index, total_nodes)
        return False

def acquire_multinode_lock(master_reservation_id: str, ttl_seconds: int = 300) -> bool:
    """Acquire a best-effort coordination lock using the reservations table.
    Uses a conditional put on a special lock item keyed by reservation_id = lock:<master_id>.
    Returns True if acquired, False if already held."""
    try:
        lock_id = f"lock:{master_reservation_id}"
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)

        # Minimal lock item; include numeric expires_at for stale lock takeover and optional TTL
        now_epoch = int(time.time())
        expires_at = now_epoch + ttl_seconds
        reservations_table.put_item(
            Item={
                "reservation_id": lock_id,
                "lock_owner": "coordinator",
                "master_reservation_id": master_reservation_id,
                "created_at": datetime.utcnow().isoformat(),
                "expires_at": expires_at,  # epoch seconds
                "type": "lock",
            },
            ConditionExpression="attribute_not_exists(reservation_id) OR expires_at < :now",
            ExpressionAttributeValues={":now": now_epoch},
        )
        logger.info(f"Acquired coordinator lock {lock_id}")
        return True
    except Exception as e:
        # ConditionalCheckFailedException -> someone else holds the lock
        logger.info(f"Could not acquire lock for {master_reservation_id}: {e}")
        return False

def release_multinode_lock(master_reservation_id: str) -> None:
    """Release the coordination lock (best-effort)."""
    lock_id = f"lock:{master_reservation_id}"
    try:
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        reservations_table.delete_item(Key={"reservation_id": lock_id})
        logger.info(f"Released coordinator lock {lock_id}")
    except Exception as e:
        logger.warning(f"Failed to delete coordinator lock {lock_id}: {e}")


def update_all_multinode_status(master_reservation_id: str, status: str, failure_reason: str = None):
    """Update status for all nodes in a multinode reservation"""
    try:
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        
        # Get all nodes
        nodes = scan_dynamodb_paginated(
            reservations_table,
            FilterExpression="master_reservation_id = :master_id",
            ExpressionAttributeValues={":master_id": master_reservation_id}
        )
        for node in nodes:
            reservation_id = node.get("reservation_id")
            if reservation_id:
                update_reservation_status(reservation_id, status, failure_reason)
                
    except Exception as e:
        logger.error(f"Error updating multinode status: {str(e)}")


def update_multinode_pod_status(reservation_id: str, pod_status: str, node_index: int = None, total_nodes: int = None):
    """Update individual pod status for multinode reservations using unified status tracking"""
    try:
        # Create a detailed pod status message
        if node_index is not None and total_nodes is not None:
            detailed_status = f"Pod {node_index + 1}/{total_nodes}: {pod_status}"
        else:
            detailed_status = pod_status
        
        # Use unified status tracking - keep high-level status as "preparing" during pod setup
        update_reservation_status(reservation_id, "preparing", detailed_status=detailed_status)
        
    except Exception as e:
        logger.error(f"Error updating multinode pod status for {reservation_id}: {str(e)}")


def fail_all_multinode_reservations(master_reservation_id: str, error_message: str):
    """Mark all nodes in a multinode reservation as failed"""
    logger.error(f"Failing all nodes in multinode reservation {master_reservation_id}: {error_message}")
    update_all_multinode_status(master_reservation_id, "failed", error_message)


def queue_all_multinode_reservations(master_reservation_id: str, total_gpus_needed: int, gpu_type: str, available_gpus: int):
    """Queue all nodes in a multinode reservation together"""
    try:
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        
        # Get all nodes
        nodes = scan_dynamodb_paginated(
            reservations_table,
            FilterExpression="master_reservation_id = :master_id",
            ExpressionAttributeValues={":master_id": master_reservation_id}
        )
        
        # Calculate queue position for the entire multinode reservation
        # For simplicity, treat it as one large reservation in the queue
        queue_info = calculate_multinode_queue_position_and_wait_time(
            master_reservation_id, total_gpus_needed, gpu_type, available_gpus
        )
        
        # Update all nodes with the same queue information and set status to "queued"
        for node in nodes:
            reservation_id = node.get("reservation_id")
            if reservation_id:
                update_reservation_with_queue_info(
                    reservation_id,
                    queue_info["position"],
                    queue_info["estimated_wait_minutes"],
                    available_gpus
                )
                # CRITICAL: Set status to "queued" so scheduled Lambda can find these reservations
                update_reservation_status(reservation_id, "queued", queue_info["message"])
                
        logger.info(f"Queued multinode reservation {master_reservation_id} at position {queue_info['position']}")
        
    except Exception as e:
        logger.error(f"Error queuing multinode reservation: {str(e)}")
        fail_all_multinode_reservations(master_reservation_id, str(e))


def calculate_multinode_queue_position_and_wait_time(master_reservation_id: str, total_gpus_needed: int, gpu_type: str, available_gpus: int) -> dict:
    """Calculate queue position and wait time for multinode reservations"""
    try:
        # For multinode, we need to be more conservative in queue calculations
        # since we need ALL resources to be available at once
        
        # Get current queue for this GPU type
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        queued_reservations = scan_dynamodb_paginated(
            reservations_table,
            FilterExpression="#status = :status AND gpu_type = :gpu_type",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":status": "queued",
                ":gpu_type": gpu_type
            }
        )
        
        # Group multinode reservations together and sum their GPU requirements
        queue_position = 1
        total_gpus_ahead = 0
        
        multinode_groups = {}
        single_reservations = []
        
        for reservation in queued_reservations:
            if reservation.get("is_multinode"):
                group_id = reservation.get("master_reservation_id")
                if group_id not in multinode_groups:
                    multinode_groups[group_id] = {
                        "total_gpu_count": reservation.get("total_gpu_count", 0),
                        "created_at": reservation.get("created_at")
                    }
            else:
                single_reservations.append(reservation)
        
        # Sort all reservations by creation time
        all_ahead = []
        
        # Add multinode groups
        for group_id, group_info in multinode_groups.items():
            if group_id != master_reservation_id:  # Don't count ourselves
                all_ahead.append({
                    "gpus": group_info["total_gpu_count"],
                    "created_at": group_info["created_at"]
                })
        
        # Add single reservations  
        for reservation in single_reservations:
            all_ahead.append({
                "gpus": reservation.get("gpu_count", 1),
                "created_at": reservation.get("created_at")
            })
        
        # Sort by creation time
        all_ahead.sort(key=lambda x: x["created_at"])
        
        # Calculate position and GPUs ahead
        for item in all_ahead:
            total_gpus_ahead += item["gpus"]
            queue_position += 1
        
        # Estimate wait time (more conservative for multinode)
        # Assume average reservation duration and add buffer for coordination
        avg_duration_minutes = 4 * 60  # 4 hours average
        multinode_buffer = 1.5  # 50% longer for multinode coordination
        
        if total_gpus_ahead > 0:
            estimated_wait_minutes = int((total_gpus_ahead / max(available_gpus, 1)) * avg_duration_minutes * multinode_buffer)
        else:
            estimated_wait_minutes = 0  # No wait needed if no GPUs ahead in queue
        
        return {
            "position": queue_position,
            "estimated_wait_minutes": estimated_wait_minutes,
            "message": f"Multinode reservation queued - position {queue_position} ({total_gpus_ahead} GPUs ahead)"
        }
        
    except Exception as e:
        logger.error(f"Error calculating multinode queue position: {str(e)}")
        return {
            "position": 999,
            "estimated_wait_minutes": 999,
            "message": f"Queue calculation error: {str(e)}"
        }


def process_reservation_request(record: dict[str, Any]) -> bool:
    """Process individual reservation request"""
    try:
        # Parse the reservation request
        reservation_request = json.loads(record["body"])

        logger.info(f"Processing reservation: {reservation_request}")

        # Check if this is a multinode reservation
        is_multinode = reservation_request.get("is_multinode", False)
        if is_multinode:
            return process_multinode_reservation_request(reservation_request)

        # Create initial reservation record in DynamoDB
        reservation_id = reservation_request.get("reservation_id")
        if reservation_id:
            try:
                # Create initial reservation record with pending status
                from datetime import datetime, timedelta

                duration_hours = reservation_request.get("duration_hours", 8)
                duration_float = float(duration_hours)
                expires_at = (
                    datetime.utcnow() + timedelta(hours=duration_float)
                ).isoformat()

                # Convert duration_hours to Decimal for DynamoDB compatibility
                duration_decimal = Decimal(str(duration_hours))

                initial_record = {
                    "reservation_id": reservation_id,
                    "user_id": reservation_request.get("user_id"),
                    "gpu_count": reservation_request.get("gpu_count", 1),
                    "gpu_type": reservation_request.get("gpu_type", "a100"),
                    "duration_hours": duration_decimal,
                    "name": reservation_request.get(
                        "name",
                        f"{reservation_request.get('gpu_count', 1)}x {reservation_request.get('gpu_type', 'A100').upper()} reservation",
                    ),
                    "created_at": reservation_request.get(
                        "created_at", datetime.utcnow().isoformat()
                    ),
                    "status": "pending",
                    "expires_at": expires_at,
                }

                # Add github_user if provided
                if reservation_request.get("github_user"):
                    initial_record["github_user"] = reservation_request["github_user"]

                # Store initial record
                reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
                reservations_table.put_item(Item=initial_record)

                logger.info(f"Created initial reservation record: {reservation_id}")

            except Exception as record_error:
                logger.error(
                    f"Failed to create initial reservation record: {record_error}"
                )
                # Continue processing even if record creation fails

        # Validate request
        if not validate_reservation_request(reservation_request):
            logger.error(f"Invalid reservation request: {reservation_request}")
            # Let invalid messages go to DLQ by raising an exception
            raise ValueError(f"Invalid reservation request: {reservation_request}")

        # Check availability for the specific GPU type
        gpu_type = reservation_request.get("gpu_type", "a100")
        available_gpus = check_gpu_availability(gpu_type)
        requested_gpus = reservation_request.get("gpu_count", 1)

        if available_gpus >= requested_gpus:
            # Update status to show we're preparing the machine
            reservation_id = reservation_request.get("reservation_id")
            if reservation_id:
                update_reservation_status(
                    reservation_id,
                    "preparing",
                    f"Found {available_gpus} available {gpu_type.upper()} GPUs - preparing resources",
                )

            # Create reservation
            reservation_id = create_reservation(reservation_request)
            logger.info(f"Created reservation: {reservation_id}")

            # Allocate resources (K8s pod creation would go here)
            allocate_gpu_resources(reservation_id, reservation_request)
            return True  # Successfully processed
        else:
            # Insufficient resources - set to queued and let scheduled Lambda handle it
            reservation_id = reservation_request.get("reservation_id")

            if reservation_id:
                # Calculate queue position and estimated wait time
                gpu_type = reservation_request.get("gpu_type", "a100")
                queue_info = calculate_queue_position_and_wait_time(
                    reservation_id, requested_gpus, gpu_type, available_gpus
                )

                # Update reservation with queue information and set to queued status
                update_reservation_with_queue_info(
                    reservation_id,
                    queue_info["position"],
                    queue_info["estimated_wait_minutes"],
                    available_gpus,
                )

                # Provide more specific queued message based on availability
                if available_gpus == 0:
                    queue_message = f"No {gpu_type.upper()} nodes available - position #{queue_info.get('position', '?')} in queue"
                else:
                    queue_message = f"Need {requested_gpus} {gpu_type.upper()} GPUs, only {available_gpus} available - position #{queue_info.get('position', '?')}"

                update_reservation_status(
                    reservation_id,
                    "queued",
                    queue_message,
                )

                logger.info(
                    f"Insufficient resources. Set reservation {reservation_id[:8]} to queued (#{queue_info.get('position', '?')}). Scheduled Lambda will retry."
                )
            else:
                logger.warning("Insufficient resources but no reservation_id found")

            return True  # Delete message - scheduled Lambda will handle queued reservations

    except Exception as e:
        logger.error(f"Error processing reservation request: {str(e)}")

        # Try to update reservation status to failed before raising exception
        try:
            # Try to get reservation_id from the parsed request or record
            reservation_id = None
            try:
                reservation_request = json.loads(record["body"])
                reservation_id = reservation_request.get("reservation_id")
            except Exception:
                pass

            if reservation_id:
                update_reservation_status(
                    reservation_id, "failed", f"Processing error: {str(e)}"
                )
        except Exception as status_error:
            logger.error(f"Failed to update reservation status: {str(status_error)}")

        # Let processing errors (like JSON parsing) go to DLQ
        raise


def validate_reservation_request(request: dict[str, Any]) -> bool:
    """Validate reservation request parameters"""
    required_fields = ["user_id", "gpu_count"]

    for field in required_fields:
        if field not in request:
            logger.error(f"Missing required field: {field}")
            return False

    # Validate GPU count
    gpu_count = request.get("gpu_count", 1)
    if gpu_count not in [1, 2, 4, 8, 16]:  # 16 for 2x8 GPU setup
        logger.error(f"Invalid GPU count: {gpu_count}")
        return False

    # Validate duration
    duration_hours = request.get("duration_hours", DEFAULT_TIMEOUT_HOURS)
    if duration_hours > MAX_RESERVATION_HOURS:
        logger.error(
            f"Duration exceeds maximum: {duration_hours} > {MAX_RESERVATION_HOURS}"
        )
        return False

    return True


def check_gpu_availability(gpu_type: str = None) -> int:
    """Check available GPU capacity using K8s API, optionally filtered by GPU type"""
    try:
        # Set up K8s client
        k8s_client = get_k8s_client()

        if gpu_type:
            # Check for schedulable nodes with specific GPU type
            available_gpus = check_schedulable_gpus_for_type(k8s_client, gpu_type)
            logger.info(f"Schedulable {gpu_type.upper()} GPUs: {available_gpus}")

            # Update availability table with real-time data
            try:
                update_gpu_availability_table(gpu_type, available_gpus, k8s_client)
            except Exception as update_error:
                logger.warning(
                    f"Failed to update availability table for {gpu_type}: {update_error}"
                )
                # Don't fail the reservation processing if availability update fails

            return available_gpus
        else:
            gpu_tracker = K8sGPUTracker(k8s_client)
            capacity_info = gpu_tracker.get_gpu_capacity_info()
            logger.info(
                f"K8s GPU status: {capacity_info['available_gpus']}/{capacity_info['total_gpus']} GPUs available"
            )
            return capacity_info["available_gpus"]

    except Exception as e:
        logger.error(f"Error checking GPU availability from K8s: {str(e)}")
        raise RuntimeError(
            f"Failed to check GPU availability via K8s API: {str(e)}"
        ) from e


def check_schedulable_gpus_for_type(k8s_client, gpu_type: str) -> int:
    """Check how many GPUs are available on schedulable nodes of the specified type"""
    try:
        v1 = client.CoreV1Api(k8s_client)

        # Get all nodes with the specified GPU type that are ready and schedulable
        nodes = v1.list_node()
        schedulable_gpus = 0

        for node in nodes.items:
            # Check if node has the right GPU type label
            node_labels = node.metadata.labels or {}
            if node_labels.get("GpuType") != gpu_type:
                continue

            # Check if node is ready and schedulable
            if not is_node_ready_and_schedulable(node):
                logger.info(
                    f"Node {node.metadata.name} with GPU type {gpu_type} is not ready/schedulable"
                )
                continue

            # Get available GPUs on this node
            node_gpus = get_available_gpus_on_node(v1, node)
            schedulable_gpus += node_gpus
            logger.info(
                f"Node {node.metadata.name}: {node_gpus} available {gpu_type.upper()} GPUs"
            )

        return schedulable_gpus

    except Exception as e:
        logger.error(f"Error checking schedulable GPUs for type {gpu_type}: {str(e)}")
        return 0


def is_node_ready_and_schedulable(node) -> bool:
    """Check if a node is ready and schedulable"""
    # Check if node is ready
    is_ready = False
    if node.status and node.status.conditions:
        for condition in node.status.conditions:
            if condition.type == "Ready" and condition.status == "True":
                is_ready = True
                break

    if not is_ready:
        return False

    # Check if node is schedulable (not cordoned)
    if node.spec and node.spec.unschedulable:
        return False

    # Check for NoSchedule taints that would prevent GPU pods
    if node.spec and node.spec.taints:
        for taint in node.spec.taints:
            if taint.effect == "NoSchedule" and taint.key != "nvidia.com/gpu":
                return False

    return True


def get_available_gpus_on_node(v1_api, node) -> int:
    """Get the number of available GPUs on a specific node"""
    try:
        # Get allocatable GPUs from node status
        allocatable = node.status.allocatable or {}
        total_gpus = int(allocatable.get("nvidia.com/gpu", "0"))

        if total_gpus == 0:
            return 0

        # Get pods running on this node to calculate used GPUs
        field_selector = f"spec.nodeName={node.metadata.name}"
        pods = v1_api.list_pod_for_all_namespaces(field_selector=field_selector)

        used_gpus = 0
        for pod in pods.items:
            if pod.status.phase in ["Running", "Pending"]:
                if pod.spec.containers:
                    for container in pod.spec.containers:
                        if container.resources and container.resources.requests:
                            gpu_request = container.resources.requests.get(
                                "nvidia.com/gpu", "0"
                            )
                            used_gpus += int(gpu_request)

        available_gpus = max(0, total_gpus - used_gpus)
        return available_gpus

    except Exception as e:
        logger.error(
            f"Error getting available GPUs on node {node.metadata.name}: {str(e)}"
        )
        return 0


def update_gpu_availability_table(
    gpu_type: str, available_gpus: int, k8s_client
) -> None:
    """Update the GPU availability table with real-time data from Kubernetes"""
    try:
        # Get total GPUs for this type by checking all nodes with this GPU type
        v1 = client.CoreV1Api(k8s_client)
        nodes = v1.list_node()

        total_gpus = 0
        running_instances = 0

        for node in nodes.items:
            node_labels = node.metadata.labels or {}
            if node_labels.get("GpuType") == gpu_type:
                running_instances += 1
                # Get allocatable GPUs from node status
                allocatable = node.status.allocatable or {}
                node_gpus = int(allocatable.get("nvidia.com/gpu", "0"))
                total_gpus += node_gpus

        # Get GPU configuration for this type (for gpus_per_instance)
        gpu_type_configs = {
            "t4": {"gpus_per_instance": 4},
            "l4": {"gpus_per_instance": 4},
            "a100": {"gpus_per_instance": 8},
            "h100": {"gpus_per_instance": 8},
            "h200": {"gpus_per_instance": 8},
            "b200": {"gpus_per_instance": 8},
        }

        gpu_config = gpu_type_configs.get(gpu_type, {"gpus_per_instance": 8})
        gpus_per_instance = gpu_config["gpus_per_instance"]

        # Update DynamoDB availability table
        import time

        availability_table_name = os.environ.get(
            "AVAILABILITY_TABLE", f"pytorch-gpu-dev-gpu-availability"
        )
        availability_table = dynamodb.Table(availability_table_name)

        availability_table.put_item(
            Item={
                "gpu_type": gpu_type,
                "total_gpus": total_gpus,
                "available_gpus": available_gpus,
                "running_instances": running_instances,
                "desired_capacity": running_instances,  # For EKS, running = desired typically
                "gpus_per_instance": gpus_per_instance,
                "last_updated": "reservation-processor",
                "last_updated_timestamp": int(time.time()),
            }
        )

        logger.info(
            f"Updated availability table for {gpu_type}: {available_gpus}/{total_gpus} GPUs available ({running_instances} instances)"
        )

    except Exception as e:
        logger.error(f"Error updating availability table for {gpu_type}: {str(e)}")
        raise


def create_reservation(request: dict[str, Any]) -> str:
    """Create a new reservation record"""
    try:
        # Use the reservation_id from the CLI request if provided, otherwise generate new one
        reservation_id = request.get("reservation_id", str(uuid.uuid4()))
        now = datetime.utcnow()
        duration_hours = request.get("duration_hours", DEFAULT_TIMEOUT_HOURS)
        duration_float = float(duration_hours)
        expires_at = now + timedelta(hours=duration_float)

        # Convert duration_hours to Decimal for DynamoDB compatibility
        duration_decimal = Decimal(str(duration_hours))

        reservation = {
            "reservation_id": reservation_id,
            "user_id": request["user_id"],
            "gpu_count": request.get("gpu_count", 1),
            "gpu_type": request.get("gpu_type", "a100"),
            "status": "preparing",
            "created_at": request.get("created_at", now.isoformat()),
            "expires_at": expires_at.isoformat(),
            "duration_hours": duration_decimal,
            "pod_name": f"gpu-dev-{reservation_id[:8]}",
            "namespace": "gpu-dev",
            # ssh_command will be set when NodePort service is created with real external access
        }

        # Add optional fields
        if "name" in request:
            reservation["name"] = request["name"]
        if "instance_preference" in request:
            reservation["instance_preference"] = request["instance_preference"]
        if "jupyter_enabled" in request:
            reservation["jupyter_enabled"] = request["jupyter_enabled"]
        if "github_user" in request:
            reservation["github_user"] = request["github_user"]

        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        reservations_table.put_item(Item=reservation)

        logger.info(f"Created reservation record: {reservation_id}")
        return reservation_id

    except Exception as e:
        logger.error(f"Error creating reservation: {str(e)}")
        raise


def allocate_gpu_resources(reservation_id: str, request: dict[str, Any]) -> None:
    """Allocate GPU resources via K8s pod creation"""
    try:
        gpu_count = request.get("gpu_count", 1)
        gpu_type = request.get("gpu_type", "a100")
        user_id = request.get("user_id")
        recreate_env = request.get("recreate_env", False)
        pod_name = f"gpu-dev-{reservation_id[:8]}"
        
        # Check if this is part of a multinode reservation
        is_multinode = request.get("is_multinode", False)
        node_index = request.get("node_index", 0) if is_multinode else None
        total_nodes = request.get("total_nodes", 1) if is_multinode else None

        logger.info(
            f"Allocating {gpu_count}x {gpu_type.upper()} GPUs for reservation {reservation_id}"
        )
        logger.info(f"Pod name: {pod_name}")

        # Update status: Fetching SSH keys (with pod-specific status for multinode)
        if is_multinode:
            update_multinode_pod_status(reservation_id, "fetching SSH keys", node_index, total_nodes)
        update_reservation_status(
            reservation_id,
            "preparing",
            detailed_status=f"Fetching SSH keys for GitHub user {request.get('github_user', user_id)}"
        )

        # Get user's GitHub public key
        github_user = request.get(
            "github_user", user_id
        )
        github_public_key = get_github_public_key(github_user, validate=True)
        if not github_public_key:
            raise ValueError(
                f"Could not fetch GitHub public key for GitHub user '{github_user}'"
            )

        # Check if user should get persistent disk 
        # For multinode: only node 0 gets persistent disk, others get EFS shared storage
        if is_multinode and node_index > 0:
            use_persistent_disk = False  # Only master node gets persistent disk
            logger.info(f"Multinode node {node_index + 1}/{total_nodes}: using EFS shared storage instead of persistent disk")
        else:
            use_persistent_disk = should_use_persistent_disk(user_id, reservation_id)
        persistent_volume_id = None
        device_name = None
        target_az = None  # Initialize target_az for use in connection info update
        is_new_disk = False  # Initialize is_new_disk for all code paths

        # If we're using persistent disk, immediately mark this reservation as having a volume
        # to prevent race conditions with concurrent reservations
        if use_persistent_disk:
            try:
                # Reserve the volume ID slot in DynamoDB immediately to prevent race conditions
                update_reservation_fields(reservation_id, ebs_volume_reserved=True)
                update_reservation_status(reservation_id, "preparing", detailed_status="Reserving persistent disk slot")
                logger.info(f"Reserved persistent disk slot for reservation {reservation_id}")
            except Exception as e:
                logger.error(f"Failed to reserve persistent disk slot: {e}")
                use_persistent_disk = False

        if use_persistent_disk:
            try:
                # Step 1: Determine target AZ for this reservation
                update_reservation_status(
                    reservation_id,
                    "preparing",
                    detailed_status="Determining optimal availability zone for GPU placement"
                )

                target_az = get_target_az_for_reservation(gpu_type, gpu_count)
                if not target_az:
                    raise ValueError(f"Could not determine target AZ for {gpu_type} GPUs")

                logger.info(f"Target AZ for reservation: {target_az}")

                # Step 2: Check if EBS migration is needed
                migration_needed, current_volume_id, current_az = needs_ebs_migration(user_id, target_az)

                if migration_needed:
                    # User has existing EBS in different AZ - need to migrate
                    update_reservation_status(
                        reservation_id,
                        "preparing",
                        f"Migrating persistent disk from {current_az} to {target_az} (2-5 minutes)",
                    )
                    logger.info(f"Starting EBS migration for user {user_id}: {current_az} -> {target_az}")

                    # Check if we have a recent completed or pending snapshot to use instead of creating new one
                    latest_snapshot = get_latest_snapshot(user_id, current_volume_id, include_pending=True)

                    if latest_snapshot and latest_snapshot['State'] == 'completed':
                        # Use existing completed snapshot for migration
                        logger.info(f"Using existing completed snapshot {latest_snapshot['SnapshotId']} for migration")
                        persistent_volume_id = restore_ebs_from_existing_snapshot(
                            latest_snapshot['SnapshotId'], target_az, user_id
                        )
                        snapshot_id = latest_snapshot['SnapshotId']

                        # Clean up old volume after successful restoration
                        try:
                            logger.info(
                                f"Deleting old volume {current_volume_id} from {current_az} after snapshot restoration")
                            ec2_client.delete_volume(VolumeId=current_volume_id)
                            logger.info(f"Successfully deleted old volume {current_volume_id}")
                        except Exception as cleanup_error:
                            logger.warning(f"Failed to delete old volume {current_volume_id}: {cleanup_error}")
                            # Don't fail the migration if cleanup fails - volume can be cleaned up manually
                    elif latest_snapshot and latest_snapshot['State'] == 'pending':
                        # Wait for existing pending snapshot to complete, then use it
                        snapshot_id = latest_snapshot['SnapshotId']
                        logger.info(f"Found pending snapshot {snapshot_id}, waiting for completion before migration")
                        update_reservation_status(
                            reservation_id,
                            "preparing",
                            f"Migrating disk to other AZ using snapshot {snapshot_id} - snapshot pending (can take 5-10min, please retry on timeout)"
                        )

                        # Wait for snapshot to complete (up to 10 minutes)
                        waiter = ec2_client.get_waiter('snapshot_completed')
                        waiter.wait(SnapshotIds=[snapshot_id], WaiterConfig={'Delay': 15, 'MaxAttempts': 40})

                        logger.info(f"Snapshot {snapshot_id} completed, proceeding with migration")
                        persistent_volume_id = restore_ebs_from_existing_snapshot(
                            snapshot_id, target_az, user_id
                        )

                        # Clean up old volume after successful restoration
                        try:
                            logger.info(
                                f"Deleting old volume {current_volume_id} from {current_az} after snapshot restoration")
                            ec2_client.delete_volume(VolumeId=current_volume_id)
                            logger.info(f"Successfully deleted old volume {current_volume_id}")
                        except Exception as cleanup_error:
                            logger.warning(f"Failed to delete old volume {current_volume_id}: {cleanup_error}")
                            # Don't fail the migration if cleanup fails - volume can be cleaned up manually
                    else:
                        # No recent snapshot - do full migration with new snapshot
                        persistent_volume_id, snapshot_id = migrate_ebs_across_az(
                            user_id, current_volume_id, current_az, target_az
                        )

                    is_new_disk = False  # Migrated disk keeps existing data
                    logger.info(f"EBS migration completed: {persistent_volume_id} (from snapshot {snapshot_id})")

                else:
                    # Either no existing EBS, or existing EBS is already in target AZ
                    update_reservation_status(
                        reservation_id,
                        "preparing",
                        "Setting up persistent disk for user data",
                    )
                    persistent_volume_id, is_new_disk = create_or_find_persistent_disk_in_az(user_id, target_az)
                    logger.info(
                        f"Using persistent disk {persistent_volume_id} in {target_az} for user {user_id} (new_disk={is_new_disk})")

            except Exception as disk_error:
                logger.error(f"Failed to set up persistent disk: {disk_error}")
                # Continue without persistent disk rather than failing
                use_persistent_disk = False
                update_reservation_status(
                    reservation_id,
                    "preparing",
                    "Persistent disk setup failed - continuing without persistent storage",
                )
        else:
            logger.info(f"User {user_id} has existing reservations - no persistent disk")
            # Non-persistent reservations always need shell environment setup
            is_new_disk = True
            logger.info("Non-persistent reservation - will always set up shell environment (CREATE_SH_ENV=true)")

        # Set up shared EFS storage for user
        efs_filesystem_id = None
        try:
            if EFS_SECURITY_GROUP_ID and EFS_SUBNET_IDS:
                update_reservation_status(
                    reservation_id,
                    "preparing",
                    "Setting up shared storage (/shared) for user collaboration",
                )
                efs_filesystem_id = create_or_find_user_efs(user_id)
                logger.info(f"EFS filesystem {efs_filesystem_id} ready for user {user_id}")
            else:
                logger.warning("EFS configuration missing - skipping shared storage setup")
        except Exception as efs_error:
            logger.error(f"Failed to set up EFS: {efs_error}")
            # Continue without EFS rather than failing
            efs_filesystem_id = None

        # Update status: Creating Kubernetes resources
        disk_status = "with persistent disk" if use_persistent_disk else "without persistent disk"
        shared_status = "and shared storage" if efs_filesystem_id else ""
        update_reservation_status(
            reservation_id,
            "preparing",
            f"Creating pod {pod_name} with {gpu_count}x {gpu_type.upper()} GPUs {disk_status}{shared_status}",
        )

        # Set up K8s client for resource management
        k8s_client = get_k8s_client()

        # Create Kubernetes pod and services
        jupyter_enabled = request.get("jupyter_enabled", False)
        node_port, jupyter_port = create_kubernetes_resources(
            pod_name=pod_name,
            gpu_count=gpu_count,
            gpu_type=gpu_type,
            github_public_key=github_public_key,
            reservation_id=reservation_id,
            jupyter_enabled=jupyter_enabled,
            persistent_volume_id=persistent_volume_id,
            user_id=user_id,
            is_new_disk=is_new_disk,
            recreate_env=recreate_env,
            efs_filesystem_id=efs_filesystem_id,
            is_multinode=is_multinode,
        )

        # Update status: Pod created, waiting for container to start
        if is_multinode:
            update_multinode_pod_status(reservation_id, "pulling container image", node_index, total_nodes)
        update_reservation_status(
            reservation_id,
            "preparing",
            f"Pod created, downloading container image and starting services",
        )

        # Get node public IP for the specific pod
        node_public_ip = get_pod_node_public_ip(pod_name)

        # Generate SSH command
        ssh_command = f"ssh -p {node_port} dev@{node_public_ip}"

        # Generate Jupyter URL (we'll get the token after pod is ready)
        jupyter_url_base = f"http://{node_public_ip}:{jupyter_port}"

        # Update status: Waiting for SSH service
        update_reservation_status(
            reservation_id,
            "preparing",
            f"Container started, waiting for SSH service on port {node_port}",
        )

        # Wait for SSH service to be fully ready (additional wait beyond pod ready)
        logger.info(
            f"MAIN FLOW: Pod is ready, testing SSH connectivity on {node_public_ip}:{node_port} for reservation {reservation_id}"
        )
        ssh_ready = wait_for_ssh_service(
            k8s_client, pod_name, node_public_ip, node_port, timeout_seconds=180
        )
        
        logger.info(f"MAIN FLOW: SSH connectivity test result for {reservation_id}: ssh_ready={ssh_ready}")

        if ssh_ready:
            # Update reservation with connection details and mark as active
            update_reservation_connection_info(
                reservation_id=reservation_id,
                ssh_command=ssh_command,
                pod_name=pod_name,
                node_port=node_port,
                node_ip=node_public_ip,
                jupyter_port=jupyter_port,
                jupyter_url_base=jupyter_url_base,
                jupyter_enabled=jupyter_enabled,
                k8s_client=k8s_client,
                persistent_volume_id=persistent_volume_id,
                ebs_availability_zone=target_az if use_persistent_disk else None,
            )

            # Trigger availability table update after successful reservation
            try:
                trigger_availability_update()
                logger.info(
                    "Triggered availability table update after successful reservation"
                )
            except Exception as update_error:
                logger.warning(f"Failed to trigger availability update: {update_error}")
                # Don't fail the reservation for this

        else:
            logger.warning(f"MAIN FLOW: SSH connectivity test FAILED for reservation {reservation_id}, checking pod status for errors")
            # Check pod status using our consolidated monitoring function
            pod_info = update_pod_status_and_events(k8s_client, pod_name, reservation_id)
            if pod_info["has_errors"]:
                update_reservation_status(
                    reservation_id,
                    "failed",
                    f"Pod failed to start properly: {pod_info['display_message']}",
                )
                raise RuntimeError(f"Pod failed: {pod_info['display_message']}")
            else:
                # Pod is running but SSH not ready yet - keep as preparing
                # Status message already updated by update_pod_status_and_events
                pass
                logger.warning(
                    f"SSH not ready yet for {pod_name}, keeping reservation in preparing state"
                )

        # GPU allocation handled automatically by K8s scheduler

        logger.info(
            f"Successfully created pod {pod_name} with SSH access on port {node_port}"
        )

    except Exception as e:
        logger.error(f"Error allocating GPU resources: {str(e)}")
        # Update reservation status to failed
        update_reservation_status(
            reservation_id, "failed", f"Resource allocation failed: {str(e)}"
        )
        raise


# Removed update_server_allocation - K8s handles GPU scheduling automatically


def delete_sqs_message(record: dict[str, Any]) -> None:
    """Delete message from SQS queue after successful processing"""
    try:
        receipt_handle = record.get("receiptHandle")
        if receipt_handle:
            sqs_client.delete_message(QueueUrl=QUEUE_URL, ReceiptHandle=receipt_handle)
            logger.info(f"Deleted message from queue: {record.get('messageId')}")
        else:
            logger.warning("No receipt handle found for message deletion")
    except Exception as e:
        logger.error(f"Error deleting SQS message: {str(e)}")


def update_reservation_status(reservation_id: str, status: str, detailed_status: str = None, failure_reason: str = None) -> None:
    """
    Update reservation status with unified status tracking.
    
    Args:
        reservation_id: The reservation ID
        status: High-level status (preparing/active/cancelled/failed)
        detailed_status: Current detailed status message for status history
        failure_reason: Only set when status is 'failed'
    """
    try:
        current_time = datetime.utcnow().isoformat()
        
        # Prepare fields to update
        fields = {
            "status": status
        }
        
        # Add detailed status to history if provided  
        if detailed_status:
            fields["current_detailed_status"] = detailed_status
        
        # Only set failure_reason when actually failing
        if failure_reason and status == "failed":
            fields["failure_reason"] = failure_reason
        
        # Update regular fields first
        update_reservation_fields(reservation_id, **fields)
        
        # Handle status history append atomically if detailed_status provided
        if detailed_status:
            try:
                append_status_history(reservation_id, current_time, detailed_status)
            except Exception as history_error:
                logger.warning(f"Could not append to status history: {history_error}")
        
        log_msg = f"Updated reservation {reservation_id} status to {status}"
        if detailed_status:
            log_msg += f" - {detailed_status}"
        logger.info(log_msg)
        
    except Exception as e:
        logger.error(f"Error updating reservation status: {str(e)}")


def append_status_history(reservation_id: str, timestamp: str, message: str) -> None:
    """Atomically append a status entry to the status_history list using DynamoDB LIST_APPEND"""
    try:
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        
        new_entry = {
            "timestamp": timestamp,
            "message": message
        }
        
        # Use LIST_APPEND to atomically append to the status_history list
        # This handles concurrent writes properly
        try:
            reservations_table.update_item(
                Key={"reservation_id": reservation_id},
                UpdateExpression="SET status_history = list_append(if_not_exists(status_history, :empty_list), :new_entry)",
                ExpressionAttributeValues={
                    ":empty_list": [],
                    ":new_entry": [new_entry]
                }
            )
        except Exception as append_error:
            # If the above fails (rare edge case), fall back to regular SET operation
            logger.warning(f"LIST_APPEND failed, falling back to SET: {append_error}")
            reservations_table.update_item(
                Key={"reservation_id": reservation_id},
                UpdateExpression="SET status_history = :history",
                ExpressionAttributeValues={
                    ":history": [new_entry]
                }
            )
        
        logger.debug(f"Appended status history entry for {reservation_id}: {message}")
        
    except Exception as e:
        logger.error(f"Error appending status history: {str(e)}")
        raise


def update_reservation_fields(reservation_id: str, **fields) -> None:
    """Update arbitrary fields in a reservation record"""
    try:
        if not reservation_id or not fields:
            logger.warning(f"update_reservation_fields called with empty reservation_id={reservation_id} or fields={fields}")
            return

        if not RESERVATIONS_TABLE:
            logger.error(f"RESERVATIONS_TABLE environment variable is not set!")
            return

        if not dynamodb:
            logger.error(f"dynamodb resource is None!")
            return

        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)

        update_expression = "SET last_updated = :timestamp"
        expression_attribute_names = {}
        expression_attribute_values = {":timestamp": int(time.time())}

        for field, value in fields.items():
            # Handle fields that might be reserved keywords
            if field in ["status"]:
                attr_name = f"#{field}"
                expression_attribute_names[attr_name] = field
                update_expression += f", {attr_name} = :{field}"
            else:
                update_expression += f", {field} = :{field}"
            expression_attribute_values[f":{field}"] = value

        logger.debug(f"Updating reservation {reservation_id} with expression: {update_expression}")
        logger.debug(f"Values: {expression_attribute_values}")
        
        # Build update_item parameters - only include ExpressionAttributeNames if needed
        update_params = {
            "Key": {"reservation_id": reservation_id},
            "UpdateExpression": update_expression,
            "ExpressionAttributeValues": expression_attribute_values,
        }
        
        # Only add ExpressionAttributeNames if we have any (don't pass None or empty dict)
        if expression_attribute_names:
            update_params["ExpressionAttributeNames"] = expression_attribute_names
        
        reservations_table.update_item(**update_params)

        logger.info(f"Updated reservation {reservation_id} fields: {list(fields.keys())}")
    except Exception as e:
        logger.error(f"Error updating reservation fields: {str(e)}")


def get_github_public_key(github_username: str, validate: bool = True) -> str:
    """Fetch GitHub public keys for user (all keys)

    Args:
        github_username: GitHub username to fetch keys for
        validate: If True, validate and filter keys to only include valid SSH key formats

    Returns:
        String containing SSH keys (one per line) or None if no keys found
    """
    try:
        import urllib.request

        url = f"https://github.com/{github_username}.keys"
        logger.info(f"Fetching SSH keys for {github_username} from {url}")

        with urllib.request.urlopen(url) as response:
            keys_data = response.read().decode("utf-8").strip()

        if not keys_data:
            logger.error(f"No public SSH keys found for GitHub user {github_username}")
            return None

        if validate:
            # Validate keys format (basic check for ssh-rsa/ssh-ed25519/ssh-ecdsa)
            valid_keys = []
            for line in keys_data.split("\n"):
                line = line.strip()
                if line and (
                    line.startswith("ssh-rsa")
                    or line.startswith("ssh-ed25519")
                    or line.startswith("ssh-ecdsa")
                ):
                    valid_keys.append(line)

            if not valid_keys:
                logger.error(
                    f"No valid SSH keys found for GitHub user {github_username}"
                )
                return None

            logger.info(f"Found {len(valid_keys)} valid SSH keys for {github_username}")
            return "\n".join(valid_keys)
        else:
            return keys_data

    except Exception as e:
        logger.error(f"Error fetching GitHub key for {github_username}: {str(e)}")
        return None


def create_kubernetes_resources(
    pod_name: str,
    gpu_count: int,
    gpu_type: str,
    github_public_key: str,
    reservation_id: str,
    jupyter_enabled: bool = False,
    persistent_volume_id: str = None,
    user_id: str = None,
    is_new_disk: bool = False,
    recreate_env: bool = False,
    efs_filesystem_id: str = None,
    is_multinode: bool = False,
) -> tuple[int, int]:
    """Create Kubernetes pod and NodePort services using Python client"""
    try:
        # Configure Kubernetes client
        k8s_client = get_k8s_client()
        v1 = client.CoreV1Api(k8s_client)

        # Check if pod already exists
        pod_exists = False
        existing_service_port = None

        try:
            existing_pod = v1.read_namespaced_pod(name=pod_name, namespace="gpu-dev")
            pod_exists = True
            pod_phase = existing_pod.status.phase
            logger.info(
                f"Pod {pod_name} already exists (phase: {pod_phase}), checking service..."
            )

            # Check if service exists too
            try:
                existing_service = v1.read_namespaced_service(
                    name=f"{pod_name}-ssh", namespace="gpu-dev"
                )
                existing_service_port = existing_service.spec.ports[0].node_port
                logger.info(
                    f"Service {pod_name}-ssh already exists on port {existing_service_port}"
                )
            except client.exceptions.ApiException as service_error:
                if service_error.status == 404:
                    logger.info(
                        f"Service {pod_name}-ssh does not exist, will create it"
                    )
                else:
                    raise

        except client.exceptions.ApiException as pod_error:
            if pod_error.status != 404:
                raise

        # Check if Jupyter service exists
        existing_jupyter_port = None
        try:
            jupyter_service = v1.read_namespaced_service(
                name=f"{pod_name}-jupyter", namespace="gpu-dev"
            )
            existing_jupyter_port = jupyter_service.spec.ports[0].node_port
        except client.exceptions.ApiException as jupyter_error:
            if jupyter_error.status != 404:
                raise

        # Handle Jupyter port logic
        if jupyter_enabled:
            if pod_exists and existing_service_port and existing_jupyter_port:
                # All resources exist, use existing ports
                node_port = existing_service_port
                jupyter_port = existing_jupyter_port
                logger.info(
                    f"Using existing resources: pod {pod_name}, SSH port {node_port}, Jupyter port {jupyter_port}"
                )
            else:
                # Find available node ports (30000-32767 range)
                node_port = existing_service_port or find_available_node_port(
                    k8s_client
                )
                jupyter_port = existing_jupyter_port or find_available_node_port(
                    k8s_client
                )

                # Ensure SSH and Jupyter use different ports
                while jupyter_port == node_port:
                    jupyter_port = find_available_node_port(k8s_client)

                # Create pod if it doesn't exist
                if not pod_exists:
                    update_reservation_status(
                        reservation_id,
                        "preparing",
                        f"Creating Kubernetes pod {pod_name}",
                    )
                    create_pod(
                        k8s_client,
                        pod_name,
                        gpu_count,
                        gpu_type,
                        github_public_key,
                        jupyter_enabled=True,
                        persistent_volume_id=persistent_volume_id,
                        user_id=user_id,
                        is_new_disk=is_new_disk,
                        recreate_env=recreate_env,
                        efs_filesystem_id=efs_filesystem_id,
                        is_multinode=is_multinode,
                    )
                    logger.info(f"Created new pod {pod_name} with Jupyter")
                    update_reservation_status(
                        reservation_id,
                        "preparing",
                        f"Pod created, waiting for container to download and start",
                    )

                    # Start background monitoring immediately after pod creation
                    if reservation_id not in _monitoring_threads:
                        logger.info(f"Starting background monitoring for newly created pod {pod_name}")
                        monitor_stop_event = start_background_pod_monitoring(k8s_client, pod_name, reservation_id)
                    else:
                        logger.info(f"Background monitoring already exists for reservation {reservation_id}, skipping duplicate")

                # Create SSH service if it doesn't exist
                if not existing_service_port:
                    create_service(k8s_client, pod_name, node_port)
                    logger.info(
                        f"Created new service {pod_name}-ssh on port {node_port}"
                    )

                # Create headless service for multi-node communication
                try:
                    create_headless_service(k8s_client, pod_name)
                except Exception as headless_error:
                    logger.warning(f"Failed to create headless service: {headless_error}")
                    # Don't fail the whole pod creation if headless service fails

                # Create Jupyter service if it doesn't exist
                if not existing_jupyter_port:
                    create_jupyter_service(k8s_client, pod_name, jupyter_port)
                    logger.info(
                        f"Created new service {pod_name}-jupyter on port {jupyter_port}"
                    )
        else:
            # Jupyter disabled - only SSH service needed
            jupyter_port = 0  # No Jupyter port

            if pod_exists and existing_service_port:
                node_port = existing_service_port
                logger.info(
                    f"Using existing resources: pod {pod_name}, SSH port {node_port}"
                )
            else:
                node_port = existing_service_port or find_available_node_port(
                    k8s_client
                )

                # Create pod if it doesn't exist
                if not pod_exists:
                    update_reservation_status(
                        reservation_id,
                        "preparing",
                        f"Creating Kubernetes pod {pod_name}",
                    )
                    create_pod(
                        k8s_client,
                        pod_name,
                        gpu_count,
                        gpu_type,
                        github_public_key,
                        jupyter_enabled=False,
                        persistent_volume_id=persistent_volume_id,
                        user_id=user_id,
                        is_new_disk=is_new_disk,
                        recreate_env=recreate_env,
                        efs_filesystem_id=efs_filesystem_id,
                        is_multinode=is_multinode,
                    )
                    logger.info(f"Created new pod {pod_name} without Jupyter")
                    update_reservation_status(
                        reservation_id,
                        "preparing",
                        f"Pod created, waiting for container to download and start",
                    )

                # Create SSH service if it doesn't exist
                if not existing_service_port:
                    create_service(k8s_client, pod_name, node_port)
                    logger.info(
                        f"Created new service {pod_name}-ssh on port {node_port}"
                    )

                # Create headless service for multi-node communication
                try:
                    create_headless_service(k8s_client, pod_name)
                except Exception as headless_error:
                    logger.warning(f"Failed to create headless service: {headless_error}")
                    # Don't fail the whole pod creation if headless service fails

        # Wait for pod to be ready (regardless of whether it was just created or already existed)
        update_reservation_status(
            reservation_id, "preparing", f"Waiting for pod {pod_name} to become ready"
        )

        # Start background monitoring if not already started (for existing pods)
        # Check global registry to prevent multiple Lambda executions from monitoring the same pod
        if 'monitor_stop_event' not in locals() and reservation_id not in _monitoring_threads:
            logger.info(f"Starting background monitoring for existing pod {pod_name}")
            monitor_stop_event = start_background_pod_monitoring(k8s_client, pod_name, reservation_id)
        elif reservation_id in _monitoring_threads:
            logger.info(f"Background monitoring already active for reservation {reservation_id}, skipping duplicate")

        wait_for_pod_ready(k8s_client, pod_name)  # Remove reservation_id to avoid blocking
        update_reservation_status(
            reservation_id, "preparing", f"Pod is ready, setting up services"
        )

        # Keep background monitoring running - it will track preparation progress but NOT set active status
        # Only the main flow after SSH connectivity test should set active status
        # The monitoring will be stopped later when the reservation is cancelled/expired

        return node_port, jupyter_port

    except Exception as e:
        # Stop monitoring on error too
        if 'monitor_stop_event' in locals():
            logger.info("Stopping background pod monitoring due to error")
            monitor_stop_event.set()

        logger.error(f"Error creating Kubernetes resources: {str(e)}")
        raise


def find_available_node_port(k8s_client) -> int:
    """Find an available NodePort in the valid range"""
    try:
        # Get all services to check used ports
        v1 = client.CoreV1Api(k8s_client)
        services = v1.list_service_for_all_namespaces()

        used_ports = set()
        for svc in services.items:
            if svc.spec.ports:
                for port in svc.spec.ports:
                    if port.node_port:
                        used_ports.add(port.node_port)

        # NodePort range: 30000-32767
        for _ in range(10):  # Try 10 random ports
            port = random.randint(30000, 32767)
            if port not in used_ports:
                return port

        for port in range(30000, 32768):
            if port not in used_ports:
                return port

        raise ValueError("No available NodePort found")

    except Exception as e:
        logger.error(f"Error finding available node port: {str(e)}")
        return random.randint(30000, 32767)


def get_pod_resource_limits(gpu_count: int, gpu_type: str, is_multinode: bool = False) -> dict:
    """Get resource limits for pod based on GPU type and deployment mode"""
    limits = {
        "nvidia.com/gpu": str(gpu_count),
    }
    
    # EFA optimization: Only use EFA for full-node multinode deployments
    # This prevents partial-node reservations from competing for limited EFA resources
    gpu_max_per_node = {
        "t4": 4, "l4": 4, "t4-small": 1,
        "a100": 8, "h100": 8, "h200": 8, "b200": 8
    }
    
    max_gpus = gpu_max_per_node.get(gpu_type, 1)
    use_efa = (
        gpu_type != "t4-small" and  # EFA not supported on t4-small
        is_multinode and            # Only for multinode deployments
        gpu_count == max_gpus       # Only when using all GPUs per node
    )
    
    if use_efa:
        limits["vpc.amazonaws.com/efa"] = "1"
        logger.info(f"Using EFA for multinode full-node deployment: {gpu_count}/{max_gpus} GPUs")
    else:
        logger.info(f"Skipping EFA: multinode={is_multinode}, gpu_count={gpu_count}/{max_gpus}, gpu_type={gpu_type}")
    
    return limits


def get_pod_resource_requests(gpu_count: int, gpu_type: str, is_multinode: bool = False) -> dict:
    """Get resource requests for pod based on GPU type and deployment mode"""
    requests = {
        "nvidia.com/gpu": str(gpu_count),
    }
    
    # EFA optimization: Only use EFA for full-node multinode deployments
    # This prevents partial-node reservations from competing for limited EFA resources
    gpu_max_per_node = {
        "t4": 4, "l4": 4, "t4-small": 1,
        "a100": 8, "h100": 8, "h200": 8, "b200": 8
    }
    
    max_gpus = gpu_max_per_node.get(gpu_type, 1)
    use_efa = (
        gpu_type != "t4-small" and  # EFA not supported on t4-small
        is_multinode and            # Only for multinode deployments
        gpu_count == max_gpus       # Only when using all GPUs per node
    )
    
    if use_efa:
        requests["vpc.amazonaws.com/efa"] = "1"
    
    return requests


def _pod_uses_efa(gpu_count: int, gpu_type: str, is_multinode: bool = False) -> bool:
    """Check if pod will use EFA based on configuration"""
    gpu_max_per_node = {
        "t4": 4, "l4": 4, "t4-small": 1,
        "a100": 8, "h100": 8, "h200": 8, "b200": 8
    }
    
    max_gpus = gpu_max_per_node.get(gpu_type, 1)
    return (
        gpu_type != "t4-small" and  # EFA not supported on t4-small
        is_multinode and            # Only for multinode deployments
        gpu_count == max_gpus       # Only when using all GPUs per node
    )


def get_nccl_env_vars(gpu_type: str) -> list:
    """Get NCCL environment variables for optimal multi-node communication"""
    from kubernetes import client

    env_vars = [
        # Basic NCCL configuration
        client.V1EnvVar(name="NCCL_DEBUG", value="INFO"),
        client.V1EnvVar(name="NCCL_ASYNC_ERROR_HANDLING", value="1"),
        client.V1EnvVar(name="NCCL_SOCKET_IFNAME", value="eth0"),
        # EFA-specific configuration for all GPUs
        client.V1EnvVar(name="FI_PROVIDER", value="efa"),
        client.V1EnvVar(name="NCCL_IB_PCI_RELAXED_ORDERING", value="1"),
        client.V1EnvVar(name="NCCL_CROSS_NIC", value="1"),
        # Use single EFA adapter by default (works for all instance types)
        client.V1EnvVar(name="NCCL_IB_HCA", value="efa0"),
    ]

    return env_vars


def create_pod(
    k8s_client,
    pod_name: str,
    gpu_count: int,
    gpu_type: str,
    github_public_key: str,
    jupyter_enabled: bool = False,
    persistent_volume_id: str = None,
    user_id: str = None,
    is_new_disk: bool = False,
    recreate_env: bool = False,
    efs_filesystem_id: str = None,
    is_multinode: bool = False,
):
    """Create Kubernetes pod with GPU resources and SSH setup"""
    try:
        v1 = client.CoreV1Api(k8s_client)

        # Handle persistent disk setup if provided
        ebs_volume_spec = None
        use_persistent_disk = persistent_volume_id is not None

        if use_persistent_disk:
            logger.info(f"Setting up persistent disk {persistent_volume_id} for pod {pod_name}")

            # Get node instance ID where pod will be scheduled
            # For now, we'll handle this in the container startup script
            # The EBS volume will be attached when pod is scheduled
            ebs_volume_spec = client.V1AWSElasticBlockStoreVolumeSource(
                volume_id=persistent_volume_id,
                fs_type="ext4"
            )
            logger.info(f"Will use EBS volume {persistent_volume_id} for /home/dev")
        else:
            logger.info(f"Using EmptyDir for /home/dev (no persistent disk)")

        # Create pod spec
        pod_spec = client.V1PodSpec(
            restart_policy="Never",
            init_containers=[
                client.V1Container(
                    name="ssh-setup",
                    image="alpine:latest",
                    command=["/bin/sh"],
                    args=[
                        "-c",
                        f"""
                        echo "[INIT] Setting up dev user and SSH keys..."

                        # Create dev user with specific UID for consistency (Alpine uses adduser)
                        adduser -D -u 1000 -s /bin/bash dev

                        # Handle persistent disk setup
                        if [ "{use_persistent_disk}" = "True" ]; then
                            echo "[INIT] Persistent disk detected - checking filesystem..."

                            # Check if /home/dev is mounted (EBS volume)
                            if mountpoint -q /home/dev; then
                                echo "[INIT] EBS volume already mounted at /home/dev"

                                # Check if it has existing user data
                                if [ ! -d "/home/dev/.ssh" ]; then
                                    echo "[INIT] First-time setup - creating SSH directory"
                                    mkdir -p /home/dev/.ssh
                                    chown 1000:1000 /home/dev/.ssh
                                    chmod 700 /home/dev/.ssh
                                fi
                            else
                                echo "[INIT] WARNING: Expected EBS volume not mounted"
                                # Fallback to regular setup
                                mkdir -p /home/dev
                                chown 1000:1000 /home/dev
                            fi
                        else
                            echo "[INIT] No persistent disk - using EmptyDir"
                            # Ensure /home/dev exists for EmptyDir
                            mkdir -p /home/dev
                            chown 1000:1000 /home/dev
                        fi

                        # Set up SSH keys (always refresh)
                        mkdir -p /home/dev/.ssh
                        echo '{github_public_key}' > /home/dev/.ssh/authorized_keys
                        chmod 700 /home/dev/.ssh
                        chmod 600 /home/dev/.ssh/authorized_keys

                        # Ensure proper ownership of entire home directory
                        chown -R 1000:1000 /home/dev

                        # Create marker file to verify init completed
                        echo "SSH keys initialized at $(date)" > /home/dev/.ssh/init_complete

                        echo "[INIT] Dev user and SSH key setup complete"
                        """,
                    ],
                    volume_mounts=[
                        client.V1VolumeMount(name="dev-home", mount_path="/home/dev")
                    ],
                )
            ],
            containers=[
                client.V1Container(
                    name="gpu-dev",
                    image=GPU_DEV_CONTAINER_IMAGE,
                    command=["/bin/bash"],
                    args=[
                        "-c",
                        f"""
                        echo "[STARTUP] Starting GPU development container with pre-installed environment..."

                        # Debug environment variables
                        echo "[STARTUP] Environment variables:"
                        echo "[STARTUP] - CREATE_SH_ENV=$CREATE_SH_ENV"
                        echo "[STARTUP] - JUPYTER_ENABLED=$JUPYTER_ENABLED"
                        echo "[STARTUP] - USE_PERSISTENT_DISK=$USE_PERSISTENT_DISK"

                        echo "[STARTUP] Checking persistent disk setup..."
                        
                        # Check if we have a mounted disk and handle accordingly
                        if mountpoint -q /home/dev && [ "$(df /home/dev | tail -1 | awk '{{print $1}}')" != "tmpfs" ]; then
                            echo "[STARTUP] Real disk mounted at /home/dev"
                            
                            if [ "$USE_PERSISTENT_DISK" = "false" ]; then
                                echo "[STARTUP] WARNING: Since your persistent disk is mounted to your first reservation, this current reservation will NOT store your /home/dev folder."
                                # Set flag for MOTD warning
                                TEMPORARY_DISK_WARNING="true"
                            else
                                echo "[STARTUP] Persistent disk properly configured"
                            fi
                            
                            # Handle disk initialization if needed (CREATE_SH_ENV indicates new disk or recreate)
                            if [ "$CREATE_SH_ENV" = "true" ]; then
                                echo "[STARTUP] New disk setup or recreate requested (CREATE_SH_ENV=true)"
                                
                                # Verify filesystem is accessible and writable
                                if ! touch /home/dev/.test_write 2>/dev/null; then
                                    echo "[STARTUP] Disk not writable - may need formatting"
                                    echo "[STARTUP] WARNING: Disk mount issue - continuing anyway"
                                else
                                    rm -f /home/dev/.test_write
                                    echo "[STARTUP] Disk is accessible and writable"

                                    # Mark as initialized
                                    echo "Initialized at $(date)" > /home/dev/.disk_initialized
                                    chown 1000:1000 /home/dev/.disk_initialized
                                fi
                            else
                                echo "[STARTUP] Using existing disk configuration (CREATE_SH_ENV=false)"
                            fi
                        else
                            echo "[STARTUP] Using EmptyDir (no real persistent disk)"
                        fi

                        echo "[STARTUP] Setting up dev user environment..."
                        # Ensure /home/dev exists and has correct ownership
                        mkdir -p /home/dev

                        # Copy shell configs from Docker image to persistent disk if needed
                        echo "[STARTUP] Shell config setup - CREATE_SH_ENV='$CREATE_SH_ENV'"
                        
                        # List what's available in the source directory
                        echo "[STARTUP] Available files in /devserver-setup:"
                        ls -la /devserver-setup/ || echo "[STARTUP] ERROR: /devserver-setup directory not found!"
                        
                        if [ "$CREATE_SH_ENV" = "true" ]; then
                            echo "[STARTUP] CREATE_SH_ENV=true - Copying shell configurations and user directories to persistent disk..."
                            
                            # Copy pre-built configs from Docker image to persistent disk with error checking
                            echo "[STARTUP] Copying shell configurations from /devserver-setup to /home/dev..."
                            
                            for file in .shell_env .bashrc .bash_profile .profile .zshrc .zprofile; do
                                if [ -f "/devserver-setup/$file" ]; then
                                    echo "[STARTUP] Copying $file..."
                                    if cp "/devserver-setup/$file" "/home/dev/$file"; then
                                        echo "[STARTUP] ✓ Successfully copied $file"
                                    else
                                        echo "[STARTUP] ✗ FAILED to copy $file"
                                    fi
                                else
                                    echo "[STARTUP] ✗ Source file /devserver-setup/$file does not exist"
                                fi
                            done

                            # Copy user directories (npm-global, oh-my-zsh, jupyter) from template
                            echo "[STARTUP] Copying user directories from /devserver-setup..."
                            
                            for directory in npm-global oh-my-zsh jupyter; do
                                if [ -d "/devserver-setup/$directory" ]; then
                                    echo "[STARTUP] Copying $directory directory..."
                                    if cp -r "/devserver-setup/$directory" "/home/dev/.$directory"; then
                                        echo "[STARTUP] ✓ Successfully copied .$directory directory"
                                    else
                                        echo "[STARTUP] ✗ FAILED to copy .$directory directory"
                                    fi
                                else
                                    echo "[STARTUP] ✗ Source directory /devserver-setup/$directory does not exist"
                                fi
                            done

                            # Copy npm configuration file
                            if [ -f "/devserver-setup/.npmrc" ]; then
                                echo "[STARTUP] Copying .npmrc..."
                                if cp "/devserver-setup/.npmrc" "/home/dev/.npmrc"; then
                                    echo "[STARTUP] ✓ Successfully copied .npmrc"
                                else
                                    echo "[STARTUP] ✗ FAILED to copy .npmrc"
                                fi
                            else
                                echo "[STARTUP] ✗ Source file /devserver-setup/.npmrc does not exist"
                            fi

                            echo "[STARTUP] Shell configuration files and user directories copied to persistent disk"

                        else
                            echo "[STARTUP] CREATE_SH_ENV='$CREATE_SH_ENV' - Using existing shell configuration from persistent disk"
                            echo "[STARTUP] Current files in /home/dev:"
                            ls -la /home/dev/.??* 2>/dev/null || echo "[STARTUP] No hidden files found in /home/dev"
                        fi

                        # Ensure correct ownership
                        chown -R dev:dev /home/dev

                        echo "[STARTUP] Setting up shared personal storage..."
                        # Set up /shared-personal directory with proper permissions for user collaboration  
                        if [ -d "/shared-personal" ]; then
                            echo "[STARTUP] /shared-personal directory found - setting up permissions"
                            # Create user-specific directory in shared storage
                            USER_DIR="{user_id.split('@')[0] if user_id else 'default'}"
                            mkdir -p "/shared-personal/$USER_DIR"
                            # Only chown if directory doesn't already belong to dev (avoid slow recursive chown)
                            if [ "$(stat -c %U "/shared-personal/$USER_DIR" 2>/dev/null)" != "dev" ]; then
                                chown dev:dev "/shared-personal/$USER_DIR"
                            fi
                            chmod 755 /shared-personal 2>/dev/null || true
                            echo "[STARTUP] Shared personal storage configured at /shared-personal/$USER_DIR"
                            
                            # Show current usage and add helpful reminder
                            USAGE=$(df -h /shared-personal | tail -1 | awk '{{print $3}}')
                            echo "[STARTUP] Current shared storage usage: $USAGE"
                            echo "[STARTUP] 💡 Reminder: EFS charges per GB used (~$0.30/GB/month)"
                            echo "[STARTUP] 💡 Files move to cheaper storage after 30 days of no access"
                            
                            # Create usage info file for users
                            cat > "/shared-personal/$USER_DIR/README_STORAGE.md" << 'EOFREADME'
# Shared Personal Storage (/shared-personal)

This is your persistent shared storage that survives across reservations.

## Cost Information
- **Standard storage**: ~$0.30/GB/month for frequently accessed files
- **Infrequent Access**: ~$0.0125/GB/month for files not accessed in 30+ days
- **Automatic lifecycle**: Files automatically move to cheaper storage after 30 days

## Usage Tips
- Clean up temporary files and logs regularly
- Use for datasets, models, and important work - not build artifacts
- Check usage with: `df -h /shared-personal`
- Large files (>1GB): Consider compressing when not in active use

## Current Usage
Check with: `du -sh /shared-personal/$USER_DIR`
EOFREADME
                            
                            # Set up dotfiles persistence using pre-built scripts from Docker image
                            if [ -f "/usr/local/bin/setup-dotfiles-persistence" ]; then
                                echo "[STARTUP] Setting up dotfiles persistence..."
                                
                                # Set up environment variable for backup scripts to use
                                USER_ID_CLEAN="{user_id.split('@')[0] if user_id else 'default'}"
                                echo "" >> /home/dev/.bashrc
                                echo 'export GPU_DEV_USER_ID="{user_id or "dev"}"' >> /home/dev/.bashrc
                                echo "" >> /home/dev/.zshrc  
                                echo 'export GPU_DEV_USER_ID="{user_id or "dev"}"' >> /home/dev/.zshrc
                                
                                /usr/local/bin/setup-dotfiles-persistence "$USER_ID_CLEAN" "$USE_PERSISTENT_DISK"
                            else
                                echo "[STARTUP] Dotfiles persistence scripts not found in container"
                            fi
                        else
                            echo "[STARTUP] No /shared-personal directory found - shared storage not available"
                            echo "[STARTUP] Dotfiles persistence not available without shared storage"
                        fi

                        echo "[STARTUP] Setting up dev user..."
                        # Create dev user with zsh as default shell (same UID as init container)
                        id dev &>/dev/null || useradd -u 1000 -m -s /usr/bin/zsh dev
                        # NO password for dev user - passwordless sudo only
                        usermod -aG sudo dev
                        # Allow passwordless sudo for dev user
                        echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev

                        # Clean up any old warning files from previous sessions
                        echo "[STARTUP] Cleaning up old warning files..."
                        rm -f /home/dev/WARN_EXPIRES_IN_*MIN.txt 2>/dev/null || true

                        # Handle lost+found directory (normal for ext4 filesystems)
                        if [ -d "/home/dev/lost+found" ]; then
                            echo "[STARTUP] Hiding lost+found directory (normal for ext4 filesystem)"
                            chattr +h /home/dev/lost+found 2>/dev/null || chmod 700 /home/dev/lost+found
                        fi

                        echo "[STARTUP] Configuring SSH..."
                        mkdir -p /run/sshd
                        mkdir -p /var/run/sshd

                        # Configure SSH daemon - NO password authentication
                        cat > /etc/ssh/sshd_config << 'EOF'
Port 22
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
HostKey /etc/ssh/ssh_host_rsa_key
HostKey /etc/ssh/ssh_host_ecdsa_key
HostKey /etc/ssh/ssh_host_ed25519_key
UsePAM yes
X11Forwarding yes
PrintMotd no
PrintLastLog yes
AcceptEnv LANG LC_*
Subsystem sftp /usr/lib/openssh/sftp-server
EOF

                        # Generate host keys if they don't exist
                        ssh-keygen -A

                        echo "[STARTUP] Setting up dev user home directory..."
                        # Ensure all shell config files have correct ownership
                        chown -R 1000:1000 /home/dev

                        # Verify SSH keys were set up by init container
                        if [ -f /home/dev/.ssh/authorized_keys ]; then
                            echo "[STARTUP] SSH keys found, setting proper ownership"
                            chmod 700 /home/dev/.ssh
                            chmod 600 /home/dev/.ssh/authorized_keys
                        else
                            echo "[STARTUP] WARNING: No SSH keys found from init container!"
                        fi

                        echo "[STARTUP] Setting up MOTD with dynamic storage info..."
                        
                        # Use the existing MOTD from Docker image and append dynamic storage status
                        # Pass storage information to the Docker MOTD script
                        if [ "$TEMPORARY_DISK_WARNING" = "true" ]; then
                            echo "TEMPORARY_DISK_WARNING=true" > /etc/gpu-dev-flags
                        else
                            echo "TEMPORARY_DISK_WARNING=false" > /etc/gpu-dev-flags
                        fi
                        echo "USE_PERSISTENT_DISK=$USE_PERSISTENT_DISK" >> /etc/gpu-dev-flags
                        echo "GPU_DEV_CONTAINER_IMAGE={GPU_DEV_CONTAINER_IMAGE}" >> /etc/gpu-dev-flags
                        
                        # Debug: check if MOTD script exists and is executable
                        echo "[STARTUP] Checking MOTD script..."
                        ls -la /etc/update-motd.d/ || echo "[STARTUP] update-motd.d directory not found"
                        
                        # The Docker image should have the MOTD script, but Lambda startup might have removed it
                        # Let's restore it if missing
                        if [ ! -f /etc/update-motd.d/00-custom ]; then
                            echo "[STARTUP] MOTD script missing, checking if Docker image has a backup..."
                            # Try to find the original MOTD script in the Docker image
                            if [ -f /usr/local/bin/motd_script ] || [ -f /etc/motd_script ]; then
                                echo "[STARTUP] Found backup MOTD script, copying to update-motd.d..."
                                cp /usr/local/bin/motd_script /etc/update-motd.d/00-custom 2>/dev/null || \
                                cp /etc/motd_script /etc/update-motd.d/00-custom 2>/dev/null || \
                                echo "[STARTUP] Could not find backup MOTD script"
                            fi
                        fi
                        
                        # Check if flags file exists and show contents
                        echo "[STARTUP] GPU dev flags:"
                        cat /etc/gpu-dev-flags || echo "No flags file found"
                        
                        # The Docker image already has the MOTD script, just regenerate it with our flags
                        if [ -f /etc/update-motd.d/00-custom ]; then
                            echo "[STARTUP] MOTD script found, making executable..."
                            chmod +x /etc/update-motd.d/00-custom
                            
                            echo "[STARTUP] Testing MOTD script syntax..."
                            if bash -n /etc/update-motd.d/00-custom; then
                                echo "[STARTUP] Syntax OK, executing MOTD script..."
                                echo "[STARTUP] Running: /etc/update-motd.d/00-custom"
                                /etc/update-motd.d/00-custom > /tmp/motd_output.log 2>/tmp/motd_error.log
                                
                                if [ $? -eq 0 ]; then
                                    echo "[STARTUP] ✓ MOTD script executed successfully"
                                    cat /tmp/motd_output.log > /etc/motd
                                    echo "[STARTUP] MOTD content preview:"
                                    head -5 /etc/motd
                                else
                                    echo "[STARTUP] ✗ MOTD execution failed, error log:"
                                    cat /tmp/motd_error.log
                                    echo "[STARTUP] Output log:"
                                    cat /tmp/motd_output.log
                                    echo "Welcome to GPU dev server!" > /etc/motd
                                fi
                            else
                                echo "[STARTUP] ✗ MOTD script has syntax errors, using fallback"
                                echo "Welcome to GPU dev server!" > /etc/motd
                            fi
                        else
                            echo "[STARTUP] ✗ MOTD script not found, using fallback"
                            ls -la /etc/update-motd.d/
                            echo "Welcome to GPU dev server!" > /etc/motd
                        fi

                        echo "[STARTUP] Jupyter Lab pre-installed in Docker image..."

                        # Always create Jupyter config and token (for later use)
                        echo "[STARTUP] Setting up Jupyter Lab configuration..."
                        su - dev -c "mkdir -p ~/.jupyter"

                        # Generate Jupyter config and token (always, regardless of JUPYTER_ENABLED)
                        JUPYTER_TOKEN=$(openssl rand -hex 32)

                        # Create Jupyter config file
                        cat > /home/dev/.jupyter/jupyter_lab_config.py << EOF
c.ServerApp.ip = '0.0.0.0'
c.ServerApp.port = 8888
c.ServerApp.token = '$JUPYTER_TOKEN'
c.ServerApp.password = ''
c.ServerApp.open_browser = False
c.ServerApp.allow_origin = '*'
c.ServerApp.allow_remote_access = True
c.ServerApp.notebook_dir = '/workspace'
c.ServerApp.root_dir = '/workspace'
EOF
                        chown 1000:1000 /home/dev/.jupyter/jupyter_lab_config.py

                        # Store Jupyter token in a file for later retrieval
                        echo "$JUPYTER_TOKEN" > /tmp/jupyter_token
                        chown 1000:1000 /tmp/jupyter_token
                        chmod 600 /tmp/jupyter_token

                        # Only start Jupyter if enabled at creation time
                        if [ "$JUPYTER_ENABLED" = "true" ]; then
                            echo "[STARTUP] Starting Jupyter Lab in background..."
                            nohup su - dev -c "cd /workspace && /opt/conda/bin/jupyter-lab --config=/home/dev/.jupyter/jupyter_lab_config.py" > /tmp/jupyter.log 2>&1 &
                            echo "[STARTUP] Jupyter Lab started (check /tmp/jupyter.log for details)"
                        else
                            echo "[STARTUP] Jupyter Lab configured but not started (use 'gpu-dev edit --enable-jupyter' to enable)"
                        fi

                        # Set up automatic dotfiles backup on container shutdown
                        if [ -d "/shared-personal" ]; then
                            echo "[STARTUP] Setting up automatic dotfiles backup on shutdown..."
                            
                            # Set up signal handler to backup dotfiles on graceful shutdown
                            trap '/usr/local/bin/dotfiles-shutdown-handler; exit 0' TERM INT
                            
                            # Also set up periodic backup every 30 minutes if shared storage is available
                            echo "[STARTUP] Starting periodic backup (every 30 minutes)..."
                            (
                                while true; do
                                    sleep 1800  # 30 minutes
                                    if [ -f /usr/local/bin/backup-dotfiles ]; then
                                        echo "$(date): Performing periodic dotfiles backup..."
                                        su - dev -c "/usr/local/bin/backup-dotfiles" 2>/dev/null || echo "Periodic backup failed"
                                    fi
                                done
                            ) &
                            
                            echo "[STARTUP] ✓ Automatic dotfiles backup configured"
                        fi

                        echo "[STARTUP] Starting SSH daemon..."
                        # Test SSH config first
                        /usr/sbin/sshd -t

                        # Start SSH daemon in foreground
                        echo "[STARTUP] SSH daemon starting on port 22"
                        exec /usr/sbin/sshd -D -e
                        """,
                    ],
                    ports=[
                        client.V1ContainerPort(container_port=22),
                        client.V1ContainerPort(container_port=8888),
                    ],
                    env=[
                        client.V1EnvVar(
                            name="JUPYTER_ENABLED", value=str(jupyter_enabled).lower()
                        ),
                        client.V1EnvVar(
                            name="CREATE_SH_ENV", value=str(is_new_disk or recreate_env).lower()
                        ),
                        client.V1EnvVar(
                            name="USE_PERSISTENT_DISK", value=str(use_persistent_disk).lower()
                        ),
                        client.V1EnvVar(
                            name="GPU_TYPE", value=gpu_type.upper()
                        ),
                        client.V1EnvVar(
                            name="SUPPORTS_EFA", value=str(_pod_uses_efa(gpu_count, gpu_type, is_multinode)).lower()
                        )
                    ] + get_nccl_env_vars(gpu_type),
                    resources=client.V1ResourceRequirements(
                        limits=get_pod_resource_limits(gpu_count, gpu_type, is_multinode),
                        requests=get_pod_resource_requests(gpu_count, gpu_type, is_multinode),
                    ),
                    volume_mounts=[
                        client.V1VolumeMount(name="dev-home", mount_path="/home/dev"),
                        client.V1VolumeMount(
                            name="shared-workspace", mount_path="/workspace"
                        ),
                        client.V1VolumeMount(name="dshm", mount_path="/dev/shm"),
                    ] + ([client.V1VolumeMount(name="shared-efs", mount_path="/shared-personal")] if efs_filesystem_id else []),
                    security_context=client.V1SecurityContext(
                        capabilities=client.V1Capabilities(
                            add=["IPC_LOCK"]
                        )
                    ),
                )
            ],
            volumes=[
                # Dynamic volume based on persistent disk availability
                client.V1Volume(
                    name="dev-home",
                    aws_elastic_block_store=ebs_volume_spec if use_persistent_disk else None,
                    empty_dir=client.V1EmptyDirVolumeSource() if not use_persistent_disk else None
                ),
                client.V1Volume(
                    name="shared-workspace",
                    empty_dir=client.V1EmptyDirVolumeSource(size_limit="500Gi"),
                ),
                client.V1Volume(
                    name="dshm",
                    empty_dir=client.V1EmptyDirVolumeSource(
                        medium="Memory", size_limit="8Gi"),  # Increased for NCCL multi-node
                ),
            ] + ([
                client.V1Volume(
                    name="shared-efs",
                    nfs=client.V1NFSVolumeSource(
                        server=get_efs_mount_dns(efs_filesystem_id),
                        path="/",
                        read_only=False
                    )
                )
            ] if efs_filesystem_id else []),
            node_selector={"GpuType": gpu_type},
            tolerations=[
                client.V1Toleration(
                    key="nvidia.com/gpu", operator="Exists", effect="NoSchedule"
                )
            ],
        )

        # Create pod metadata
        # Build annotations with volume info for snapshot handling
        annotations = {}
        if persistent_volume_id:
            annotations["gpu-dev-volume-id"] = persistent_volume_id
        if user_id:
            annotations["gpu-dev-user-id"] = user_id

        pod_metadata = client.V1ObjectMeta(
            name=pod_name,
            namespace="gpu-dev",
            labels={"app": "gpu-dev-pod", "reservation": pod_name},
            annotations=annotations if annotations else None,
        )

        # Create pod
        pod = client.V1Pod(metadata=pod_metadata, spec=pod_spec)
        v1.create_namespaced_pod(namespace="gpu-dev", body=pod)
        logger.info(f"Created pod {pod_name}")

    except Exception as e:
        logger.error(f"Error creating pod {pod_name}: {str(e)}")
        raise


def create_service(k8s_client, pod_name: str, node_port: int):
    """Create NodePort service for SSH access"""
    try:
        v1 = client.CoreV1Api(k8s_client)

        # Create service spec with Local traffic policy for node-specific access
        service_spec = client.V1ServiceSpec(
            type="NodePort",
            ports=[
                client.V1ServicePort(
                    port=22, target_port=22, node_port=node_port, protocol="TCP"
                )
            ],
            selector={"reservation": pod_name},
            external_traffic_policy="Local",  # Only accessible on the node hosting the pod
        )

        # Create service metadata
        service_metadata = client.V1ObjectMeta(
            name=f"{pod_name}-ssh", namespace="gpu-dev"
        )

        # Create service
        service = client.V1Service(metadata=service_metadata, spec=service_spec)
        v1.create_namespaced_service(namespace="gpu-dev", body=service)

        logger.info(f"Created service {pod_name}-ssh on port {node_port}")

    except Exception as e:
        logger.error(f"Error creating service for {pod_name}: {str(e)}")
        raise


def create_headless_service(k8s_client, pod_name: str):
    """Create headless service for stable DNS resolution between pods"""
    try:
        v1 = client.CoreV1Api(k8s_client)

        # Create headless service spec (ClusterIP: None)
        service_spec = client.V1ServiceSpec(
            type="ClusterIP",
            cluster_ip="None",  # Makes it headless
            ports=[
                client.V1ServicePort(
                    port=29500, target_port=29500, protocol="TCP", name="torch-rendezvous"
                )
            ],
            selector={"reservation": pod_name},
        )

        # Create service metadata
        service_metadata = client.V1ObjectMeta(
            name=f"{pod_name}-headless", namespace="gpu-dev"
        )

        # Create service
        service = client.V1Service(metadata=service_metadata, spec=service_spec)
        v1.create_namespaced_service(namespace="gpu-dev", body=service)

        logger.info(f"Created headless service {pod_name}-headless for multi-node communication")

    except Exception as e:
        logger.error(f"Error creating headless service for {pod_name}: {str(e)}")
        raise


def create_jupyter_service(k8s_client, pod_name: str, jupyter_port: int):
    """Create NodePort service for Jupyter Lab access"""
    try:
        v1 = client.CoreV1Api(k8s_client)

        # Create service spec for Jupyter with Local traffic policy
        service_spec = client.V1ServiceSpec(
            type="NodePort",
            ports=[
                client.V1ServicePort(
                    port=8888, target_port=8888, node_port=jupyter_port, protocol="TCP"
                )
            ],
            selector={"reservation": pod_name},
            external_traffic_policy="Local",  # Only accessible on the node hosting the pod
        )

        # Create service metadata
        service_metadata = client.V1ObjectMeta(
            name=f"{pod_name}-jupyter", namespace="gpu-dev"
        )

        # Create service
        service = client.V1Service(metadata=service_metadata, spec=service_spec)
        v1.create_namespaced_service(namespace="gpu-dev", body=service)

        logger.info(f"Created service {pod_name}-jupyter on port {jupyter_port}")

    except Exception as e:
        logger.error(f"Error creating Jupyter service for {pod_name}: {str(e)}")
        raise


def wait_for_pod_ready(k8s_client, pod_name: str, timeout_seconds: int = 600):
    """Wait for pod to be ready - simplified since background monitoring handles status updates"""
    try:
        v1 = client.CoreV1Api(k8s_client)
        start_time = time.time()
        logger.info(f"Waiting for pod {pod_name} to be ready")

        while time.time() - start_time < timeout_seconds:
            try:
                pod = v1.read_namespaced_pod(name=pod_name, namespace="gpu-dev")

                # Check if pod is ready
                if pod.status.conditions:
                    for condition in pod.status.conditions:
                        if condition.type == "Ready" and condition.status == "True":
                            logger.info(f"Pod {pod_name} is ready")
                            return

                # Check for failed state
                if pod.status.phase == "Failed":
                    raise RuntimeError(f"Pod {pod_name} failed")

            except Exception as e:
                logger.warning(f"Error checking pod status: {str(e)}")

            time.sleep(10)

        raise TimeoutError(
            f"Pod {pod_name} did not become ready within {timeout_seconds} seconds"
        )

    except Exception as e:
        logger.error(f"Error waiting for pod ready: {str(e)}")
        raise


def get_node_public_ip() -> str:
    """Get public IP of EKS node for SSH access"""
    try:
        # Get node information using Kubernetes client
        k8s_client = get_k8s_client()

        v1 = client.CoreV1Api(k8s_client)
        nodes = v1.list_node()

        for node in nodes.items:
            if node.status.addresses:
                for addr in node.status.addresses:
                    if addr.type == "ExternalIP":
                        return addr.address

        instance_id = get_node_instance_id()
        if instance_id:
            response = ec2_client.describe_instances(InstanceIds=[instance_id])
            instance = response["Reservations"][0]["Instances"][0]
            return instance.get("PublicIpAddress", "")

        raise ValueError("Could not determine node public IP")

    except Exception as e:
        logger.error(f"Error getting node public IP: {str(e)}")
        raise


def get_pod_node_public_ip(pod_name: str) -> str:
    """Get public IP of the specific node where a pod is running"""
    try:
        k8s_client = get_k8s_client()
        v1 = client.CoreV1Api(k8s_client)
        
        # Get the pod to find which node it's on
        pod = v1.read_namespaced_pod(name=pod_name, namespace="gpu-dev")
        node_name = pod.spec.node_name
        
        if not node_name:
            logger.warning(f"Pod {pod_name} not scheduled to any node yet")
            return get_node_public_ip()  # Fallback to first available
        
        # Get the specific node's external IP
        node = v1.read_node(name=node_name)
        if node.status.addresses:
            for addr in node.status.addresses:
                if addr.type == "ExternalIP":
                    logger.info(f"Pod {pod_name} is on node {node_name} with IP {addr.address}")
                    return addr.address
        
        logger.warning(f"No external IP found for node {node_name}")
        return get_node_public_ip()  # Fallback
        
    except Exception as e:
        logger.error(f"Error getting pod node IP for {pod_name}: {str(e)}")
        return get_node_public_ip()  # Fallback


def get_node_instance_id() -> str:
    """Get EC2 instance ID of one of the EKS nodes"""
    try:
        k8s_client = get_k8s_client()

        v1 = client.CoreV1Api(k8s_client)
        nodes = v1.list_node()

        for node in nodes.items:
            if node.spec.provider_id:
                provider_id = node.spec.provider_id
                if "aws:///" in provider_id:
                    # Extract instance ID from providerID like "aws:///us-east-2a/i-1234567890abcdef0"
                    return provider_id.split("/")[-1]

        return None

    except Exception as e:
        logger.error(f"Error getting node instance ID: {str(e)}")
        return None


def create_or_find_persistent_disk_in_az(user_id: str, availability_zone: str) -> tuple[str, bool]:
    """Create or find existing persistent disk for user in specific AZ, returns (volume_id, is_new_disk)"""
    try:
        # Use EC2 tags to track user disks
        disk_tag_key = "gpu-dev-user"
        disk_tag_value = user_id

        logger.info(f"Looking for existing persistent disk for user {user_id} in AZ {availability_zone}")

        # Check for existing disk with this user tag in the specified AZ
        response = ec2_client.describe_volumes(
            Filters=[
                {"Name": "tag:gpu-dev-user", "Values": [user_id]},
                {"Name": "availability-zone", "Values": [availability_zone]},
                {"Name": "status", "Values": ["available", "in-use"]},
            ]
        )

        volumes = response.get("Volumes", [])
        if volumes:
            volume_id = volumes[0]["VolumeId"]
            logger.info(f"Found existing persistent disk {volume_id} for user {user_id} in {availability_zone}")
            return volume_id, False  # existing disk

        # Create new 1TB gp3 disk in the specified AZ
        logger.info(f"Creating new 1TB persistent disk for user {user_id} in AZ {availability_zone}")
        create_response = ec2_client.create_volume(
            AvailabilityZone=availability_zone,
            Size=1024,  # 1TB (1024GB)
            VolumeType="gp3",
            Iops=3000,
            Throughput=125,
            TagSpecifications=[
                {
                    "ResourceType": "volume",
                    "Tags": [
                        {"Key": disk_tag_key, "Value": disk_tag_value},
                        {"Key": "Name", "Value": f"gpu-dev-persistent-{user_id.split('@')[0]}"},
                        {"Key": "Project", "Value": "gpu-dev-servers"},
                        {"Key": "ManagedBy", "Value": "gpu-dev-cli"},
                        {"Key": "CreatedInAZ", "Value": availability_zone},
                    ],
                }
            ],
        )

        volume_id = create_response["VolumeId"]

        # Wait for volume to be available
        logger.info(f"Waiting for volume {volume_id} to become available")
        waiter = ec2_client.get_waiter("volume_available")
        waiter.wait(VolumeIds=[volume_id], WaiterConfig={"Delay": 5, "MaxAttempts": 60})

        logger.info(f"Created new persistent disk {volume_id} for user {user_id} in {availability_zone}")
        return volume_id, True  # new disk

    except Exception as e:
        logger.error(f"Error creating/finding persistent disk for user {user_id} in AZ {availability_zone}: {str(e)}")
        raise


def create_or_find_persistent_disk(user_id: str) -> tuple[str, bool]:
    """Create or find existing persistent disk for user, returns (volume_id, is_new_disk)"""
    try:
        # Use EC2 tags to track user disks
        disk_tag_key = "gpu-dev-user"
        disk_tag_value = user_id

        logger.info(f"Looking for existing persistent disk for user {user_id}")

        # Check for existing disk with this user tag
        response = ec2_client.describe_volumes(
            Filters=[
                {"Name": "tag:gpu-dev-user", "Values": [user_id]},
                {"Name": "availability-zone", "Values": [PRIMARY_AVAILABILITY_ZONE]},
                {"Name": "status", "Values": ["available", "in-use"]},
            ]
        )

        volumes = response.get("Volumes", [])
        if volumes:
            volume_id = volumes[0]["VolumeId"]
            logger.info(f"Found existing persistent disk {volume_id} for user {user_id}")
            return volume_id, False  # existing disk

        # Create new 1TB gp3 disk
        logger.info(f"Creating new 1TB persistent disk for user {user_id}")
        create_response = ec2_client.create_volume(
            AvailabilityZone=PRIMARY_AVAILABILITY_ZONE,
            Size=1024,  # 1TB (1024GB)
            VolumeType="gp3",
            Iops=3000,
            Throughput=125,
            TagSpecifications=[
                {
                    "ResourceType": "volume",
                    "Tags": [
                        {"Key": disk_tag_key, "Value": disk_tag_value},
                        {"Key": "Name", "Value": f"gpu-dev-persistent-{user_id.split('@')[0]}"},
                        {"Key": "Project", "Value": "gpu-dev-servers"},
                        {"Key": "ManagedBy", "Value": "gpu-dev-cli"},
                    ],
                }
            ],
        )

        volume_id = create_response["VolumeId"]

        # Wait for volume to be available
        logger.info(f"Waiting for volume {volume_id} to become available")
        waiter = ec2_client.get_waiter("volume_available")
        waiter.wait(VolumeIds=[volume_id], WaiterConfig={"Delay": 5, "MaxAttempts": 60})

        logger.info(f"Created new persistent disk {volume_id} for user {user_id}")
        return volume_id, True  # new disk

    except Exception as e:
        logger.error(f"Error creating/finding persistent disk for user {user_id}: {str(e)}")
        raise


def attach_persistent_disk_to_node(volume_id: str, node_instance_id: str) -> str:
    """Attach EBS volume to EC2 instance, returns device name"""
    try:
        # Find available device name (/dev/xvdf, /dev/xvdg, etc.)
        device_name = "/dev/xvdf"  # Start with /dev/xvdf

        logger.info(f"Attaching volume {volume_id} to instance {node_instance_id} as {device_name}")

        attach_response = ec2_client.attach_volume(
            VolumeId=volume_id,
            InstanceId=node_instance_id,
            Device=device_name,
        )

        # Wait for attachment to complete
        waiter = ec2_client.get_waiter("volume_in_use")
        waiter.wait(VolumeIds=[volume_id], WaiterConfig={"Delay": 5, "MaxAttempts": 60})

        logger.info(f"Successfully attached volume {volume_id} to instance {node_instance_id} as {device_name}")
        return device_name

    except Exception as e:
        logger.error(f"Error attaching volume {volume_id} to instance {node_instance_id}: {str(e)}")
        raise


def get_node_instance_id_for_pod(k8s_client, pod_name: str) -> str:
    """Get EC2 instance ID for the node where pod is scheduled"""
    try:
        v1 = client.CoreV1Api(k8s_client)

        # Get pod to find which node it's scheduled on
        pod = v1.read_namespaced_pod(name=pod_name, namespace="gpu-dev")
        node_name = pod.spec.node_name

        if not node_name:
            raise ValueError(f"Pod {pod_name} is not scheduled to any node")

        # Get node details to find instance ID
        node = v1.read_node(name=node_name)
        provider_id = node.spec.provider_id

        if not provider_id or "aws:///" not in provider_id:
            raise ValueError(f"Node {node_name} has invalid provider ID: {provider_id}")

        # Extract instance ID from providerID like "aws:///us-east-2a/i-1234567890abcdef0"
        instance_id = provider_id.split("/")[-1]

        logger.info(f"Pod {pod_name} is scheduled on node {node_name} (instance {instance_id})")
        return instance_id

    except Exception as e:
        logger.error(f"Error getting instance ID for pod {pod_name}: {str(e)}")
        raise


def should_use_persistent_disk(user_id: str, current_reservation_id: str) -> bool:
    """Check if this user should get a persistent disk (no other active reservations)"""
    try:
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)

        # Check for other active reservations for this user (excluding current one)
        response = reservations_table.query(
            IndexName="UserIndex",
            KeyConditionExpression="user_id = :user_id",
            FilterExpression="#status IN (:active, :preparing, :queued, :pending) AND reservation_id <> :current_id",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":user_id": user_id,
                ":current_id": current_reservation_id,
                ":active": "active",
                ":preparing": "preparing",
                ":queued": "queued",
                ":pending": "pending",
            },
        )

        existing_reservations = response.get("Items", [])

        # Check if any existing reservations actually have a persistent disk or have reserved one
        reservations_with_persistent_disk = [
            res for res in existing_reservations
            if (res.get("ebs_volume_id") and res.get("ebs_volume_id").strip()) or res.get("ebs_volume_reserved") == True
        ]

        # If no other existing reservations have persistent disks, user gets persistent disk
        if not reservations_with_persistent_disk:
            logger.info(f"User {user_id} has no other reservations with persistent disks - will use persistent disk")
            return True
        else:
            persistent_res = reservations_with_persistent_disk[0]
            persistent_res_id = persistent_res.get("reservation_id", "unknown")[:8]
            logger.info(
                f"User {user_id} has existing reservation {persistent_res_id} with persistent disk - no persistent disk for this reservation")
            return False

    except Exception as e:
        logger.error(f"Error checking existing reservations for user {user_id}: {str(e)}")
        # Default to no persistent disk on error
        return False


def get_instance_type_and_gpu_info(k8s_client, pod_name: str) -> tuple[str, str]:
    """Get instance type and GPU type from the node where pod is scheduled"""
    try:
        v1 = client.CoreV1Api(k8s_client)

        # Get pod to find which node it's scheduled on
        pod = v1.read_namespaced_pod(name=pod_name, namespace="gpu-dev")
        node_name = pod.spec.node_name

        if not node_name:
            return "unknown", "unknown"

        # Get node details to find instance type
        node = v1.read_node(name=node_name)
        instance_type = node.metadata.labels.get(
            "node.kubernetes.io/instance-type", "unknown"
        )

        # Map instance type to GPU type
        gpu_type_mapping = {
            "g4dn.xlarge": "T4",
            "g4dn.2xlarge": "T4",
            "g4dn.4xlarge": "T4",
            "g4dn.8xlarge": "T4",
            "g4dn.12xlarge": "T4",
            "g4dn.16xlarge": "T4",
            "g6.12xlarge": "L4",
            "g6.16xlarge": "L4",
            "g6.24xlarge": "L4",
            "p4d.24xlarge": "A100",
            "p5.48xlarge": "H100",
            "p5e.48xlarge": "H200",
            "p5en.48xlarge": "H200",
            "p6-b200.48xlarge": "B200",
        }

        gpu_type = gpu_type_mapping.get(instance_type, "Unknown")

        logger.info(
            f"Pod {pod_name} scheduled on node {node_name} with instance type {instance_type} (GPU: {gpu_type})"
        )
        return instance_type, gpu_type

    except Exception as e:
        logger.error(f"Error getting instance type for pod {pod_name}: {e}")
        return "unknown", "unknown"


def get_jupyter_token_from_pod(k8s_client, pod_name: str) -> str:
    """Retrieve Jupyter token from pod's token file"""
    try:
        v1 = client.CoreV1Api(k8s_client)

        # Execute command to read the token file
        exec_command = [
            "/bin/bash",
            "-c",
            'cat /tmp/jupyter_token 2>/dev/null || echo "TOKEN_NOT_READY"',
        ]

        resp = stream(
            v1.connect_get_namespaced_pod_exec,
            pod_name,
            "gpu-dev",
            command=exec_command,
            stderr=True,
            stdin=False,
            stdout=True,
            tty=False,
        )

        token = resp.strip()
        if token == "TOKEN_NOT_READY" or not token:
            logger.warning(f"Jupyter token not ready yet for pod {pod_name}")
            return None

        logger.info(f"Retrieved Jupyter token from pod {pod_name}")
        return token

    except Exception as e:
        logger.error(f"Error getting Jupyter token from pod {pod_name}: {str(e)}")
        return None


def update_reservation_connection_info(
    reservation_id: str,
    ssh_command: str,
    pod_name: str,
    node_port: int,
    node_ip: str,
    jupyter_port: int,
    jupyter_url_base: str,
    jupyter_enabled: bool = False,
    k8s_client=None,
    persistent_volume_id: str = None,
    ebs_availability_zone: str = None,
):
    """Update reservation with connection details and set proper expiration time"""
    logger.info(f"MAIN FLOW: Starting to update connection info for reservation {reservation_id} (pod: {pod_name})")
    try:
        from datetime import datetime, timedelta

        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)

        # Get the original reservation to find the duration
        response = reservations_table.get_item(Key={"reservation_id": reservation_id})
        if "Item" not in response:
            raise ValueError(f"Reservation {reservation_id} not found")

        reservation = response["Item"]
        duration_hours = float(
            reservation.get("duration_hours", 2)
        )  # Default 2 hours if not found

        # Set expiration time from NOW (when reservation becomes active)
        now = datetime.utcnow()
        duration_float = float(duration_hours)
        expires_at = (now + timedelta(hours=duration_float)).isoformat()
        launched_at = now.isoformat()

        # Get instance type and GPU type info
        if k8s_client is None:
            k8s_client = get_k8s_client()
        instance_type, gpu_type = get_instance_type_and_gpu_info(k8s_client, pod_name)

        # Get Jupyter token from pod and verify Jupyter is actually running
        jupyter_token = get_jupyter_token_from_pod(k8s_client, pod_name)

        # If Jupyter was supposed to be enabled, verify it's actually running
        actual_jupyter_enabled = jupyter_enabled
        jupyter_error_msg = ""

        if jupyter_enabled:
            try:
                # Check if Jupyter process is running
                from kubernetes.stream import stream

                v1 = client.CoreV1Api(k8s_client)

                check_resp = stream(
                    v1.connect_get_namespaced_pod_exec,
                    pod_name,
                    "gpu-dev",
                    command=["pgrep", "-f", "jupyter"],
                    stderr=True,
                    stdin=False,
                    stdout=True,
                    tty=False,
                )

                if not check_resp.strip():
                    # Jupyter not running, check why
                    log_resp = stream(
                        v1.connect_get_namespaced_pod_exec,
                        pod_name,
                        "gpu-dev",
                        command=["cat", "/tmp/jupyter.log"],
                        stderr=True,
                        stdin=False,
                        stdout=True,
                        tty=False,
                    )

                    actual_jupyter_enabled = False
                    jupyter_error_msg = (
                        f"Jupyter failed to start: {log_resp.strip()[:200]}"
                    )
                    logger.warning(
                        f"Jupyter was requested but failed to start in pod {pod_name}: {jupyter_error_msg}"
                    )

            except Exception as jupyter_check_error:
                logger.warning(
                    f"Could not verify Jupyter status in pod {pod_name}: {jupyter_check_error}"
                )
                # Keep original state if we can't check

        jupyter_url = (
            f"{jupyter_url_base}?token={jupyter_token}"
            if jupyter_token and actual_jupyter_enabled
            else jupyter_url_base
        )

        # Prepare fields to update
        update_fields = {
            "ssh_command": ssh_command,
            "pod_name": pod_name,
            "node_port": node_port,
            "node_ip": node_ip,
            "expires_at": expires_at,
            "launched_at": launched_at,
            "namespace": "gpu-dev",
            "instance_type": instance_type,
            "gpu_type": gpu_type,
            "jupyter_port": jupyter_port,
            "jupyter_url": jupyter_url,
            "jupyter_token": jupyter_token or "",
            "jupyter_enabled": actual_jupyter_enabled,
            "status": "active",
        }

        # Add EBS persistent disk information if available
        if persistent_volume_id:
            update_fields["ebs_volume_id"] = persistent_volume_id
            update_fields["ebs_volume_reserved"] = False  # Clear reservation flag once volume is attached

        if ebs_availability_zone:
            update_fields["ebs_availability_zone"] = ebs_availability_zone

        # Add Jupyter error message if there was one
        if jupyter_error_msg:
            update_fields["jupyter_error"] = jupyter_error_msg

        # Update all fields at once
        update_reservation_fields(reservation_id, **update_fields)
        logger.info(
            f"MAIN FLOW: Successfully updated reservation {reservation_id} with connection info and set status=active, expires_at={expires_at}"
        )

    except Exception as e:
        logger.error(f"Error updating reservation connection info: {str(e)}")
        raise


def calculate_queue_position_and_wait_time(
    reservation_id: str, requested_gpus: int, gpu_type: str, available_gpus: int
) -> dict:
    """Calculate queue position and estimated wait time for a reservation"""
    try:
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)

        # Get all active reservations to calculate expiry times
        active_response = reservations_table.query(
            IndexName="StatusIndex",
            KeyConditionExpression="#status = :status",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":status": "active"},
        )
        active_reservations = active_response.get("Items", [])

        # Get all queued/pending reservations for this GPU type
        queued_reservations = []
        for status in ["queued", "pending"]:
            response = reservations_table.query(
                IndexName="StatusGpuTypeIndex",
                KeyConditionExpression="#status = :status AND gpu_type = :gpu_type",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={":status": status, ":gpu_type": gpu_type},
            )
            queued_reservations.extend(response.get("Items", []))

        # Sort queued reservations by creation time to determine position
        queued_reservations.sort(key=lambda x: x.get("created_at", ""))

        # Find position of current reservation
        queue_position = 1
        for i, reservation in enumerate(queued_reservations):
            if reservation["reservation_id"] == reservation_id:
                queue_position = i + 1
                break

        # Use K8s GPU tracker for more accurate wait time estimation
        try:
            k8s_client = get_k8s_client()
            gpu_tracker = K8sGPUTracker(k8s_client)
            wait_estimate = gpu_tracker.estimate_wait_time(
                requested_gpus, active_reservations
            )
            estimated_wait_minutes = wait_estimate.get("estimated_wait_minutes", 30)
        except Exception as e:
            logger.warning(f"Could not get K8s wait estimate: {e}")
            estimated_wait_minutes = (
                queue_position * 15
            )  # 15 minutes per position estimate

        return {
            "position": queue_position,
            "estimated_wait_minutes": estimated_wait_minutes,
            "total_queued": len(queued_reservations),
            "available_gpus": available_gpus,
        }

    except Exception as e:
        logger.error(f"Error calculating queue position: {e}")
        return {
            "position": "?",
            "estimated_wait_minutes": "?",
            "total_queued": 0,
            "available_gpus": available_gpus,
        }


def update_reservation_with_queue_info(
    reservation_id: str,
    queue_position: str,
    estimated_wait_minutes: str,
    available_gpus: int,
):
    """Update reservation with queue position and wait time information"""
    try:
        update_reservation_fields(
            reservation_id,
            queue_position=queue_position if queue_position != "?" else None,
            estimated_wait_minutes=estimated_wait_minutes if estimated_wait_minutes != "?" else None,
            available_gpus=available_gpus,
            last_queue_update=datetime.utcnow().isoformat(),
        )
        logger.info(
            f"Updated reservation {reservation_id} with queue info: pos={queue_position}, wait={estimated_wait_minutes}min"
        )

    except Exception as e:
        logger.error(f"Error updating reservation queue info: {str(e)}")


def start_background_pod_monitoring(k8s_client, pod_name: str, reservation_id: str) -> threading.Event:
    """Start background pod monitoring that updates reservation status continuously"""

    stop_event = threading.Event()

    def monitor_loop():
        """Background monitoring loop"""
        logger.info(f"Started background monitoring for pod {pod_name}")

        while not stop_event.is_set():
            try:
                pod_status = update_pod_status_and_events(k8s_client, pod_name, reservation_id)
                
                # Check if reservation was terminated (cancelled/failed/expired)
                if pod_status.get("terminated", False):
                    logger.info(f"Reservation {reservation_id} terminated, stopping monitoring")
                    break

                # Wait 1 second or until stop signal  
                if stop_event.wait(1):
                    break

            except Exception as e:
                logger.warning(f"Background pod monitoring error: {e}")
                # Continue monitoring even if one update fails
                if stop_event.wait(5):
                    break

        logger.info(f"Stopped background monitoring for pod {pod_name}")
        # Clean up from global registry
        if reservation_id in _monitoring_threads:
            del _monitoring_threads[reservation_id]

    # Start monitoring thread
    thread = threading.Thread(target=monitor_loop, daemon=True)
    thread.start()
    
    # Register in global registry for cancellation cleanup
    _monitoring_threads[reservation_id] = stop_event
    logger.info(f"Registered monitoring thread for reservation {reservation_id}")

    return stop_event


def update_pod_status_and_events(k8s_client, pod_name: str, reservation_id: str) -> dict:
    """
    Consolidated function to monitor pod events and logs, updating reservation table.
    This is the single source of truth for pod monitoring.
    Returns dict with current status info for immediate use.
    """
    try:
        v1 = client.CoreV1Api(k8s_client)

        # Get pod object
        try:
            pod = v1.read_namespaced_pod(name=pod_name, namespace="gpu-dev")
            pod_phase = pod.status.phase
            logger.debug(f"Pod {pod_name} phase: {pod_phase}")
        except client.exceptions.ApiException as e:
            if e.status == 404:
                # Before updating status, check if reservation was already cancelled
                # This prevents race condition where monitoring thread continues after cancellation
                try:
                    reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
                    current_reservation = reservations_table.get_item(
                        Key={"reservation_id": reservation_id}
                    ).get("Item", {})
                    
                    current_status = current_reservation.get("status", "unknown")
                    if current_status in ["cancelled", "failed", "expired"]:
                        logger.info(f"Pod {pod_name} not found, but reservation {reservation_id} is already {current_status} - skipping status update")
                        return {
                            "phase": "Terminated",
                            "display_message": f"Reservation {current_status}",
                            "has_errors": False,
                            "is_ready": False,
                            "terminated": True
                        }
                except Exception as status_check_error:
                    logger.warning(f"Could not check reservation status: {status_check_error}")
                
                logger.warning(f"Pod {pod_name} not found yet, setting pending status")
                update_reservation_status(reservation_id, "preparing", detailed_status="⏳ Pod creation pending")
                return {
                    "phase": "Pending",
                    "display_message": "⏳ Pod creation pending",
                    "has_errors": False,
                    "is_ready": False
                }
            else:
                raise

        # Get pod events (scheduling, volume issues, etc.)
        events = v1.list_namespaced_event(
            namespace="gpu-dev",
            field_selector=f"involvedObject.name={pod_name}"
        )

        # Get pod logs (startup progress)
        try:
            logs = v1.read_namespaced_pod_log(
                name=pod_name, namespace="gpu-dev", tail_lines=50
            )
        except Exception:
            logs = ""

        # Parse events into user-friendly messages
        event_message = ""
        logger.info(f"Found {len(events.items)} events for pod {pod_name}")

        if events.items:
            # Sort events by timestamp, handling None values
            def get_event_timestamp(event):
                timestamp = event.last_timestamp or event.first_timestamp
                if timestamp is None:
                    # Return epoch time for None timestamps so they sort to the end
                    from datetime import datetime, timezone
                    return datetime(1970, 1, 1, tzinfo=timezone.utc)
                return timestamp

            sorted_events = sorted(events.items, key=get_event_timestamp, reverse=True)
            logger.info(
                f"Latest events for {pod_name}: {[(e.reason, e.type, e.message[:50]) for e in sorted_events[:3]]}")

            for event in sorted_events[:3]:  # Check last 3 events
                event_type = event.type
                reason = event.reason
                message = event.message

                if event_type == "Warning":
                    if "FailedAttachVolume" in reason:
                        event_message = f"❌ Volume attachment failed: {message[:60]}..."
                        break
                    elif "FailedScheduling" in reason:
                        # Extract resource info from scheduling message
                        if "nodes are available" in message:
                            import re
                            match = re.search(r'(\d+)/(\d+) nodes are available', message)
                            if match:
                                available, total = match.groups()
                                event_message = f"⏳ Waiting for resources ({available}/{total} nodes available)"
                                break
                        event_message = f"⏳ Scheduling: {message[:60]}..."
                        break
                    elif "FailedMount" in reason and "kube-api-access" in message:
                        # kube-api-access mount failures are commonly transient in EKS - don't fail immediately
                        event_message = f"⏳ Setting up pod access (transient)..."
                        break
                    elif "Failed" in reason:
                        event_message = f"❌ {reason}: {message[:50]}..."
                        break
                elif event_type == "Normal":
                    if reason == "Scheduled":
                        node_name = message.split(" to ")[-1] if " to " in message else "node"
                        event_message = f"✅ Pod scheduled to {node_name[:20]}"
                    elif reason == "Pulling":
                        # Extract image name for better status
                        if "image" in message:
                            image_part = message.split('"')[1] if '"' in message else "image"
                            # Simplify long image names
                            if "ecr" in image_part:
                                image_name = "GPU dev container"
                            elif "alpine" in image_part:
                                image_name = "alpine"
                            else:
                                image_name = image_part.split("/")[-1].split(":")[0]
                            event_message = f"📥 Pulling {image_name} image..."
                        else:
                            event_message = "📥 Pulling container image..."
                    elif reason == "Pulled":
                        event_message = "✅ Container image pulled"
                    elif reason == "Created":
                        event_message = "🏗️ Container created"
                    elif reason == "Started":
                        event_message = "🚀 Container started"

        # Parse startup logs for container initialization progress
        startup_message = ""
        if logs and "[STARTUP]" in logs:
            startup_patterns = {
                "Starting GPU development container": "Starting container setup",
                "Checking persistent disk setup": "Checking disk setup",
                "Real disk mounted": "✓ Persistent disk mounted",
                "Using EmptyDir": "Using temporary storage",
                "Setting up dev user environment": "Setting up user environment",
                "Shell config setup": "Configuring shell environment",
                "Copying shell configurations": "Copying shell configs",
                "✓ Successfully copied": "✓ Shell configs copied",
                "✗ FAILED to copy": "✗ Failed to copy shell configs",
                "Setting up shared personal storage": "Setting up shared storage",
                "SSH daemon starting": "✓ SSH daemon ready",
                "ERROR:": "❌ Setup error occurred"
            }

            lines = logs.split('\n')
            startup_lines = [line for line in lines if "[STARTUP]" in line]
            
            # Debug startup log parsing
            logger.info(f"Startup lines found: {len(startup_lines)}")
            if startup_lines:
                logger.info(f"Last 5 startup lines: {startup_lines[-5:]}")

            for line in reversed(startup_lines[-5:]):  # Check last 5 startup lines
                for pattern, display in startup_patterns.items():
                    if pattern in line:
                        if "ERROR:" in line or "FAILED" in line:
                            try:
                                error_part = line.split("[STARTUP]", 1)[1].strip()
                                startup_message = f"❌ Setup error: {error_part[:50]}"
                            except:
                                startup_message = display
                        else:
                            startup_message = display
                        break
                if startup_message:
                    break

        # Determine priority message to display
        display_message = ""
        if event_message and ("❌" in event_message or "⏳" in event_message):
            # Prioritize error/scheduling events
            display_message = event_message
        elif startup_message:
            # Show startup progress
            display_message = startup_message
        elif event_message:
            # Show normal events
            display_message = event_message
        else:
            # Fallback based on phase
            if pod_phase == "Pending":
                display_message = "⏳ Pod pending"
            elif pod_phase == "Running":
                display_message = "🚀 Container running"
            else:
                display_message = f"Pod phase: {pod_phase}"

        # Check current reservation status to avoid duplicate updates AND prevent race conditions
        try:
            reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
            current_reservation = reservations_table.get_item(
                Key={"reservation_id": reservation_id}
            ).get("Item", {})
            
            current_status = current_reservation.get("status", "")
            current_pod_events = current_reservation.get("pod_events", "")
            current_pod_status = current_reservation.get("pod_status", "")
            status_updated_at = current_reservation.get("status_updated_at")
            
            # CRITICAL: If reservation has been cancelled or failed, don't override it
            # Also check for cancellation markers (cancelled_at field exists)
            cancelled_at = current_reservation.get("cancelled_at")
            if current_status in ["cancelled", "failed"] or cancelled_at:
                effective_status = current_status if current_status in ["cancelled", "failed"] else "cancelled"
                logger.info(f"Skipping pod status update for {pod_name} - reservation is {effective_status} (cancelled_at: {cancelled_at})")
                
                # If status field doesn't match cancellation state, fix it
                if current_status not in ["cancelled", "failed"] and cancelled_at:
                    logger.info(f"Correcting status from '{current_status}' to 'cancelled' for reservation {reservation_id}")
                    update_reservation_fields(reservation_id, status="cancelled")
                
                return {
                    "phase": pod_phase,
                    "display_message": f"Reservation {effective_status}",
                    "has_errors": False,
                    "is_ready": False
                }
            
            # Only update if status actually changed
            status_changed = (
                display_message != current_pod_events or 
                pod_phase != current_pod_status
            )
            
        except Exception as e:
            logger.warning(f"Could not fetch current reservation status: {e}")
            status_changed = True  # Update anyway if we can't check

        # Update reservation table with current status using unified status tracking
        update_fields = {}
        if logs:
            update_fields["pod_logs"] = logs
        
        if status_changed:
            # Calculate status flags first
            # Don't treat transient kube-api-access issues as errors
            has_errors = "❌" in display_message and "transient" not in display_message
            
            # CRITICAL: Background monitoring should NOT set "active" status initially
            # Only the main flow after SSH connectivity test should set "active"
            # Background monitoring only tracks preparation progress and maintains existing active status
            
            if current_status == "active":
                high_level_status = "active"  # Always maintain active status
                logger.info(f"Reservation {reservation_id} already active - maintaining status")
            else:
                # Background monitoring can only set "preparing" - never "active"
                # The lock mechanism prevents race conditions with main flow
                high_level_status = "preparing" if pod_phase != "Running" else "preparing"
                logger.info(f"Pod preparation status for {pod_name}: pod_phase={pod_phase}")
            
            failure_reason = None
            
            # Check for failure conditions
            if has_errors or pod_phase == "Failed":
                high_level_status = "failed"
                failure_reason = display_message
                
            # Debug the final status decision
            logger.info(f"Final status decision for {pod_name}: high_level_status={high_level_status}, display_message='{display_message}'")
                
            if display_message:
                # Use unified status tracking
                update_reservation_status(
                    reservation_id, 
                    high_level_status, 
                    detailed_status=display_message,
                    failure_reason=failure_reason
                )
            
            logger.info(f"Status changed for {pod_name}: {high_level_status} - {display_message}")
        else:
            logger.debug(f"Status unchanged for {pod_name}: {display_message}")

        # Update any remaining fields (like pod_logs) separately
        if update_fields:
            update_reservation_fields(reservation_id, **update_fields)
            if status_changed:
                logger.info(f"Successfully updated pod status for {pod_name}: {display_message}")
        else:
            if status_changed:
                logger.warning(
                    f"No update fields for pod {pod_name} - display_message='{display_message}', pod_phase='{pod_phase}'")

        return {
            "phase": pod_phase,
            "display_message": display_message,
            "has_errors": "❌" in display_message,
            "is_ready": pod_phase == "Running" and "SSH daemon ready" in startup_message
        }

    except Exception as e:
        logger.warning(f"Transient monitoring issue for pod {pod_name}: {e}")
        # Don't fail reservation on monitoring exceptions - they're usually transient
        # Let monitoring continue, actual pod failures will be caught in subsequent cycles
        return {
            "phase": "Unknown",
            "display_message": "⏳ Checking pod status...",
            "has_errors": False,
            "is_ready": False
        }


# extract_startup_events_from_logs function removed - logic integrated into update_pod_status_and_events


def wait_for_ssh_service(
    k8s_client, pod_name: str, node_ip: str, node_port: int, timeout_seconds: int = 180
) -> bool:
    """Wait for SSH service to be ready - simplified since background monitoring handles status updates"""
    try:
        v1 = client.CoreV1Api(k8s_client)
        start_time = time.time()

        logger.info(f"Waiting up to {timeout_seconds}s for SSH service on {pod_name}")

        while time.time() - start_time < timeout_seconds:
            try:
                # Check logs for SSH daemon startup
                logs = v1.read_namespaced_pod_log(
                    name=pod_name, namespace="gpu-dev", tail_lines=50
                )

                if "SSH daemon starting on port 22" in logs:
                    logger.info("SSH daemon has started according to logs")

                    # Give SSH daemon a moment to fully start
                    time.sleep(5)

                    # Test actual connectivity
                    try:
                        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                        sock.settimeout(10)
                        result = sock.connect_ex((node_ip, node_port))
                        sock.close()

                        if result == 0:
                            logger.info(
                                f"SSH service is responding on {node_ip}:{node_port}"
                            )
                            
                            # Trigger dotfiles restore in background (non-blocking)
                            try:
                                logger.info("Triggering background dotfiles restore...")
                                restore_cmd = f"ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -p {node_port} dev@{node_ip} 'nohup /usr/local/bin/restore-dotfiles > /tmp/dotfiles-restore.log 2>&1 &'"
                                import subprocess
                                subprocess.Popen(restore_cmd, shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                                logger.info("✓ Background dotfiles restore triggered")
                            except Exception as restore_error:
                                logger.warning(f"Could not trigger dotfiles restore: {restore_error}")
                            
                            return True
                        else:
                            logger.info(f"SSH port not yet accessible: {result}")
                    except Exception as e:
                        logger.info(f"SSH connectivity test failed: {e}")

            except Exception as e:
                logger.warning(f"Error checking SSH readiness: {e}")

            time.sleep(10)

        logger.warning(f"SSH service not ready after {timeout_seconds} seconds")
        return False

    except Exception as e:
        logger.error(f"Error waiting for SSH service: {e}")
        return False


# get_detailed_pod_status function removed - replaced by update_pod_status_and_events


def process_scheduled_queue_management():
    """Process queued reservations and update ETAs every minute"""
    try:
        current_time = int(time.time())
        logger.info(
            f"Processing scheduled queue management at timestamp {current_time}"
        )

        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)

        # Get all queued reservations (NOT pending or preparing - those are handled by SQS and background threads)
        # Scheduled processing should only handle reservations that are truly queued and need resource allocation
        queued_statuses = [
            "queued"
        ]  # Only process truly queued, not pending/preparing ones with active monitoring
        all_queued_reservations = []

        for status in queued_statuses:
            try:
                response = reservations_table.query(
                    IndexName="StatusIndex",
                    KeyConditionExpression="#status = :status",
                    ExpressionAttributeNames={"#status": "status"},
                    ExpressionAttributeValues={":status": status},
                )
                # Filter out reservations that are too new (less than 30 seconds old)
                # This prevents collision with SQS processing
                raw_reservations = response.get("Items", [])
                filtered_reservations = []

                for reservation in raw_reservations:
                    created_at = reservation.get("created_at", "")
                    try:
                        if isinstance(created_at, str):
                            created_timestamp = int(
                                datetime.fromisoformat(
                                    created_at.replace("Z", "+00:00")
                                ).timestamp()
                            )
                        else:
                            created_timestamp = int(created_at)

                        # Only process reservations older than 30 seconds to avoid SQS collision
                        if current_time - created_timestamp > 30:
                            filtered_reservations.append(reservation)
                        else:
                            logger.info(
                                f"Skipping recent reservation {reservation['reservation_id'][:8]} to avoid SQS collision"
                            )
                    except Exception as e:
                        logger.warning(
                            f"Could not parse created_at for reservation {reservation.get('reservation_id', 'unknown')}: {e}"
                        )
                        # If we can't parse timestamp, include it to be safe
                        filtered_reservations.append(reservation)

                all_queued_reservations.extend(filtered_reservations)
            except Exception as e:
                logger.error(f"Error querying {status} reservations: {e}")

        logger.info(
            f"Found {len(all_queued_reservations)} queued reservations (excluding recent ones)"
        )

        if not all_queued_reservations:
            return {
                "statusCode": 200,
                "body": json.dumps(
                    {"message": "No queued reservations to process", "processed": 0}
                ),
            }

        # Set up K8s client and tracker for resource checking
        k8s_client = get_k8s_client()
        gpu_tracker = K8sGPUTracker(k8s_client)

        # Get current GPU availability
        try:
            capacity_info = gpu_tracker.get_gpu_capacity_info()
            available_gpus = capacity_info["available_gpus"]
            logger.info(f"Current GPU availability: {available_gpus} GPUs available")
        except Exception as e:
            logger.error(f"Error getting GPU capacity: {e}")
            available_gpus = 0

        # Get active reservations for ETA calculations
        try:
            active_response = reservations_table.query(
                IndexName="StatusIndex",
                KeyConditionExpression="#status = :status",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={":status": "active"},
            )
            active_reservations = active_response.get("Items", [])
        except Exception as e:
            logger.error(f"Error querying active reservations: {e}")
            active_reservations = []

        # Sort queued reservations by creation time (FIFO)
        all_queued_reservations.sort(key=lambda x: x.get("created_at", ""))

        processed_count = 0
        allocated_count = 0
        updated_count = 0

        # Try to allocate resources for queued reservations
        for i, reservation in enumerate(all_queued_reservations):
            try:
                reservation_id = reservation["reservation_id"]
                requested_gpus = int(reservation.get("gpu_count", 1))
                current_status = reservation.get("status", "pending")

                # Check if this reservation can be allocated now
                if available_gpus >= requested_gpus:
                    logger.info(
                        f"Allocating {requested_gpus} GPUs for reservation {reservation_id}"
                    )

                    # Update status to preparing
                    update_reservation_status(
                        reservation_id,
                        "preparing",
                        "GPUs available - preparing environment",
                    )

                    # Try to create the actual resources
                    try:
                        # Create reservation using the same logic as the SQS handler
                        allocation_success = allocate_gpu_resources(
                            reservation_id, reservation
                        )
                        if (
                            allocation_success is not False
                        ):  # None or True means success
                            available_gpus -= requested_gpus  # Reduce available count
                            allocated_count += 1
                            logger.info(
                                f"Successfully allocated resources for reservation {reservation_id}"
                            )
                        else:
                            logger.warning(
                                f"Failed to allocate resources for reservation {reservation_id}"
                            )
                            update_reservation_status(
                                reservation_id,
                                "queued",
                                "Allocation failed, back to queue",
                            )
                    except Exception as alloc_error:
                        logger.error(
                            f"Error allocating resources for {reservation_id}: {alloc_error}"
                        )
                        update_reservation_status(
                            reservation_id,
                            "queued",
                            f"Allocation error: {str(alloc_error)}",
                        )
                else:
                    # Update queue position and ETA for waiting reservations
                    queue_position = i + 1

                    # Calculate estimated wait time using K8s tracker
                    try:
                        wait_estimate = gpu_tracker.estimate_wait_time(
                            requested_gpus, active_reservations
                        )
                        estimated_wait_minutes = wait_estimate.get(
                            "estimated_wait_minutes", 30
                        )
                    except Exception as e:
                        logger.warning(f"Could not calculate wait time: {e}")
                        estimated_wait_minutes = (
                            queue_position * 15
                        )

                    # Update reservation with current queue info
                    update_reservation_with_queue_info(
                        reservation_id,
                        str(queue_position),
                        str(estimated_wait_minutes),
                        available_gpus,
                    )

                    # Update status with human-readable timestamps if needed
                    if current_status == "pending":
                        update_reservation_status(
                            reservation_id,
                            "queued",
                            f"In queue position #{queue_position}",
                        )

                    updated_count += 1
                    logger.info(
                        f"Updated queue info for reservation {reservation_id}: pos={queue_position}, wait={estimated_wait_minutes}min"
                    )

                processed_count += 1

            except Exception as e:
                logger.error(
                    f"Error processing reservation {reservation.get('reservation_id', 'unknown')}: {e}"
                )
                continue

        logger.info(
            f"Queue processing complete: {processed_count} processed, {allocated_count} allocated, {updated_count} updated"
        )

        return {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "message": "Queue processing completed",
                    "processed": processed_count,
                    "allocated": allocated_count,
                    "updated": updated_count,
                    "available_gpus": available_gpus,
                }
            ),
        }

    except Exception as e:
        logger.error(f"Error in scheduled queue management: {str(e)}")
        raise


def process_cancellation_request(record: dict[str, Any]) -> bool:
    """Process cancellation request from SQS message"""
    try:
        # Parse the cancellation request
        message_body = json.loads(record["body"])

        logger.info(f"Processing cancellation: {message_body}")

        reservation_id = message_body.get("reservation_id")
        user_id = message_body.get("user_id")

        if not reservation_id or not user_id:
            logger.error(
                f"Invalid cancellation request - missing reservation_id or user_id: {message_body}"
            )
            return True  # Don't retry malformed messages

        try:
            reservation = find_reservation_by_prefix(reservation_id, user_id)
            full_reservation_id = reservation["reservation_id"]
        except ValueError as e:
            logger.warning(str(e))
            return True
        except Exception as db_error:
            logger.error(f"Database error processing cancellation for {reservation_id}: {db_error}")
            return False

        current_status = reservation.get("status")
        if current_status not in ["active", "queued", "pending", "preparing"]:
            logger.warning(f"Cannot cancel reservation {full_reservation_id} in status {current_status}")
            return True

        logger.info(
            f"Cancelling reservation {full_reservation_id} (prefix: {reservation_id}) for user {user_id} (current status: {current_status})")

        # CRITICAL: Stop background monitoring to prevent race condition
        if full_reservation_id in _monitoring_threads:
            logger.info(f"Stopping background monitoring for reservation {full_reservation_id}")
            _monitoring_threads[full_reservation_id].set()  # Signal thread to stop
            del _monitoring_threads[full_reservation_id]    # Remove from registry
        else:
            logger.info(f"No monitoring thread found for reservation {full_reservation_id}")

        try:
            now = datetime.utcnow().isoformat()
            update_reservation_fields(
                full_reservation_id,
                status="cancelled",
                cancelled_at=now,
                reservation_ended=now,
            )

            if current_status == "active":
                pod_name = reservation.get("pod_name")
                namespace = reservation.get("namespace", "gpu-dev")
                user_id = reservation.get("user_id")

                if pod_name and user_id:
                    try:
                        # First, create snapshot if pod has persistent storage
                        k8s_client = get_k8s_client()
                        v1 = client.CoreV1Api(k8s_client)

                        try:
                            pod = v1.read_namespaced_pod(name=pod_name, namespace=namespace)
                            volume_id = None

                            # Check pod annotations for persistent volume info
                            if pod.metadata.annotations:
                                volume_id = pod.metadata.annotations.get("gpu-dev-volume-id")

                            # Create cancellation snapshot if we have volume info
                            if volume_id:
                                logger.info(f"Creating cancellation snapshot for user {user_id}, volume {volume_id}")
                                snapshot_id = create_pod_shutdown_snapshot(volume_id, user_id, "cancellation")
                                if snapshot_id:
                                    logger.info(f"Cancellation snapshot {snapshot_id} initiated for {pod_name}")
                                else:
                                    logger.warning(f"Failed to create cancellation snapshot for {pod_name}")
                            else:
                                logger.info(
                                    f"No persistent storage found for pod {pod_name} - skipping cancellation snapshot")

                        except Exception as pod_read_error:
                            logger.warning(f"Could not read pod {pod_name} for snapshot info: {pod_read_error}")

                        # Now cleanup pod resources
                        cleanup_pod_resources(pod_name, namespace)
                        logger.info(f"Cleaned up pod resources for cancelled reservation {full_reservation_id}")

                    except Exception as cleanup_error:
                        logger.error(f"Error cleaning up pod {pod_name}: {cleanup_error}")

            logger.info(f"Successfully cancelled reservation {full_reservation_id}")
            return True

        except Exception as db_error:
            logger.error(f"Database error processing cancellation for {reservation_id}: {db_error}")
            return False

    except Exception as e:
        logger.error(f"Error processing cancellation request: {str(e)}")
        return False  # Retry on processing errors


def enable_jupyter_in_pod(
    k8s_client, pod_name: str, namespace: str, reservation_id: str
) -> bool:
    """Enable Jupyter Lab in a running pod"""
    try:
        v1 = client.CoreV1Api(k8s_client)

        # Check if Jupyter is already running using standard exec
        check_command = ["pgrep", "-f", "jupyter"]
        try:
            from kubernetes.stream import stream

            check_resp = stream(
                v1.connect_get_namespaced_pod_exec,
                pod_name,
                namespace,
                command=check_command,
                stderr=True,
                stdin=False,
                stdout=True,
                tty=False,
            )

            if "jupyter" in check_resp:
                logger.info(f"Jupyter already running in pod {pod_name}")
                # Update DynamoDB to reflect current state and return success
                update_reservation_jupyter_status(reservation_id, True)
                return True

        except Exception as check_error:
            logger.info(f"Jupyter check failed, proceeding with start: {check_error}")

        # Start Jupyter using existing config (config always exists from pod creation)
        start_commands = [
            "/bin/bash",
            "-c",
            """
            set -e

            # Start Jupyter as dev user in background (config already exists)
            echo "Starting Jupyter Lab with existing config..."
            nohup su - dev -c "cd /workspace && /opt/conda/bin/jupyter-lab --config=/home/dev/.jupyter/jupyter_lab_config.py" > /tmp/jupyter.log 2>&1 &

            # Wait for startup
            sleep 3

            # Verify it started
            if pgrep -f "jupyter" > /dev/null; then
                echo "Jupyter Lab started successfully"
                exit 0
            else
                echo "Failed to start Jupyter Lab"
                exit 1
            fi
            """,
        ]

        exec_resp = stream(
            v1.connect_get_namespaced_pod_exec,
            pod_name,
            namespace,
            command=start_commands,
            stderr=True,
            stdin=False,
            stdout=True,
            tty=False,
        )

        if "Jupyter Lab started successfully" in exec_resp:
            logger.info(f"Successfully enabled Jupyter in pod {pod_name}")

            # Create Jupyter service if needed
            try:
                existing_jupyter_port = None
                try:
                    v1 = client.CoreV1Api(k8s_client)
                    jupyter_service = v1.read_namespaced_service(
                        name=f"{pod_name}-jupyter", namespace=namespace
                    )
                    existing_jupyter_port = jupyter_service.spec.ports[0].node_port
                except client.exceptions.ApiException as jupyter_error:
                    if jupyter_error.status != 404:
                        raise

                if not existing_jupyter_port:
                    jupyter_port = find_available_node_port(k8s_client)
                    create_jupyter_service(k8s_client, pod_name, jupyter_port)
                else:
                    jupyter_port = existing_jupyter_port

                # Get node IP and token for URL
                node_public_ip = get_pod_node_public_ip(pod_name)
                jupyter_token = get_jupyter_token_from_pod(k8s_client, pod_name)
                jupyter_url = f"http://{node_public_ip}:{jupyter_port}"
                if jupyter_token:
                    jupyter_url += f"?token={jupyter_token}"

                # Update reservation with full Jupyter info
                update_reservation_fields(
                    reservation_id,
                    jupyter_enabled=True,
                    jupyter_port=jupyter_port,
                    jupyter_url=jupyter_url,
                    jupyter_token=jupyter_token or "",
                )

                logger.info(f"Jupyter enabled with URL: {jupyter_url}")

            except Exception as service_error:
                logger.error(f"Error creating Jupyter service: {service_error}")
                # Still update the enabled status even if service creation fails
                update_reservation_jupyter_status(reservation_id, True)

            return True
        else:
            logger.error(
                f"Failed to enable Jupyter in pod {pod_name}, output: {exec_resp}"
            )
            return False

    except Exception as e:
        logger.error(f"Error enabling Jupyter in pod {pod_name}: {str(e)}")
        return False


def disable_jupyter_in_pod(
    k8s_client, pod_name: str, namespace: str, reservation_id: str
) -> bool:
    """Disable Jupyter Lab in a running pod"""
    try:
        v1 = client.CoreV1Api(k8s_client)

        # Kill Jupyter processes
        kill_commands = [
            "/bin/bash",
            "-c",
            """
            set -e

            echo "Stopping Jupyter Lab..."

            # Kill all jupyter processes
            pkill -f jupyter || true

            # Wait a moment
            sleep 2

            # Verify it stopped
            if ! pgrep -f "jupyter" > /dev/null; then
                echo "Jupyter Lab stopped successfully"
                rm -f /tmp/jupyter_token /tmp/jupyter.log 2>/dev/null || true
                exit 0
            else
                echo "Some Jupyter processes may still be running"
                # Force kill if needed
                pkill -9 -f jupyter || true
                sleep 1

                if ! pgrep -f "jupyter" > /dev/null; then
                    echo "Jupyter Lab force-stopped"
                    rm -f /tmp/jupyter_token /tmp/jupyter.log 2>/dev/null || true
                    exit 0
                else
                    echo "Failed to stop all Jupyter processes"
                    exit 1
                fi
            fi
            """,
        ]

        exec_resp = stream(
            v1.connect_get_namespaced_pod_exec,
            pod_name,
            namespace,
            command=kill_commands,
            stderr=True,
            stdin=False,
            stdout=True,
            tty=False,
        )

        # Check if the disable command ran (even if it didn't produce the expected success message)
        # The fact that we got output "Stopping Jupyter Lab..." means the command started
        if (
            "Stopping Jupyter Lab" in exec_resp
            or "Jupyter Lab stopped successfully" in exec_resp
            or "Jupyter Lab force-stopped" in exec_resp
        ):
            logger.info(
                f"Jupyter disable command executed in pod {pod_name}, output: {exec_resp}"
            )

            # Remove Jupyter service
            try:
                v1 = client.CoreV1Api(k8s_client)
                v1.delete_namespaced_service(
                    name=f"{pod_name}-jupyter", namespace=namespace
                )
                logger.info(f"Deleted Jupyter service for pod {pod_name}")
            except client.exceptions.ApiException as service_error:
                if service_error.status == 404:
                    logger.info(f"Jupyter service for {pod_name} already deleted")
                else:
                    logger.error(f"Error deleting Jupyter service: {service_error}")

            # Update reservation with Jupyter disabled status (remove URL and token)
            reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
            current_timestamp = int(time.time())
            reservations_table.update_item(
                Key={"reservation_id": reservation_id},
                UpdateExpression="SET jupyter_enabled = :enabled, last_updated = :timestamp REMOVE jupyter_url, jupyter_token, jupyter_port",
                ExpressionAttributeValues={
                    ":enabled": False,
                    ":timestamp": current_timestamp,
                },
            )
            logger.info(
                f"Updated reservation {reservation_id} with jupyter_enabled=False, removed jupyter_url/token/port"
            )

            return True
        else:
            logger.error(
                f"Failed to disable Jupyter in pod {pod_name}, output: {exec_resp}"
            )
            return False

    except Exception as e:
        logger.error(f"Error disabling Jupyter in pod {pod_name}: {str(e)}")
        return False


def add_user_to_pod(
    k8s_client, pod_name: str, namespace: str, reservation_id: str, github_username: str
) -> bool:
    """Add a GitHub user's SSH keys to a running pod"""
    try:
        # Fetch GitHub user's public SSH keys using shared function
        keys_to_add = get_github_public_key(github_username, validate=True)
        if not keys_to_add:
            return False

        v1 = client.CoreV1Api(k8s_client)

        # Add SSH keys to authorized_keys file
        add_keys_commands = [
            "/bin/bash",
            "-c",
            f"""
            set -e

            echo "Adding SSH keys for user {github_username}..."

            # Ensure .ssh directory exists with correct permissions
            mkdir -p /home/dev/.ssh
            chmod 700 /home/dev/.ssh

            # Create or append to authorized_keys
            touch /home/dev/.ssh/authorized_keys
            chmod 600 /home/dev/.ssh/authorized_keys

            # Add keys (avoid duplicates by checking if key already exists)
            keys_added=0
            while IFS= read -r key; do
                if [ -n "$key" ] && ! grep -Fq "$key" /home/dev/.ssh/authorized_keys; then
                    echo "$key" >> /home/dev/.ssh/authorized_keys
                    keys_added=$((keys_added + 1))
                fi
            done << 'EOF'
{keys_to_add}
EOF

            # Set proper ownership
            chown -R 1000:1000 /home/dev/.ssh

            echo "Added $keys_added new SSH keys for {github_username}"
            echo "SSH keys for {github_username} added successfully"
            """,
        ]

        exec_resp = stream(
            v1.connect_get_namespaced_pod_exec,
            pod_name,
            namespace,
            command=add_keys_commands,
            stderr=True,
            stdin=False,
            stdout=True,
            tty=False,
        )

        if f"SSH keys for {github_username} added successfully" in exec_resp:
            logger.info(
                f"Successfully added SSH keys for {github_username} to pod {pod_name}"
            )

            # Update reservation with secondary user
            reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
            current_timestamp = int(time.time())

            # Get current secondary users list
            try:
                get_response = reservations_table.get_item(
                    Key={"reservation_id": reservation_id}
                )
                current_secondary_users = get_response.get("Item", {}).get(
                    "secondary_users", []
                )

                # Add new user if not already present
                if github_username not in current_secondary_users:
                    updated_secondary_users = current_secondary_users + [
                        github_username
                    ]

                    update_reservation_fields(
                        reservation_id,
                        secondary_users=updated_secondary_users,
                    )
                    logger.info(
                        f"Updated reservation {reservation_id} with secondary user {github_username}"
                    )
                else:
                    logger.info(
                        f"User {github_username} already in secondary users list for reservation {reservation_id}"
                    )

            except Exception as db_error:
                logger.error(
                    f"Failed to update reservation with secondary user: {db_error}"
                )
                # Still return True since the SSH keys were added successfully

            return True
        else:
            logger.error(
                f"Failed to add SSH keys for {github_username} to pod {pod_name}, output: {exec_resp}"
            )
            return False

    except Exception as e:
        logger.error(f"Error adding user {github_username} to pod {pod_name}: {str(e)}")
        return False


def update_reservation_jupyter_status(
    reservation_id: str, jupyter_enabled: bool
) -> None:
    """Update the Jupyter enabled status in DynamoDB"""
    try:
        update_reservation_fields(reservation_id, jupyter_enabled=jupyter_enabled)
    except Exception as e:
        logger.error(
            f"Error updating Jupyter status for reservation {reservation_id}: {str(e)}"
        )


def process_jupyter_action(record: dict[str, Any]) -> bool:
    """Process Jupyter enable/disable actions"""
    try:
        message = json.loads(record["body"])
        action = message.get("action")
        reservation_id = message.get("reservation_id")
        user_id = message.get("user_id")

        if not all([action, reservation_id, user_id]):
            logger.error(f"Missing required fields in Jupyter action: {message}")
            return True  # Don't retry malformed messages

        logger.info(f"Processing Jupyter action: {action} for reservation {reservation_id}")

        try:
            reservation = find_reservation_by_prefix(reservation_id, user_id)
            full_reservation_id = reservation["reservation_id"]
            logger.info(f"Found reservation {full_reservation_id} (prefix: {reservation_id})")
        except ValueError as e:
            logger.error(str(e))
            return True
        except Exception as db_error:
            logger.error(f"Database error looking up reservation {reservation_id}: {db_error}")
            return False

        # Verify user owns the reservation and it's active
        if reservation.get("user_id") != user_id:
            logger.error(
                f"User {user_id} doesn't own reservation {full_reservation_id}"
            )
            return True  # Don't retry - authorization error

        if reservation.get("status") != "active":
            logger.error(
                f"Can only modify active reservations (current: {reservation.get('status')})"
            )
            return True  # Don't retry - invalid state

        # Get pod info
        pod_name = reservation.get("pod_name")
        namespace = reservation.get("namespace", "gpu-dev")

        if not pod_name:
            logger.error(f"No pod name found for reservation {full_reservation_id}")
            return True  # Don't retry - no pod to modify

        # Execute Jupyter action in pod using full reservation ID
        k8s_client = get_k8s_client()
        success = False

        if action == "enable_jupyter":
            success = enable_jupyter_in_pod(
                k8s_client, pod_name, namespace, full_reservation_id
            )
        elif action == "disable_jupyter":
            success = disable_jupyter_in_pod(
                k8s_client, pod_name, namespace, full_reservation_id
            )

        if success:
            logger.info(
                f"Successfully {action}d Jupyter for reservation {full_reservation_id}"
            )
            return True
        else:
            logger.error(
                f"Failed to {action} Jupyter for reservation {full_reservation_id}"
            )
            return False  # Retry on failure

    except Exception as e:
        logger.error(f"Error processing Jupyter action: {str(e)}")
        return False  # Retry on processing errors


def process_add_user_action(record: dict[str, Any]) -> bool:
    """Process add user actions"""
    try:
        message = json.loads(record["body"])
        action = message.get("action")
        reservation_id = message.get("reservation_id")
        user_id = message.get("user_id")
        github_username = message.get("github_username")

        if not all([action, reservation_id, user_id, github_username]):
            logger.error(f"Missing required fields in add user action: {message}")
            return True  # Don't retry malformed messages

        logger.info(f"Processing add user action: adding {github_username} to reservation {reservation_id}")

        try:
            reservation = find_reservation_by_prefix(reservation_id, user_id)
            full_reservation_id = reservation["reservation_id"]
            logger.info(f"Found reservation {full_reservation_id} (prefix: {reservation_id})")
        except ValueError as e:
            logger.error(str(e))
            return True
        except Exception as db_error:
            logger.error(f"Database error looking up reservation {reservation_id}: {db_error}")
            return False

        # Verify user owns the reservation and it's active
        if reservation.get("user_id") != user_id:
            logger.error(
                f"User {user_id} doesn't own reservation {full_reservation_id}"
            )
            return True  # Don't retry - authorization error

        if reservation.get("status") != "active":
            logger.error(
                f"Can only modify active reservations (current: {reservation.get('status')})"
            )
            return True  # Don't retry - invalid state

        # Get pod info
        pod_name = reservation.get("pod_name")
        namespace = reservation.get("namespace", "gpu-dev")

        if not pod_name:
            logger.error(f"No pod name found for reservation {full_reservation_id}")
            return True  # Don't retry - no pod to modify

        # Add user SSH keys to pod
        k8s_client = get_k8s_client()
        success = add_user_to_pod(
            k8s_client, pod_name, namespace, full_reservation_id, github_username
        )

        if success:
            logger.info(
                f"Successfully added user {github_username} to reservation {full_reservation_id}"
            )
            return True
        else:
            logger.error(
                f"Failed to add user {github_username} to reservation {full_reservation_id}"
            )
            return False  # Retry on failure

    except Exception as e:
        logger.error(f"Error processing add user action: {str(e)}")
        return False  # Retry on processing errors


def cleanup_pod_resources(pod_name: str, namespace: str = "gpu-dev") -> None:
    """Clean up Kubernetes pod and associated service resources"""
    try:
        logger.info(f"Cleaning up pod {pod_name} in namespace {namespace}")

        k8s_client = get_k8s_client()
        v1 = client.CoreV1Api(k8s_client)

        # Delete the NodePort service first
        service_name = f"{pod_name}-ssh"
        try:
            v1.delete_namespaced_service(
                name=service_name, namespace=namespace, grace_period_seconds=0
            )
            logger.info(f"Deleted service {service_name}")
        except client.exceptions.ApiException as e:
            if e.status == 404:
                logger.info(f"Service {service_name} not found (already deleted)")
            else:
                logger.warning(f"Failed to delete service {service_name}: {e}")

        # Delete the pod with grace period
        try:
            v1.delete_namespaced_pod(
                name=pod_name, namespace=namespace, grace_period_seconds=30
            )
            logger.info(f"Deleted pod {pod_name}")
        except client.exceptions.ApiException as e:
            if e.status == 404:
                logger.info(f"Pod {pod_name} not found (already deleted)")
            else:
                logger.error(f"Failed to delete pod {pod_name}: {e}")
                # Try force delete if graceful deletion failed
                try:
                    v1.delete_namespaced_pod(
                        name=pod_name, namespace=namespace, grace_period_seconds=0
                    )
                    logger.info(f"Force deleted pod {pod_name}")
                except client.exceptions.ApiException as force_error:
                    logger.error(
                        f"Failed to force delete pod {pod_name}: {force_error}"
                    )
                    raise

    except Exception as e:
        logger.error(f"Error cleaning up pod {pod_name}: {str(e)}")
        raise


def process_extend_reservation_action(record: dict[str, Any]) -> bool:
    """Process reservation extension requests"""
    try:
        message = json.loads(record["body"])
        reservation_id = message.get("reservation_id")
        extension_hours = message.get("extension_hours")

        if not all([reservation_id, extension_hours]):
            logger.error(f"Missing required fields in extend reservation action: {message}")
            return True

        logger.info(f"Processing extend reservation: {reservation_id} by {extension_hours} hours")

        try:
            reservation = find_reservation_by_prefix(reservation_id)
            full_reservation_id = reservation["reservation_id"]
            logger.info(f"Found reservation {full_reservation_id} (prefix: {reservation_id})")
        except ValueError as e:
            logger.error(str(e))
            return True
        except Exception as db_error:
            logger.error(f"Database error looking up reservation {reservation_id}: {db_error}")
            return False

        current_status = reservation.get("status")
        if current_status not in ["active", "preparing"]:
            error_msg = f"Cannot extend reservation in status {current_status}"
            logger.error(error_msg)
            update_reservation_error(full_reservation_id, error_msg, "extension_error")
            return True

        try:
            current_expires_at = reservation.get("expires_at")
            if not current_expires_at:
                error_msg = f"No expiration time found for reservation {full_reservation_id}"
                logger.error(error_msg)
                update_reservation_error(full_reservation_id, error_msg, "extension_error")
                return True

            if isinstance(current_expires_at, str):
                current_expiry = datetime.fromisoformat(current_expires_at.replace('Z', '+00:00'))
            else:
                current_expiry = datetime.fromisoformat(current_expires_at)

            new_expiry = current_expiry + timedelta(hours=float(extension_hours))
            new_expires_at = new_expiry.isoformat()

            logger.info(f"Extending reservation {full_reservation_id} from {current_expires_at} to {new_expires_at}")

        except Exception as date_error:
            error_msg = f"Error calculating new expiration time: {str(date_error)}"
            logger.error(error_msg)
            update_reservation_error(full_reservation_id, error_msg, "extension_error")
            return True

        try:
            reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
            update_expression = "SET expires_at = :new_expires_at, last_updated = :timestamp"
            expression_values = {
                ":new_expires_at": new_expires_at,
                ":timestamp": int(time.time())
            }

            if "duration_hours" in reservation:
                current_duration = float(reservation.get("duration_hours", 0))
                new_duration = current_duration + float(extension_hours)
                update_expression += ", duration_hours = :new_duration"
                expression_values[":new_duration"] = Decimal(str(new_duration))

            update_expression += " REMOVE extension_error"

            reservations_table.update_item(
                Key={"reservation_id": full_reservation_id},
                UpdateExpression=update_expression,
                ExpressionAttributeValues=expression_values
            )

            logger.info(f"Successfully extended reservation {full_reservation_id} by {extension_hours} hours")
            
            # Add successful extension to status history
            try:
                current_time = datetime.utcnow().isoformat()
                extension_message = f"Extended by {extension_hours} hours (new expiry: {new_expires_at.strftime('%Y-%m-%d %H:%M:%S')})"
                append_status_history(full_reservation_id, current_time, extension_message)
            except Exception as history_error:
                logger.warning(f"Could not add extension to status history: {history_error}")
            
            return True

        except Exception as update_error:
            error_msg = f"Database error during extension: {str(update_error)}"
            logger.error(error_msg)
            update_reservation_error(full_reservation_id, error_msg, "extension_error")
            return False

    except Exception as e:
        logger.error(f"Error processing extend reservation action: {str(e)}")
        return False
