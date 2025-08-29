"""
Shared snapshot utilities for GPU development server lambdas
"""

import boto3
import time
import logging

logger = logging.getLogger(__name__)
ec2_client = boto3.client("ec2")


def safe_create_snapshot(volume_id, user_id, snapshot_type="shutdown"):
    """
    Safely create snapshot, avoiding duplicates if one is already in progress.
    Returns (snapshot_id, was_created)
    """
    try:
        logger.info(f"Checking for existing snapshots for volume {volume_id}")

        # Check for any in-progress snapshots for this volume
        ongoing_response = ec2_client.describe_snapshots(
            OwnerIds=["self"],
            Filters=[
                {"Name": "volume-id", "Values": [volume_id]},
                {"Name": "status", "Values": ["pending"]}
            ]
        )

        ongoing_snapshots = ongoing_response.get('Snapshots', [])
        if ongoing_snapshots:
            latest_ongoing = max(ongoing_snapshots, key=lambda s: s['StartTime'])
            logger.info(f"Found ongoing snapshot {latest_ongoing['SnapshotId']} for volume {volume_id}")
            return latest_ongoing['SnapshotId'], False

        # No ongoing snapshots - create a new one
        logger.info(f"Creating new {snapshot_type} snapshot for volume {volume_id}")

        timestamp = int(time.time())

        snapshot_response = ec2_client.create_snapshot(
            VolumeId=volume_id,
            Description=f"gpu-dev {snapshot_type} snapshot for {user_id}",
            TagSpecifications=[{
                "ResourceType": "snapshot",
                "Tags": [
                    {"Key": "Name", "Value": f"gpu-dev-{snapshot_type}-{user_id.split('@')[0]}-{timestamp}"},
                    {"Key": "gpu-dev-user", "Value": user_id},
                    {"Key": "gpu-dev-snapshot-type", "Value": snapshot_type},
                    {"Key": "SnapshotType", "Value": snapshot_type},
                ]
            }]
        )

        snapshot_id = snapshot_response["SnapshotId"]
        logger.info(f"Created new snapshot {snapshot_id} for volume {volume_id}")
        return snapshot_id, True

    except Exception as e:
        logger.error(f"Error creating snapshot for volume {volume_id}: {str(e)}")
        return None, False


def create_pod_shutdown_snapshot(volume_id, user_id, snapshot_type="shutdown"):
    """
    Create a snapshot when pod is shutting down.
    """
    try:
        if not volume_id:
            logger.info(f"No persistent volume for user {user_id} - skipping {snapshot_type} snapshot")
            return None

        logger.info(f"Creating {snapshot_type} snapshot for user {user_id}, volume {volume_id}")

        # Create snapshot (or get existing one if in progress)
        snapshot_id, was_created = safe_create_snapshot(volume_id, user_id, snapshot_type)

        if was_created:
            logger.info(f"Started {snapshot_type} snapshot {snapshot_id} for user {user_id}")
        else:
            logger.info(f"Using existing snapshot {snapshot_id} for user {user_id}")

        return snapshot_id

    except Exception as e:
        logger.error(f"Error creating {snapshot_type} snapshot: {str(e)}")
        return None


