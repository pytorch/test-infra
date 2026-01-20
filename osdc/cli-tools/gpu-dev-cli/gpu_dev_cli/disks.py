"""
Disk management for GPU Dev CLI
Handles named persistent disks with snapshot-first workflow
"""

import boto3
import re
from decimal import Decimal
from typing import List, Dict, Optional, Tuple
from datetime import datetime, timedelta, timezone
from .config import Config


def get_ec2_client(config: Config):
    """Get boto3 EC2 client"""
    return config.session.client('ec2', region_name=config.aws_region)


def get_s3_client(config: Config):
    """Get boto3 S3 client"""
    return config.session.client('s3', region_name=config.aws_region)


def get_dynamodb_resource(config: Config):
    """Get boto3 DynamoDB resource"""
    return config.session.resource('dynamodb', region_name=config.aws_region)


def get_disk_in_use_status(disk_name: str, user_id: str, config: Config) -> Tuple[bool, Optional[str]]:
    """
    Check if a disk is currently in use by any reservation.
    Returns (is_in_use, reservation_id)

    We check TWO sources to handle all race conditions:
    1. Disks table `in_use` field - set by Lambda when disk is attached, cleared after cleanup
    2. Reservations table - for in-progress reservations that haven't started disk setup yet

    This prevents race conditions during both spinning up (queued/pending) and
    winding down (cancelled but cleanup still running).
    """
    dynamodb = get_dynamodb_resource(config)

    try:
        # First check: disks table in_use field (most reliable for cleanup in progress)
        disks_table_name = config.disks_table if hasattr(config, 'disks_table') else f"{config.queue_name.rsplit('-', 1)[0]}-disks"
        disks_table = dynamodb.Table(disks_table_name)

        try:
            disk_response = disks_table.get_item(
                Key={'user_id': user_id, 'disk_name': disk_name}
            )
            disk_item = disk_response.get('Item', {})

            # Check if disk is marked as in_use in the disks table
            if disk_item.get('in_use', False):
                attached_reservation = disk_item.get('attached_to_reservation')
                return True, attached_reservation
        except Exception as disk_check_error:
            # If disks table check fails, fall through to reservation check
            pass

        # Second check: reservations table for in-progress reservations
        reservations_table = dynamodb.Table(config.reservations_table)

        # Use UserIndex for efficient query (instead of scan with pagination)
        # Check ALL in-progress statuses to prevent race conditions
        response = reservations_table.query(
            IndexName="UserIndex",
            KeyConditionExpression="user_id = :user_id",
            FilterExpression="disk_name = :disk_name AND #status IN (:active, :preparing, :queued, :pending)",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":user_id": user_id,
                ":disk_name": disk_name,
                ":active": "active",
                ":preparing": "preparing",
                ":queued": "queued",
                ":pending": "pending"
            }
        )

        # Handle pagination
        items = response.get("Items", [])
        while "LastEvaluatedKey" in response:
            response = reservations_table.query(
                IndexName="UserIndex",
                KeyConditionExpression="user_id = :user_id",
                FilterExpression="disk_name = :disk_name AND #status IN (:active, :preparing, :queued, :pending)",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={
                    ":user_id": user_id,
                    ":disk_name": disk_name,
                    ":active": "active",
                    ":preparing": "preparing",
                    ":queued": "queued",
                    ":pending": "pending"
                },
                ExclusiveStartKey=response["LastEvaluatedKey"]
            )
            items.extend(response.get("Items", []))

        if items:
            reservation_id = items[0]["reservation_id"]
            return True, reservation_id

        # Special case: For "default" disk, also check for legacy reservations without disk_name field
        # (reservations created before named disk migration)
        # IMPORTANT: Only match legacy reservations that HAVE an ebs_volume_id
        # (reservations without disk_name AND without ebs_volume_id are non-persistent, not "default" disk)
        if disk_name == "default":
            legacy_response = reservations_table.query(
                IndexName="UserIndex",
                KeyConditionExpression="user_id = :user_id",
                FilterExpression="attribute_not_exists(disk_name) AND attribute_exists(ebs_volume_id) AND #status IN (:active, :preparing)",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={
                    ":user_id": user_id,
                    ":active": "active",
                    ":preparing": "preparing"
                }
            )

            # Handle pagination for legacy query
            legacy_items = legacy_response.get("Items", [])
            while "LastEvaluatedKey" in legacy_response:
                legacy_response = reservations_table.query(
                    IndexName="UserIndex",
                    KeyConditionExpression="user_id = :user_id",
                    FilterExpression="attribute_not_exists(disk_name) AND attribute_exists(ebs_volume_id) AND #status IN (:active, :preparing)",
                    ExpressionAttributeNames={"#status": "status"},
                    ExpressionAttributeValues={
                        ":user_id": user_id,
                        ":active": "active",
                        ":preparing": "preparing"
                    },
                    ExclusiveStartKey=legacy_response["LastEvaluatedKey"]
                )
                legacy_items.extend(legacy_response.get("Items", []))

            if legacy_items:
                reservation_id = legacy_items[0]["reservation_id"]
                return True, reservation_id

        return False, None

    except Exception as e:
        print(f"Warning: Could not query reservations: {e}")
        return False, None


