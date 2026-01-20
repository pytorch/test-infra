#!/usr/bin/env python3
"""
Backfill content metadata for existing snapshots without content tracking.

This script:
1. Finds all snapshots without snapshot_content_s3 tag
2. Creates temporary volumes from snapshots
3. Attaches volumes to a worker EC2 instance
4. Lists disk contents via SSH
5. Uploads contents to S3
6. Tags snapshots with snapshot_content_s3
7. Updates DynamoDB disks table with latest_snapshot_content_s3
8. Cleans up temporary volumes

Prerequisites:
- An EC2 instance running in the same region (specify with --instance-id)
- SSH access to the EC2 instance (specify key with --ssh-key)
- Instance must have aws-cli installed

Usage:
    python backfill_snapshot_contents.py --instance-id i-xxxxx --ssh-key ~/.ssh/key.pem [--dry-run] [--region us-east-2]
"""

import boto3
import argparse
import subprocess
import time
import os
from datetime import datetime
from tqdm import tqdm
from collections import defaultdict


def run_ssh_command(instance_ip, ssh_key, command, timeout=120):
    """
    Run command on EC2 instance via SSH.
    Returns (success, stdout, stderr)
    """
    ssh_cmd = [
        "ssh",
        "-i", ssh_key,
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", f"ConnectTimeout=30",
        f"ec2-user@{instance_ip}",
        command
    ]

    try:
        result = subprocess.run(
            ssh_cmd,
            capture_output=True,
            text=True,
            timeout=timeout
        )
        return (result.returncode == 0, result.stdout, result.stderr)
    except subprocess.TimeoutExpired:
        return (False, "", "SSH command timed out")
    except Exception as e:
        return (False, "", str(e))


