#!/usr/bin/env python3
"""
Migration script to snapshot existing volumes and tag them with disk_name.

This script:
1. Finds all EBS volumes with ManagedBy=gpu-dev-cli tag
2. Groups volumes by user (gpu-dev-user tag)
3. Deduplicates volumes restored from same source across AZs
4. Creates snapshots for each unique volume
5. Tags snapshots with disk_name (disk1, disk2, etc.)

Usage:
    python migrate_disks_to_named.py [--dry-run] [--region us-east-2]
"""

import boto3
import argparse
from datetime import datetime
from collections import defaultdict
import os


def migrate_disks(region='us-east-2', dry_run=True):
    """
    Migrate existing volumes to named disk system by creating snapshots.

    Args:
        region: AWS region
        dry_run: If True, only print what would be done without making changes
    """
    ec2_client = boto3.client('ec2', region_name=region)

    print(f"🔍 Scanning for gpu-dev volumes in {region}...")
    print(f"Mode: {'DRY RUN (no changes)' if dry_run else 'LIVE (will create snapshots and tags)'}\n")

    # Find all gpu-dev managed volumes
    response = ec2_client.describe_volumes(
        Filters=[
            {"Name": "tag:ManagedBy", "Values": ["gpu-dev-cli"]},
        ]
    )

    volumes = response.get('Volumes', [])
    print(f"Found {len(volumes)} gpu-dev managed volumes\n")

    # Initialize counters
    total_volumes_processed = 0
    total_snapshots_created = 0
    user_volumes = defaultdict(list)

    if not volumes:
        print("✅ Phase 1: No volumes to migrate (already done or no volumes exist)\n")
    else:
        print("⚠️  Phase 1: Found volumes that need migration\n")

        # Group volumes by user
        for volume in volumes:
            tags = {tag['Key']: tag['Value'] for tag in volume.get('Tags', [])}
            user_id = tags.get('gpu-dev-user')
            disk_name = tags.get('disk_name')

            if not user_id:
                print(f"⚠️  Volume {volume['VolumeId']} has no gpu-dev-user tag, skipping")
                continue

            # Skip volumes that already have disk_name (already part of named disk system)
            if disk_name:
                print(f"ℹ️  Volume {volume['VolumeId']} already has disk_name='{disk_name}', skipping")
                continue

            user_volumes[user_id].append(volume)

        if not user_volumes:
            print("✅ No volumes found for any users\n")
        else:
            print(f"📋 Found volumes for {len(user_volumes)} users:\n")

            # Process each user's volumes
            for user_id, user_vol_list in user_volumes.items():
                print(f"👤 User: {user_id}")
                print(f"   Volumes found: {len(user_vol_list)}")

                # Deduplicate volumes by RestoreFrom tag (same source snapshot across AZs)
                # Key: source_snapshot_id or volume_id, Value: list of volumes
                volume_groups = defaultdict(list)

                for volume in user_vol_list:
                    tags = {tag['Key']: tag['Value'] for tag in volume.get('Tags', [])}
                    source_snapshot = tags.get('RestoredFrom')

                    if source_snapshot:
                        # Group by source snapshot (same disk restored to different AZs)
                        volume_groups[source_snapshot].append(volume)
                    else:
                        # Unique volume (not restored from snapshot)
                        volume_groups[volume['VolumeId']].append(volume)

                print(f"   Unique disks (after deduplication): {len(volume_groups)}")

                # For each group, pick the volume with most recent data (sort by CreateTime)
                unique_volumes = []
                for group_id, vols in volume_groups.items():
                    # Sort by CreateTime (most recent first)
                    vols.sort(key=lambda v: v.get('CreateTime', datetime.min), reverse=True)
                    selected_vol = vols[0]
                    unique_volumes.append(selected_vol)

                    if len(vols) > 1:
                        # Show which volumes were deduplicated
                        print(f"   ℹ️  Found {len(vols)} volumes from same source:")
                        for vol in vols:
                            tags = {tag['Key']: tag['Value'] for tag in vol.get('Tags', [])}
                            marker = "✓ SELECTED" if vol == selected_vol else "  skipped"
                            print(f"      {vol['VolumeId']} in {vol['AvailabilityZone']} ({vol['State']}) - {marker}")

                # Sort unique volumes by creation time (oldest first) for naming
                unique_volumes.sort(key=lambda v: v.get('CreateTime', datetime.min))

                # Create snapshots and tag them
                print(f"\n   Creating snapshots:")
                for idx, volume in enumerate(unique_volumes, start=1):
                    volume_id = volume['VolumeId']
                    disk_name = f"disk{idx}"
                    state = volume['State']
                    size_gb = volume['Size']
                    created = volume.get('CreateTime', 'unknown')
                    az = volume.get('AvailabilityZone', 'unknown')

                    print(f"   • Volume {volume_id} ({size_gb}GB, {state}, {az})")
                    print(f"     → Creating snapshot with disk_name='{disk_name}'")

                    if not dry_run:
                        try:
                            # Create snapshot
                            snapshot_response = ec2_client.create_snapshot(
                                VolumeId=volume_id,
                                Description=f"Migration snapshot for {user_id} - {disk_name}",
                                TagSpecifications=[
                                    {
                                        'ResourceType': 'snapshot',
                                        'Tags': [
                                            {"Key": "disk_name", "Value": disk_name},
                                            {"Key": "gpu-dev-user", "Value": user_id},
                                            {"Key": "ManagedBy", "Value": "gpu-dev-cli"},
                                            {"Key": "migrated_at", "Value": str(int(datetime.now().timestamp()))},
                                            {"Key": "migration_source_volume", "Value": volume_id},
                                        ]
                                    }
                                ]
                            )
                            snapshot_id = snapshot_response['SnapshotId']
                            print(f"     ✓ Created snapshot {snapshot_id}")
                            total_snapshots_created += 1
                        except Exception as e:
                            print(f"     ✗ Error creating snapshot: {e}")
                            continue

                    total_volumes_processed += 1

                print()

    # Phase 2: Tag most recent large snapshot for each user
    print("\n" + "=" * 60)
    print("📦 Phase 2: Tagging Most Recent Snapshots")
    print("=" * 60)
    print("Finding snapshots that need disk_name tags...\n")

    largest_tagged_count = 0

    try:
        # Find all gpu-dev snapshots
        all_snapshots_response = ec2_client.describe_snapshots(
            OwnerIds=["self"],
            Filters=[
                {"Name": "tag-key", "Values": ["gpu-dev-user"]},
                {"Name": "status", "Values": ["completed"]},
            ]
        )

        all_snapshots = all_snapshots_response.get('Snapshots', [])
        print(f"Found {len(all_snapshots)} total gpu-dev snapshots\n")

        # Group by user and check for untagged snapshots
        user_all_snapshots = defaultdict(list)
        total_untagged = 0
        for snapshot in all_snapshots:
            tags = {tag['Key']: tag['Value'] for tag in snapshot.get('Tags', [])}
            user_id = tags.get('gpu-dev-user')
            if user_id:
                user_all_snapshots[user_id].append(snapshot)
                if 'disk_name' not in tags:
                    total_untagged += 1

        if total_untagged == 0:
            print("✅ Phase 2: All snapshots already have disk_name tags (already done)\n")
        else:
            print(f"⚠️  Phase 2: Found {total_untagged} snapshots that need disk_name tags\n")

            # Process each user's snapshots
            for user_id, user_snap_list in user_all_snapshots.items():
                # Check if user already has tagged snapshots
                tagged_snapshots = []
                untagged_snapshots = []

                for snap in user_snap_list:
                    tags = {tag['Key']: tag['Value'] for tag in snap.get('Tags', [])}
                    if 'disk_name' in tags:
                        tagged_snapshots.append((snap, tags['disk_name']))
                    else:
                        untagged_snapshots.append(snap)

                if not untagged_snapshots:
                    # All snapshots already tagged
                    continue

                print(f"👤 User: {user_id}")
                print(f"   Untagged snapshots: {len(untagged_snapshots)}")

                # Find most recent large untagged snapshot (likely has actual data)
                # Filter to snapshots >= 100GB (ignore tiny/empty volumes)
                large_snapshots = [s for s in untagged_snapshots if s.get('VolumeSize', 0) >= 100]

                if not large_snapshots:
                    print(f"   ⚠️  No large snapshots found (all < 100GB), skipping")
                    continue

                # Sort by most recent
                most_recent_snapshot = max(large_snapshots, key=lambda s: s['StartTime'])
                snapshot_id = most_recent_snapshot['SnapshotId']
                size_gb = most_recent_snapshot.get('VolumeSize', 0)
                start_time = most_recent_snapshot['StartTime']

                # Determine disk name
                if not tagged_snapshots:
                    disk_name = "default"
                else:
                    # Find next available disk number
                    existing_disk_nums = []
                    for _, name in tagged_snapshots:
                        if name.startswith('disk') and name[4:].isdigit():
                            existing_disk_nums.append(int(name[4:]))

                    if existing_disk_nums:
                        next_num = max(existing_disk_nums) + 1
                    else:
                        next_num = 1

                    disk_name = f"disk{next_num}"

                print(f"   📦 Most recent snapshot: {snapshot_id}")
                print(f"      Volume size: {size_gb} GB")
                print(f"      Created: {start_time}")
                print(f"      → Tagging as disk_name='{disk_name}'")

                if not dry_run:
                    try:
                        ec2_client.create_tags(
                            Resources=[snapshot_id],
                            Tags=[
                                {"Key": "disk_name", "Value": disk_name},
                                {"Key": "migrated_largest", "Value": "true"},
                            ]
                        )
                        print(f"      ✓ Tagged as '{disk_name}'")
                        largest_tagged_count += 1
                    except Exception as e:
                        print(f"      ✗ Error: {e}")
                else:
                    largest_tagged_count += 1

                print()

    except Exception as e:
        print(f"⚠️  Error in largest snapshot tagging: {e}\n")

    # Phase 3: Populate DynamoDB disks table
    print("\n" + "=" * 60)
    print("📊 Phase 3: Populating DynamoDB Disks Table")
    print("=" * 60)
    print("Scanning snapshots and populating disk metadata table...\n")

    dynamodb_entries_created = 0
    dynamodb_entries_updated = 0
    dynamodb_entries_skipped = 0

    try:
        dynamodb = boto3.resource('dynamodb', region_name=region)

        # Get table name from environment or use default
        table_name = os.environ.get('DISKS_TABLE_NAME', 'pytorch-gpu-dev-disks')
        disks_table = dynamodb.Table(table_name)

        print(f"Using DynamoDB table: {table_name}\n")

        # Get all completed snapshots with disk_name tag
        snapshots_response = ec2_client.describe_snapshots(
            OwnerIds=["self"],
            Filters=[
                {"Name": "tag-key", "Values": ["gpu-dev-user"]},
                {"Name": "tag-key", "Values": ["disk_name"]},
                {"Name": "status", "Values": ["completed"]},
            ]
        )

        snapshots = snapshots_response.get('Snapshots', [])
        print(f"Found {len(snapshots)} completed snapshots with disk_name tags\n")

        if not snapshots:
            print("✅ Phase 3: No snapshots found with disk_name tags (nothing to populate)\n")
        else:
            # Group snapshots by user and disk_name
            user_disk_snapshots = defaultdict(lambda: defaultdict(list))
            for snapshot in snapshots:
                tags = {tag['Key']: tag['Value'] for tag in snapshot.get('Tags', [])}
                user_id = tags.get('gpu-dev-user')
                disk_name = tags.get('disk_name')

                if user_id and disk_name:
                    user_disk_snapshots[user_id][disk_name].append(snapshot)

            # Process each user's disks
            for user_id, disks in user_disk_snapshots.items():
                print(f"👤 User: {user_id}")
                print(f"   Disks: {len(disks)}")

                for disk_name, disk_snapshots in disks.items():
                    # Sort by start time
                    disk_snapshots.sort(key=lambda s: s['StartTime'])

                    # Get metadata from snapshots
                    oldest_snapshot = disk_snapshots[0]
                    latest_snapshot = disk_snapshots[-1]

                    size_gb = latest_snapshot.get('VolumeSize', 0)
                    created_at = oldest_snapshot['StartTime'].isoformat()
                    last_used = latest_snapshot['StartTime'].isoformat()
                    snapshot_count = len(disk_snapshots)

                    # Extract disk_size from latest snapshot tags if available
                    latest_tags = {tag['Key']: tag['Value'] for tag in latest_snapshot.get('Tags', [])}
                    disk_size = latest_tags.get('disk_size', None)

                    print(f"   • {disk_name}: {size_gb}GB, {snapshot_count} snapshot(s)")
                    if disk_size:
                        print(f"     Disk usage: {disk_size}")

                    if not dry_run:
                        try:
                            # Check if entry already exists
                            response = disks_table.get_item(
                                Key={'user_id': user_id, 'disk_name': disk_name}
                            )

                            if 'Item' in response:
                                # Entry exists - update it
                                disks_table.update_item(
                                    Key={'user_id': user_id, 'disk_name': disk_name},
                                    UpdateExpression='SET size_gb = :size, snapshot_count = :count, last_used = :last, migrated = :migrated, migrated_at = :migrated_at' + (', disk_size = :disk_size' if disk_size else ''),
                                    ExpressionAttributeValues={
                                        ':size': size_gb,
                                        ':count': snapshot_count,
                                        ':last': last_used,
                                        ':migrated': True,
                                        ':migrated_at': datetime.now().isoformat(),
                                        **(  {':disk_size': disk_size} if disk_size else {})
                                    }
                                )
                                print(f"     ✓ Updated in DynamoDB")
                                dynamodb_entries_updated += 1
                            else:
                                # Entry doesn't exist - create it
                                item = {
                                    'user_id': user_id,
                                    'disk_name': disk_name,
                                    'size_gb': size_gb,
                                    'snapshot_count': snapshot_count,
                                    'created_at': created_at,
                                    'last_used': last_used,
                                    'in_use': False,  # Migration - not in use
                                    'migrated': True,
                                    'migrated_at': datetime.now().isoformat(),
                                }

                                # Add disk_size if available
                                if disk_size:
                                    item['disk_size'] = disk_size

                                disks_table.put_item(Item=item)
                                print(f"     ✓ Added to DynamoDB")
                                dynamodb_entries_created += 1
                        except Exception as e:
                            print(f"     ✗ Error adding to DynamoDB: {e}")
                    else:
                        dynamodb_entries_created += 1

                print()

    except Exception as e:
        print(f"⚠️  Error in DynamoDB population: {e}\n")

    # Summary
    print("=" * 60)
    print(f"📊 Migration Summary")
    print("=" * 60)
    print(f"Users processed: {len(user_volumes)}")
    print(f"Volumes processed: {total_volumes_processed}")
    if not dry_run:
        print(f"Snapshots created from volumes: {total_snapshots_created}")
        print(f"Largest snapshots tagged: {largest_tagged_count}")
        print(f"DynamoDB entries created: {dynamodb_entries_created}")
        print(f"DynamoDB entries updated: {dynamodb_entries_updated}")
    else:
        print(f"Snapshots that would be created: {total_volumes_processed}")
        print(f"Largest snapshots that would be tagged: {largest_tagged_count}")
        print(f"DynamoDB entries that would be created: {dynamodb_entries_created}")

    if dry_run:
        print("\n⚠️  This was a DRY RUN. No changes were made.")
        print("   Run with --no-dry-run to apply changes.")
    else:
        print("\n✅ Migration complete!")
        print("\nℹ️  Snapshots are being created in the background.")
        print("   Use 'aws ec2 describe-snapshots' to check status.")
        if largest_tagged_count > 0:
            print(f"   Tagged {largest_tagged_count} most recent snapshot(s) for data recovery.")
        if dynamodb_entries_created > 0 or dynamodb_entries_updated > 0:
            print(f"   DynamoDB: {dynamodb_entries_created} created, {dynamodb_entries_updated} updated.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Migrate existing gpu-dev volumes to named disk system"
    )
    parser.add_argument(
        "--region",
        default="us-east-2",
        help="AWS region (default: us-east-2)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=True,
        help="Dry run mode - show what would be done without making changes (default)"
    )
    parser.add_argument(
        "--no-dry-run",
        action="store_false",
        dest="dry_run",
        help="Actually apply the migration (no dry run)"
    )

    args = parser.parse_args()

    migrate_disks(region=args.region, dry_run=args.dry_run)