def list_disks(user_id: str, config: Config) -> List[Dict]:
    """
    List all disks for a user.
    Returns list of disk info dicts with: name, size, last_used, created_at, snapshot_count, in_use, reservation_id
    """
    ec2_client = get_ec2_client(config)
    dynamodb = get_dynamodb_resource(config)

    # Query DynamoDB disks table for this user's disks (with pagination)
    disks_table_name = config.disks_table if hasattr(config, 'disks_table') else f"{config.queue_name.rsplit('-', 1)[0]}-disks"
    disks_table = dynamodb.Table(disks_table_name)

    dynamodb_disks = []
    response = disks_table.query(
        KeyConditionExpression="user_id = :user_id",
        ExpressionAttributeValues={":user_id": user_id}
    )
    dynamodb_disks.extend(response.get('Items', []))

    # Handle pagination (get all disks if user has many)
    while 'LastEvaluatedKey' in response:
        response = disks_table.query(
            KeyConditionExpression="user_id = :user_id",
            ExpressionAttributeValues={":user_id": user_id},
            ExclusiveStartKey=response['LastEvaluatedKey']
        )
        dynamodb_disks.extend(response.get('Items', []))

    # Process DynamoDB data
    disks = []
    for disk_item in dynamodb_disks:
        disk_name = disk_item['disk_name']

        # Convert DynamoDB types (Decimal to int/float)
        size_gb = int(disk_item.get('size_gb', 0)) if disk_item.get('size_gb') else 0
        snapshot_count = int(disk_item.get('snapshot_count', 0)) if disk_item.get('snapshot_count') else 0
        pending_snapshot_count = int(disk_item.get('pending_snapshot_count', 0)) if disk_item.get('pending_snapshot_count') else 0

        # Parse datetime strings from DynamoDB
        created_at_str = disk_item.get('created_at')
        last_used_str = disk_item.get('last_used')

        created_at = datetime.fromisoformat(created_at_str) if created_at_str else None
        last_used = datetime.fromisoformat(last_used_str) if last_used_str else None

        # Ensure all datetimes are timezone-aware (normalize any timezone-naive datetimes from older records)
        if created_at and created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        if last_used and last_used.tzinfo is None:
            last_used = last_used.replace(tzinfo=timezone.utc)

        # Get disk_size if available
        disk_size = disk_item.get('disk_size')

        # Get backup and deletion status from DynamoDB
        is_backing_up = disk_item.get('is_backing_up', False)
        is_deleted = disk_item.get('is_deleted', False)
        delete_date = disk_item.get('delete_date')

        # Check current in_use status (check dynamically from reservations table)
        is_in_use, reservation_id = get_disk_in_use_status(disk_name, user_id, config)

        disks.append({
            'name': disk_name,
            'size_gb': size_gb,
            'disk_size': disk_size,
            'created_at': created_at,
            'last_used': last_used,
            'snapshot_count': snapshot_count,
            'pending_snapshot_count': pending_snapshot_count,
            'in_use': is_in_use,
            'is_backing_up': is_backing_up,
            'reservation_id': reservation_id,
            'is_deleted': is_deleted,
            'delete_date': delete_date,
        })

    # Sort by last_used (most recent first)
    disks.sort(key=lambda d: d['last_used'] or datetime.min.replace(tzinfo=timezone.utc), reverse=True)

    return disks


