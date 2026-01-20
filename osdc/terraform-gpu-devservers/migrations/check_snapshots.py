#!/usr/bin/env python3
import boto3
from collections import defaultdict

region = 'us-east-2'
ec2_client = boto3.client('ec2', region_name=region)

print("📸 Querying all snapshots...")
all_snapshots = ec2_client.describe_snapshots(
    OwnerIds=["self"],
    Filters=[
        {"Name": "tag-key", "Values": ["gpu-dev-user"]},
        {"Name": "status", "Values": ["completed"]},
    ]
)

print(f"Total snapshots: {len(all_snapshots['Snapshots'])}\n")

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

print(f"Unique user/disk combinations: {len(snapshot_groups)}\n")
print("=" * 80)

# Get only the LATEST snapshot per user/disk that doesn't have content
snapshots_to_process = []
for key, snapshots in snapshot_groups.items():
    # Sort by creation time (newest first)
    snapshots.sort(key=lambda s: s['created'], reverse=True)
    latest = snapshots[0]
    
    status = "✓ Has content" if latest['has_content'] else "✗ Needs content"
    print(f"{key:40} {status:20} ({len(snapshots)} total snapshots)")
    
    # Only add if it doesn't have content metadata
    if not latest['has_content']:
        snapshots_to_process.append(latest)

print("=" * 80)
print(f"\n📋 Summary:")
print(f"  • Total snapshots in AWS: {len(all_snapshots['Snapshots'])}")
print(f"  • Unique user/disk combinations: {len(snapshot_groups)}")
print(f"  • Latest snapshots needing content: {len(snapshots_to_process)}")
print(f"\n🎯 Will process {len(snapshots_to_process)} snapshots:\n")

for snap in snapshots_to_process:
    print(f"  • {snap['snapshot_id']} - {snap['user_id']}/{snap['disk_name']} ({snap['size']}GB)")