def cleanup_old_snapshots(user_id, keep_count=3, max_age_days=7):
    """
    Clean up old snapshots for a user, keeping only the most recent ones.
    Keeps 'keep_count' newest snapshots and deletes any older than max_age_days.
    Returns number of snapshots deleted.
    """
    try:
        from datetime import datetime, timedelta

        logger.info(f"Cleaning up old snapshots for user {user_id}")

        # Get all snapshots for this user
        response = ec2_client.describe_snapshots(
            OwnerIds=["self"],
            Filters=[
                {"Name": "tag:gpu-dev-user", "Values": [user_id]},
                {"Name": "status", "Values": ["completed"]}
            ]
        )

        snapshots = response.get('Snapshots', [])
        if len(snapshots) <= keep_count:
            logger.debug(f"User {user_id} has {len(snapshots)} snapshots, no cleanup needed")
            return 0

        # Sort by creation time (newest first)
        snapshots.sort(key=lambda s: s['StartTime'], reverse=True)

        cutoff_date = datetime.now() - timedelta(days=max_age_days)
        deleted_count = 0

        for i, snapshot in enumerate(snapshots):
            snapshot_id = snapshot['SnapshotId']
            snapshot_date = snapshot['StartTime'].replace(tzinfo=None)

            # Keep the newest 'keep_count' snapshots
            if i < keep_count:
                logger.debug(f"Keeping recent snapshot {snapshot_id}")
                continue

            # Delete if older than cutoff date or beyond keep_count
            if snapshot_date < cutoff_date or i >= keep_count:
                try:
                    logger.info(f"Deleting old snapshot {snapshot_id} from {snapshot_date}")
                    ec2_client.delete_snapshot(SnapshotId=snapshot_id)
                    deleted_count += 1
                except Exception as delete_error:
                    logger.warning(f"Could not delete snapshot {snapshot_id}: {delete_error}")

        logger.info(f"Cleaned up {deleted_count} old snapshots for user {user_id}")
        return deleted_count

    except Exception as e:
        logger.error(f"Error cleaning up snapshots for user {user_id}: {str(e)}")
        return 0


def get_latest_snapshot(user_id, volume_id=None, include_pending=False):
    """
    Get the most recent snapshot for a user.
    If volume_id provided, gets snapshots for that specific volume.
    If include_pending is True, includes pending snapshots.
    Returns the latest snapshot dict or None.
    """
    try:
        status_values = ["completed"]
        if include_pending:
            status_values.extend(["pending"])

        filters = [
            {"Name": "tag:gpu-dev-user", "Values": [user_id]},
            {"Name": "status", "Values": status_values},
        ]

        if volume_id:
            filters.append({"Name": "volume-id", "Values": [volume_id]})

        response = ec2_client.describe_snapshots(
            OwnerIds=["self"],
            Filters=filters
        )

        snapshots = response.get('Snapshots', [])
        if not snapshots:
            status_desc = "completed or pending" if include_pending else "completed"
            logger.info(f"No {status_desc} snapshots found for user {user_id}")
            return None

        # Get most recent snapshot by start time
        latest_snapshot = max(snapshots, key=lambda s: s['StartTime'])
        logger.info(
            f"Found latest snapshot {latest_snapshot['SnapshotId']} ({latest_snapshot['State']}) for user {user_id}")
        return latest_snapshot

    except Exception as e:
        logger.error(f"Error finding latest snapshot for user {user_id}: {str(e)}")
        return None


def cleanup_all_user_snapshots():
    """
    Run scheduled cleanup of old snapshots for all users.
    This runs separately from expiry processing.
    """
    try:
        logger.info("Starting scheduled snapshot cleanup for all users")

        # Get all gpu-dev snapshots grouped by user
        response = ec2_client.describe_snapshots(
            OwnerIds=["self"],
            Filters=[
                {"Name": "tag-key", "Values": ["gpu-dev-user"]},
            ]
        )

        # Group snapshots by user
        users_snapshots = {}
        for snapshot in response.get('Snapshots', []):
            user_tag = next((tag['Value'] for tag in snapshot['Tags'] if tag['Key'] == 'gpu-dev-user'), None)
            if user_tag:
                if user_tag not in users_snapshots:
                    users_snapshots[user_tag] = []
                users_snapshots[user_tag].append(snapshot)

        total_deleted = 0
        for user_id in users_snapshots:
            deleted_count = cleanup_old_snapshots(user_id)
            total_deleted += deleted_count

        logger.info(
            f"Scheduled snapshot cleanup completed: cleaned up {total_deleted} snapshots for {len(users_snapshots)} users")
        return total_deleted

    except Exception as e:
        logger.error(f"Error during scheduled snapshot cleanup: {str(e)}")
        return 0