def backfill_snapshot_contents(region='us-east-2', instance_id=None, ssh_key=None, dry_run=True, bucket_name=None):
    """
    Backfill content metadata for existing snapshots.

    Args:
        region: AWS region
        instance_id: EC2 instance to use as worker
        ssh_key: Path to SSH private key for EC2 instance
        dry_run: If True, only print what would be done
        bucket_name: S3 bucket for content metadata (defaults to env var or pytorch-gpu-dev-disk-contents)
    """
    if not instance_id or not ssh_key:
        print("❌ Error: --instance-id and --ssh-key are required")
        return

    if not os.path.exists(ssh_key):
        print(f"❌ Error: SSH key not found at {ssh_key}")
        return

    ec2_client = boto3.client('ec2', region_name=region)
    s3_client = boto3.client('s3', region_name=region)
    dynamodb_client = boto3.client('dynamodb', region_name=region)
    disks_table_name = os.environ.get('DISKS_TABLE', 'pytorch-gpu-dev-disks')

    if not bucket_name:
        bucket_name = os.environ.get('DISK_CONTENTS_BUCKET', 'pytorch-gpu-dev-disk-contents')

    print(f"🔍 Backfilling snapshot content metadata in {region}...")
    print(f"Worker instance: {instance_id}")
    print(f"S3 bucket: {bucket_name}")
    print(f"Mode: {'DRY RUN (no changes)' if dry_run else 'LIVE (will create volumes and capture contents)'}\n")

    # Get instance details
    try:
        instance_response = ec2_client.describe_instances(InstanceIds=[instance_id])
        instance = instance_response['Reservations'][0]['Instances'][0]
        instance_az = instance['Placement']['AvailabilityZone']
        instance_ip = instance.get('PublicIpAddress') or instance.get('PrivateIpAddress')

        if not instance_ip:
            print(f"❌ Error: Could not find IP address for instance {instance_id}")
            return

        print(f"✓ Found worker instance in AZ {instance_az} with IP {instance_ip}\n")
    except Exception as e:
        print(f"❌ Error getting instance details: {e}")
        return

    # Test SSH connectivity
    print("🔌 Testing SSH connectivity...")
    success, stdout, stderr = run_ssh_command(instance_ip, ssh_key, "echo 'SSH OK'", timeout=10)
    if not success:
        print(f"❌ SSH connection failed: {stderr}")
        return
    print("✓ SSH connection successful\n")

    # Find LATEST snapshot per user/disk (matching gpu-dev disk list logic)
    print("📸 Finding latest snapshots per user/disk without content metadata...")
    try:
        all_snapshots = ec2_client.describe_snapshots(
            OwnerIds=["self"],
            Filters=[
                {"Name": "tag-key", "Values": ["gpu-dev-user"]},
                {"Name": "status", "Values": ["completed"]},
            ]
        )

        # Group snapshots by user_id + disk_name
        snapshot_groups = defaultdict(list)

        for snapshot in all_snapshots['Snapshots']:
            tags = {tag['Key']: tag['Value'] for tag in snapshot.get('Tags', [])}
            user_id = tags.get('gpu-dev-user', 'unknown')
            disk_name = tags.get('disk_name', 'default')
            key = f"{user_id}/{disk_name}"

            snapshot_groups[key].append({
                'snapshot_id': snapshot['SnapshotId'],
                'user_id': user_id,
                'disk_name': disk_name,
                'size': snapshot['VolumeSize'],
                'created': snapshot['StartTime'],
                'has_content': 'snapshot_content_s3' in tags
            })

        # Get only the LATEST snapshot per user/disk that doesn't have content
        snapshots_without_content = []
        for key, snapshots in snapshot_groups.items():
            # Sort by creation time (newest first)
            snapshots.sort(key=lambda s: s['created'], reverse=True)
            latest = snapshots[0]

            # Only add if it doesn't have content metadata
            if not latest['has_content']:
                snapshots_without_content.append(latest)

        print(f"Found {len(snapshots_without_content)} latest snapshots without content metadata")
        print(f"(out of {len(snapshot_groups)} total user/disk combinations)\n")

        if not snapshots_without_content:
            print("✓ All snapshots already have content metadata!")
            return

        # List all snapshots to be processed
        print("📋 Snapshots to process:")
        print("=" * 80)
        for idx, snap_info in enumerate(snapshots_without_content, 1):
            print(f"{idx}. {snap_info['snapshot_id']} - {snap_info['user_id']}/{snap_info['disk_name']} ({snap_info['size']}GB)")
        print("=" * 80)
        print()

    except Exception as e:
        print(f"❌ Error finding snapshots: {e}")
        return

    # Process each snapshot
    total_processed = 0
    total_failed = 0

    # Use tqdm for progress bar
    with tqdm(total=len(snapshots_without_content), desc="Processing snapshots", unit="snapshot") as pbar:
        for snap_info in snapshots_without_content:
            snapshot_id = snap_info['snapshot_id']
            user_id = snap_info['user_id']
            disk_name = snap_info['disk_name']
            size_gb = snap_info['size']

            pbar.set_description(f"Processing {user_id}/{disk_name}")

            if dry_run:
                pbar.write(f"📦 {snapshot_id} - {user_id}/{disk_name} ({size_gb}GB) [DRY RUN]")
                pbar.update(1)
                continue

            volume_id = None
            device_name = "/dev/xvdf"  # Use a consistent device name

            try:
                # Step 1: Create temporary volume from snapshot
                pbar.write(f"   • Creating volume from {snapshot_id}...")
                volume_response = ec2_client.create_volume(
                    AvailabilityZone=instance_az,
                    SnapshotId=snapshot_id,
                    VolumeType="gp3",
                    TagSpecifications=[{
                        'ResourceType': 'volume',
                        'Tags': [
                            {"Key": "Name", "Value": f"temp-content-capture-{snapshot_id}"},
                            {"Key": "Purpose", "Value": "temporary-content-capture"},
                        ]
                    }]
                )
                volume_id = volume_response['VolumeId']
                print(f"   ✓ Created volume {volume_id}")

                # Wait for volume to be available
                print(f"   • Waiting for volume to be available...")
                waiter = ec2_client.get_waiter('volume_available')
                waiter.wait(VolumeIds=[volume_id], WaiterConfig={'Delay': 5, 'MaxAttempts': 60})
                print(f"   ✓ Volume available")

                # Step 2: Attach volume to instance
                print(f"   • Attaching volume to instance...")
                ec2_client.attach_volume(
                    VolumeId=volume_id,
                    InstanceId=instance_id,
                    Device=device_name
                )

                # Wait for attachment
                time.sleep(5)
                waiter = ec2_client.get_waiter('volume_in_use')
                waiter.wait(VolumeIds=[volume_id], WaiterConfig={'Delay': 5, 'MaxAttempts': 60})
                print(f"   ✓ Volume attached")

                # Step 3: Mount volume and capture contents
                print(f"   • Capturing disk contents...")

                # Create mount point
                run_ssh_command(instance_ip, ssh_key, "sudo mkdir -p /mnt/temp_disk")

                # Mount volume (try ext4 first, then xfs)
                success, _, _ = run_ssh_command(
                    instance_ip, ssh_key,
                    f"sudo mount {device_name} /mnt/temp_disk 2>/dev/null || sudo mount -t xfs {device_name} /mnt/temp_disk"
                )

                if not success:
                    print(f"   ⚠ Could not mount volume - might be unformatted/empty")
                    contents = f"Snapshot {snapshot_id} could not be mounted - volume may be unformatted or empty.\n"
                else:
                    # List contents - exclude .oh-my-zsh/* and .git/* subdirectories, replace path with /home/dev
                    success, stdout, stderr = run_ssh_command(
                        instance_ip, ssh_key,
                        "sudo ls -lah /mnt/temp_disk | sed 's|/mnt/temp_disk|/home/dev|g' && echo '---' && "
                        "sudo find /mnt/temp_disk -maxdepth 3 \\( -name '.oh-my-zsh' -o -name '.git' \\) -prune -o -print 2>/dev/null | "
                        "sed 's|/mnt/temp_disk|/home/dev|g' | head -1000"
                    )

                    if success:
                        contents = stdout
                        print(f"   ✓ Captured {len(contents)} bytes of disk contents")
                    else:
                        contents = f"Failed to list contents: {stderr}\n"
                        print(f"   ⚠ Failed to list contents")

                    # Unmount
                    run_ssh_command(instance_ip, ssh_key, "sudo umount /mnt/temp_disk")

                # Step 4: Upload to S3
                print(f"   • Uploading to S3...")
                s3_key = f"{user_id}/{disk_name}/{snapshot_id}-contents.txt"
                s3_path = f"s3://{bucket_name}/{s3_key}"

                s3_client.put_object(
                    Bucket=bucket_name,
                    Key=s3_key,
                    Body=contents.encode('utf-8'),
                    ContentType='text/plain',
                    Metadata={
                        'user_id': user_id,
                        'disk_name': disk_name,
                        'snapshot_id': snapshot_id,
                        'backfilled_at': datetime.now().isoformat()
                    }
                )
                print(f"   ✓ Uploaded to {s3_path}")

                # Step 5: Tag snapshot
                print(f"   • Tagging snapshot with content metadata...")
                ec2_client.create_tags(
                    Resources=[snapshot_id],
                    Tags=[{"Key": "snapshot_content_s3", "Value": s3_path}]
                )
                print(f"   ✓ Tagged snapshot")

                # Step 6: Update DynamoDB disks table (only if entry exists)
                print(f"   • Updating DynamoDB disks table...")
                try:
                    dynamodb_client.update_item(
                        TableName=disks_table_name,
                        Key={
                            'user_id': {'S': user_id},
                            'disk_name': {'S': disk_name}
                        },
                        UpdateExpression='SET latest_snapshot_content_s3 = :s3path',
                        ExpressionAttributeValues={
                            ':s3path': {'S': s3_path}
                        },
                        ConditionExpression='attribute_exists(user_id)'  # Only update existing entries
                    )
                    print(f"   ✓ Updated DynamoDB")
                except dynamodb_client.exceptions.ConditionalCheckFailedException:
                    print(f"   ⚠ Disk entry not in DynamoDB (skipped)")
                except Exception as ddb_error:
                    print(f"   ⚠ Failed to update DynamoDB: {ddb_error}")

                # Step 7: Detach and delete volume
                print(f"   • Cleaning up temporary volume...")
                ec2_client.detach_volume(VolumeId=volume_id)
                time.sleep(3)

                # Wait for detachment
                waiter = ec2_client.get_waiter('volume_available')
                waiter.wait(VolumeIds=[volume_id], WaiterConfig={'Delay': 5, 'MaxAttempts': 60})

                ec2_client.delete_volume(VolumeId=volume_id)
                print(f"   ✓ Cleaned up volume")

                total_processed += 1
                pbar.write(f"   ✅ Successfully processed {snapshot_id}")
                pbar.update(1)

            except Exception as e:
                pbar.write(f"   ❌ Error processing snapshot: {e}")
                total_failed += 1
                pbar.update(1)

                # Cleanup on error
                if volume_id:
                    try:
                        print(f"   • Attempting cleanup of volume {volume_id}...")
                        # Try to unmount
                        run_ssh_command(instance_ip, ssh_key, "sudo umount /mnt/temp_disk 2>/dev/null")
                        # Try to detach
                        ec2_client.detach_volume(VolumeId=volume_id, Force=True)
                        time.sleep(5)
                        # Try to delete
                        ec2_client.delete_volume(VolumeId=volume_id)
                        print(f"   ✓ Cleanup successful")
                    except Exception as cleanup_error:
                        pbar.write(f"   ⚠ Cleanup failed: {cleanup_error}")
                        pbar.write(f"   ⚠ Manual cleanup required for volume {volume_id}")

    # Summary
    print("\n" + "=" * 60)
    print("📊 Summary")
    print("=" * 60)
    print(f"Total snapshots found: {len(snapshots_without_content)}")
    print(f"Successfully processed: {total_processed}")
    print(f"Failed: {total_failed}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill content metadata for existing snapshots")
    parser.add_argument('--instance-id', required=True, help='EC2 instance ID to use as worker')
    parser.add_argument('--ssh-key', required=True, help='Path to SSH private key for EC2 instance')
    parser.add_argument('--region', default='us-east-2', help='AWS region (default: us-east-2)')
    parser.add_argument('--bucket', help='S3 bucket name (defaults to DISK_CONTENTS_BUCKET env var)')
    parser.add_argument('--dry-run', action='store_true', help='Print what would be done without making changes')

    args = parser.parse_args()

    backfill_snapshot_contents(
        region=args.region,
        instance_id=args.instance_id,
        ssh_key=args.ssh_key,
        dry_run=args.dry_run,
        bucket_name=args.bucket
    )
