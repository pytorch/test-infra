#!/bin/bash
# Script to detect empty/duplicate volumes and snapshots for gpu-dev users

REGION="us-east-2"

echo "=== Checking for users with multiple volumes in the same AZ ==="
echo ""

# Get all gpu-dev volumes
aws ec2 describe-volumes \
  --region $REGION \
  --filters "Name=tag-key,Values=gpu-dev-user" \
  --query 'Volumes[*].[Tags[?Key==`gpu-dev-user`].Value|[0],VolumeId,AvailabilityZone,State,CreateTime,Size]' \
  --output text | sort > /tmp/all_volumes.txt

# Find users with multiple volumes in same AZ
echo "Users with multiple volumes in same AZ:"
awk '{print $1,$3}' /tmp/all_volumes.txt | sort | uniq -c | awk '$1 > 1 {print}'

echo ""
echo "=== Detailed volume information for users with duplicates ==="
echo ""

# For each user with duplicates, show detailed info
awk '{print $1,$3}' /tmp/all_volumes.txt | sort | uniq -c | awk '$1 > 1 {print $2}' | while read user; do
  echo "User: $user"
  grep "^$user" /tmp/all_volumes.txt | while IFS=$'\t' read user_id vol_id az state created size; do
    echo "  Volume: $vol_id ($az, $state, created $created, ${size}GB)"

    # Check for snapshots from this volume with detailed size info
    echo "    Snapshots from this volume:"
    aws ec2 describe-snapshots \
      --region $REGION \
      --filters "Name=volume-id,Values=$vol_id" "Name=status,Values=completed" \
      --query 'Snapshots[*].[SnapshotId,StartTime,VolumeSize,DataEncryptionKeyId]' \
      --output text 2>/dev/null | while IFS=$'\t' read snap_id snap_time snap_size encryption; do
      if [ -n "$snap_id" ]; then
        # Try to get actual snapshot size (stored data) - this requires describe-snapshot-attribute
        # Note: AWS doesn't expose actual stored size easily, so we show VolumeSize
        echo "      • $snap_id (${snap_size}GB volume, created $snap_time)"
      else
        echo "      • None"
      fi
    done

    # If no snapshots were found, print a message
    snap_count=$(aws ec2 describe-snapshots \
      --region $REGION \
      --filters "Name=volume-id,Values=$vol_id" "Name=status,Values=completed" \
      --query 'length(Snapshots)' \
      --output text 2>/dev/null)
    if [ "$snap_count" = "0" ]; then
      echo "      • None (likely empty/new volume - safe to delete)"
    fi
  done
  echo ""
done

echo "=== Checking for orphaned snapshots from deleted volumes ==="
echo ""

# Get all snapshots
aws ec2 describe-snapshots \
  --region $REGION \
  --owner-ids self \
  --filters "Name=tag-key,Values=gpu-dev-user" \
  --query 'Snapshots[*].[SnapshotId,VolumeId,VolumeSize,StartTime,State,Tags[?Key==`gpu-dev-user`].Value|[0]]' \
  --output text | while IFS=$'\t' read snap_id vol_id size start_time state user; do

  # Check if source volume still exists
  vol_exists=$(aws ec2 describe-volumes \
    --region $REGION \
    --volume-ids $vol_id 2>/dev/null | jq -r '.Volumes | length')

  if [ "$vol_exists" = "0" ]; then
    echo "Orphaned snapshot: $snap_id (from deleted volume $vol_id, user: $user, created: $start_time)"
  fi
done

echo ""
echo "=== All snapshots sorted by size (smallest first) ==="
echo ""

# Get all gpu-dev snapshots with size info
aws ec2 describe-snapshots \
  --region $REGION \
  --owner-ids self \
  --filters "Name=tag-key,Values=gpu-dev-user" "Name=status,Values=completed" \
  --query 'Snapshots[*].[VolumeSize,SnapshotId,VolumeId,StartTime,Tags[?Key==`gpu-dev-user`].Value|[0]]' \
  --output text | sort -n | while IFS=$'\t' read size snap_id vol_id start_time user; do

  # Check if source volume still exists
  vol_exists=$(aws ec2 describe-volumes \
    --region $REGION \
    --volume-ids $vol_id 2>&1 | grep -c "InvalidVolume.NotFound")

  vol_status="volume exists"
  delete_cmd=""
  if [ "$vol_exists" -gt "0" ]; then
    vol_status="⚠️  volume deleted (orphaned)"
    delete_cmd="  → aws ec2 delete-snapshot --region $REGION --snapshot-id $snap_id"
  fi

  echo "${size}GB | $snap_id | from $vol_id | $start_time | user: $user | $vol_status"
  if [ -n "$delete_cmd" ]; then
    echo "$delete_cmd"
  fi
done

echo ""
echo "=== Done ==="