def create_disk(disk_name: str, user_id: str, config: Config) -> Optional[str]:
    """
    Create a new disk by sending request to SQS queue.
    Lambda will create the disk entry in DynamoDB.
    Returns operation_id on success, None on failure.
    """
    import json
    import uuid

    # Check if disk already exists
    existing_disks = list_disks(user_id, config)
    if any(d['name'] == disk_name for d in existing_disks):
        print(f"Error: Disk '{disk_name}' already exists")
        return None

    # Validate disk name (alphanumeric + hyphens + underscores)
    if not re.match(r'^[a-zA-Z0-9_-]+$', disk_name):
        print(f"Error: Disk name must contain only letters, numbers, hyphens, and underscores")
        return None

    # Generate operation ID for tracking
    operation_id = str(uuid.uuid4())

    # Send create request to SQS queue
    try:
        sqs_client = config.session.client('sqs', region_name=config.aws_region)
        queue_url = config.get_queue_url()

        # Create disk creation message
        message = {
            'action': 'create_disk',
            'operation_id': operation_id,
            'user_id': user_id,
            'disk_name': disk_name,
            'requested_at': datetime.now(timezone.utc).isoformat()
        }

        sqs_client.send_message(
            QueueUrl=queue_url,
            MessageBody=json.dumps(message)
        )

        return operation_id

    except Exception as e:
        print(f"Error sending create request: {e}")
        return None


def list_disk_content(disk_name: str, user_id: str, config: Config) -> Optional[str]:
    """
    Fetch and return the contents of the latest snapshot for a disk.
    Returns contents string or None if not found.
    """
    s3_client = get_s3_client(config)
    dynamodb = get_dynamodb_resource(config)

    # Get disk info from DynamoDB to get latest snapshot S3 path
    disks_table_name = config.disks_table if hasattr(config, 'disks_table') else f"{config.queue_name.rsplit('-', 1)[0]}-disks"
    disks_table = dynamodb.Table(disks_table_name)

    try:
        response = disks_table.get_item(
            Key={'user_id': user_id, 'disk_name': disk_name}
        )

        if 'Item' not in response:
            print(f"Disk '{disk_name}' not found")
            return None

        disk_item = response['Item']
        s3_path = disk_item.get('latest_snapshot_content_s3')

        if not s3_path:
            print(f"No snapshot contents available for disk '{disk_name}'")
            print(f"This may be a newly created disk or a disk created before content tracking was added.")
            return None

    except Exception as e:
        print(f"Error fetching disk info from DynamoDB: {e}")
        return None

    # Parse S3 path (s3://bucket/key)
    if not s3_path.startswith('s3://'):
        print(f"Invalid S3 path format: {s3_path}")
        return None

    path_parts = s3_path[5:].split('/', 1)
    if len(path_parts) != 2:
        print(f"Invalid S3 path format: {s3_path}")
        return None

    bucket_name, s3_key = path_parts

    try:
        # Fetch contents from S3
        response = s3_client.get_object(Bucket=bucket_name, Key=s3_key)
        contents = response['Body'].read().decode('utf-8')
        return contents
    except s3_client.exceptions.NoSuchKey:
        print(f"Contents file not found in S3: {s3_path}")
        return None
    except Exception as e:
        print(f"Error fetching contents from S3: {e}")
        return None


def delete_disk(disk_name: str, user_id: str, config: Config) -> Optional[str]:
    """
    Soft delete a disk by sending delete request to SQS queue.
    Lambda will handle marking in DynamoDB and tagging snapshots.
    Returns operation_id on success, None on failure.
    """
    import json
    import uuid

    # Check if disk exists
    disks = list_disks(user_id, config)
    disk = next((d for d in disks if d['name'] == disk_name), None)

    if not disk:
        print(f"Error: Disk '{disk_name}' not found")
        return None

    # Check if disk is in use
    if disk['in_use']:
        print(f"Error: Cannot delete disk '{disk_name}' - it is currently in use")
        print(f"Reservation ID: {disk['reservation_id']}")
        return None

    # Calculate deletion date (30 days from now)
    delete_date = datetime.now(timezone.utc) + timedelta(days=30)
    delete_date_str = delete_date.strftime('%Y-%m-%d')

    # Generate operation ID for tracking
    operation_id = str(uuid.uuid4())

    # Send delete request to SQS queue
    try:
        sqs_client = config.session.client('sqs', region_name=config.aws_region)
        queue_url = config.get_queue_url()

        # Create disk deletion message
        message = {
            'action': 'delete_disk',
            'operation_id': operation_id,
            'user_id': user_id,
            'disk_name': disk_name,
            'delete_date': delete_date_str,
            'requested_at': datetime.now(timezone.utc).isoformat()
        }

        sqs_client.send_message(
            QueueUrl=queue_url,
            MessageBody=json.dumps(message)
        )

        return operation_id

    except Exception as e:
        print(f"Error sending delete request: {e}")
        return None


