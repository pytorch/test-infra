#!/usr/bin/env python3
"""
Script to find and tag the largest snapshot for each user.

This script:
1. Finds all snapshots for gpu-dev users
2. Groups by user
3. Finds the largest snapshot (by VolumeSize) for each user
4. Tags it as "default" disk if no disk_name exists

Usage:
    python tag_largest_snapshots.py [--dry-run] [--region us-west-1]
"""

import boto3
import argparse
from collections import defaultdict


def tag_largest_snapshots(region='us-west-1', dry_run=True):
    """
    Find and tag the largest snapshot for each user.

    Args:
        region: AWS region
        dry_run: If True, only print what would be done without making changes
    """
    ec2_client = boto3.client('ec2', region_name=region)

    print(f"🔍 Scanning for gpu-dev snapshots in {region}...")
    print(f"Mode: {'DRY RUN (no changes)' if dry_run else 'LIVE (will tag snapshots)'}\n")

    # Find all gpu-dev snapshots
    response = ec2_client.describe_snapshots(
        OwnerIds=["self"],
        Filters=[
            {"Name": "tag-key", "Values": ["gpu-dev-user"]},
            {"Name": "status", "Values": ["completed"]},
        ]
    )

    snapshots = response.get('Snapshots', [])
    print(f"Found {len(snapshots)} completed snapshots\n")

    if not snapshots:
        print("✅ No snapshots to process")
        return

    # Group snapshots by user
    user_snapshots = defaultdict(list)
    for snapshot in snapshots:
        tags = {tag['Key']: tag['Value'] for tag in snapshot.get('Tags', [])}
        user_id = tags.get('gpu-dev-user')

        if not user_id:
            continue

        user_snapshots[user_id].append(snapshot)

    print(f"📋 Found snapshots for {len(user_snapshots)} users:\n")

    # Process each user
    total_tagged = 0

    for user_id, user_snap_list in user_snapshots.items():
        print(f"👤 User: {user_id}")
        print(f"   Total snapshots: {len(user_snap_list)}")

        # Check if user already has any snapshot with disk_name tag
        tagged_snapshots = []
        untagged_snapshots = []

        for snap in user_snap_list:
            tags = {tag['Key']: tag['Value'] for tag in snap.get('Tags', [])}
            if 'disk_name' in tags:
                tagged_snapshots.append((snap, tags['disk_name']))
            else:
                untagged_snapshots.append(snap)

        if tagged_snapshots:
            print(f"   ✓ Already has {len(tagged_snapshots)} tagged snapshot(s):")
            disk_names = set(name for _, name in tagged_snapshots)
            for disk_name in sorted(disk_names):
                count = sum(1 for _, n in tagged_snapshots if n == disk_name)
                print(f"      - {disk_name}: {count} snapshot(s)")

        if not untagged_snapshots:
            print(f"   → Skipping (all snapshots already tagged)\n")
            continue

        # Find largest untagged snapshot
        largest_snapshot = max(untagged_snapshots, key=lambda s: s.get('VolumeSize', 0))
        snapshot_id = largest_snapshot['SnapshotId']
        size_gb = largest_snapshot.get('VolumeSize', 0)
        start_time = largest_snapshot['StartTime']

        # Determine disk name - use "default" if no tagged snapshots exist,
        # otherwise use next available number
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

        print(f"   📦 Largest untagged snapshot:")
        print(f"      ID: {snapshot_id}")
        print(f"      Size: {size_gb} GB")
        print(f"      Created: {start_time}")
        print(f"      → Will tag as disk_name='{disk_name}'")

        if dry_run:
            # Count this for dry-run summary
            total_tagged += 1

        if not dry_run:
            try:
                ec2_client.create_tags(
                    Resources=[snapshot_id],
                    Tags=[
                        {"Key": "disk_name", "Value": disk_name},
                        {"Key": "migrated_largest", "Value": "true"},
                        {"Key": "migration_reason", "Value": "largest_snapshot"},
                    ]
                )
                print(f"      ✓ Tagged snapshot {snapshot_id} as '{disk_name}'")
                total_tagged += 1
            except Exception as e:
                print(f"      ✗ Error tagging snapshot: {e}")

        print()

    # Summary
    print("=" * 60)
    print(f"📊 Summary")
    print("=" * 60)
    print(f"Users processed: {len(user_snapshots)}")
    if not dry_run:
        print(f"Snapshots tagged: {total_tagged}")
    else:
        print(f"Snapshots that would be tagged: {total_tagged}")

    if dry_run:
        print("\n⚠️  This was a DRY RUN. No changes were made.")
        print("   Run with --no-dry-run to apply changes.")
    else:
        print("\n✅ Migration complete!")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Find and tag largest snapshot for each user"
    )
    parser.add_argument(
        "--region",
        default="us-west-1",
        help="AWS region (default: us-west-1)"
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

    tag_largest_snapshots(region=args.region, dry_run=args.dry_run)