def poll_disk_operation(
    operation_type: str,
    disk_name: str,
    user_id: str,
    config: Config,
    timeout_seconds: int = 60
) -> Tuple[bool, str]:
    """
    Poll DynamoDB for disk operation completion.

    Args:
        operation_type: 'create' or 'delete'
        disk_name: Name of the disk
        user_id: User ID
        config: Config object
        timeout_seconds: Max time to wait

    Returns:
        Tuple of (success, message)
    """
    import time

    start_time = time.time()
    poll_interval = 2  # seconds

    while time.time() - start_time < timeout_seconds:
        try:
            disks = list_disks(user_id, config)
            disk = next((d for d in disks if d['name'] == disk_name), None)

            if operation_type == 'create':
                # For create, we're waiting for the disk to appear
                if disk is not None:
                    return True, f"Disk '{disk_name}' created successfully"

            elif operation_type == 'delete':
                # For delete, we're waiting for is_deleted to be True
                if disk is None:
                    # Disk no longer in list (shouldn't happen with soft delete)
                    return True, f"Disk '{disk_name}' deleted successfully"
                elif disk.get('is_deleted', False):
                    delete_date = disk.get('delete_date', 'in 30 days')
                    return True, f"Disk '{disk_name}' marked for deletion. Snapshots will be permanently deleted on {delete_date}"

            time.sleep(poll_interval)

        except Exception as e:
            # Continue polling on errors
            time.sleep(poll_interval)

    # Timeout
    if operation_type == 'create':
        return False, f"Timed out waiting for disk '{disk_name}' to be created. It may still be processing."
    else:
        return False, f"Timed out waiting for disk '{disk_name}' deletion to complete. It may still be processing."


def rename_disk(old_name: str, new_name: str, user_id: str, config: Config) -> bool:
    """
    Rename a disk by updating disk_name tags on all its snapshots.
    Returns True on success, False on failure.
    """
    ec2_client = get_ec2_client(config)

    # Validate new disk name
    if not re.match(r'^[a-zA-Z0-9_-]+$', new_name):
        print(f"Error: Disk name must contain only letters, numbers, hyphens, and underscores")
        return False

    # Check if old disk exists
    disks = list_disks(user_id, config)
    old_disk = next((d for d in disks if d['name'] == old_name), None)

    if not old_disk:
        print(f"Error: Disk '{old_name}' not found")
        return False

    # Check if new name already exists
    if any(d['name'] == new_name for d in disks):
        print(f"Error: Disk '{new_name}' already exists")
        return False

    # Check if disk is in use
    if old_disk['in_use']:
        print(f"Error: Cannot rename disk '{old_name}' - it is currently in use")
        print(f"Reservation ID: {old_disk['reservation_id']}")
        return False

    print(f"Renaming disk '{old_name}' to '{new_name}'...")

    try:
        # Find all snapshots for this disk
        response = ec2_client.describe_snapshots(
            OwnerIds=["self"],
            Filters=[
                {"Name": "tag:gpu-dev-user", "Values": [user_id]},
                {"Name": "tag:disk_name", "Values": [old_name]},
            ]
        )

        snapshots = response.get('Snapshots', [])

        if not snapshots:
            print(f"Warning: No snapshots found for disk '{old_name}'")
            return False

        # Update disk_name tag on each snapshot
        renamed_count = 0
        for snapshot in snapshots:
            snapshot_id = snapshot['SnapshotId']
            try:
                ec2_client.create_tags(
                    Resources=[snapshot_id],
                    Tags=[{"Key": "disk_name", "Value": new_name}]
                )
                print(f"  ✓ Updated snapshot {snapshot_id}")
                renamed_count += 1
            except Exception as e:
                print(f"  ✗ Error updating snapshot {snapshot_id}: {e}")

        print(f"✓ Successfully renamed disk to '{new_name}' ({renamed_count} snapshots updated)")
        return True

    except Exception as e:
        print(f"Error renaming disk: {e}")
        return False
