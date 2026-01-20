# GPU-Dev Volume & Snapshot Cleanup Guide

## Problem

Due to race conditions, some users ended up with multiple EBS volumes in the same AZ. This caused the wrong (empty) volume to be snapshotted during AZ migrations, leading to data loss.

## Detection

Run the detection script to find affected users:

```bash
cd terraform-gpu-devservers/scripts
./detect_empty_volumes.sh
```

This will show:
- Users with multiple volumes in the same AZ
- Orphaned snapshots from deleted volumes

## Manual Cleanup Process

### Step 1: Identify the correct volume with data

For each user with multiple volumes in the same AZ:

```bash
# List all volumes for a user
aws ec2 describe-volumes \
  --region us-east-2 \
  --filters "Name=tag:gpu-dev-user,Values=USER_EMAIL@meta.com" \
  --query 'Volumes[*].[VolumeId,AvailabilityZone,State,CreateTime,Size]' \
  --output table

# For each volume, check if it has snapshots (volumes with snapshots likely have data)
aws ec2 describe-snapshots \
  --region us-east-2 \
  --filters "Name=volume-id,Values=vol-XXXXXXXX" \
  --query 'Snapshots[*].[SnapshotId,StartTime,State]' \
  --output table
```

**Rule of thumb:**
- **Keep the OLDEST volume** - it's been used longer and likely has data
- **Delete newer volumes** if they have no snapshots or were created very recently (indicating they're empty)

### Step 2: Delete empty duplicate volumes

For **available** (not in-use) volumes that are confirmed empty:

```bash
aws ec2 delete-volume --region us-east-2 --volume-id vol-XXXXXXXX
```

⚠️ **DO NOT delete in-use volumes** - cancel the reservation first

### Step 3: Clean up orphaned snapshots

Find snapshots from volumes that no longer exist:

```bash
# Get all gpu-dev snapshots
aws ec2 describe-snapshots \
  --region us-east-2 \
  --owner-ids self \
  --filters "Name=tag-key,Values=gpu-dev-user" \
  --query 'Snapshots[*].[SnapshotId,VolumeId,StartTime,VolumeSize]' \
  --output table

# Try to describe the source volume (if it fails, it's orphaned)
aws ec2 describe-volumes --region us-east-2 --volume-ids vol-XXXXXXXX
```

Delete orphaned snapshots that are:
- More than 7 days old
- From volumes that no longer exist
- NOT the most recent snapshot for any user (keep at least 1 good snapshot)

```bash
aws ec2 delete-snapshot --region us-east-2 --snapshot-id snap-XXXXXXXX
```

## Your Current Situation (wouterdevriendt@meta.com)

Based on logs, here's your state:

### Volumes:
- `vol-0df7802083b931ac8` (us-east-2a, available) - **HAS YOUR DATA** (from T4 session at 23:50)
- `vol-0200f86bc071ca25a` (us-east-2c, in-use) - empty (current H200 session, wrong snapshot)

### Snapshots:
- `snap-05b2205a998491a79` (from vol-0df7802083b931ac8) - **GOOD - has your data**
- `snap-05521009b69d84803` (from vol-0355d8f9055b7f56a) - BAD - empty volume snapshot
- Older snapshots - can likely be deleted

### Your Cleanup Steps:

1. **Cancel current H200 reservation:**
   ```bash
   gpu-dev cancel 5d37e257
   ```

2. **Delete the bad volume in us-east-2c:**
   ```bash
   aws ec2 delete-volume --region us-east-2 --volume-id vol-0200f86bc071ca25a
   ```

3. **Create new volume in us-east-2c from GOOD snapshot:**
   ```bash
   aws ec2 create-volume \
     --region us-east-2 \
     --availability-zone us-east-2c \
     --snapshot-id snap-05b2205a998491a79 \
     --volume-type gp3 \
     --iops 3000 \
     --throughput 125 \
     --size 1024 \
     --tag-specifications 'ResourceType=volume,Tags=[{Key=gpu-dev-user,Value=wouterdevriendt@meta.com},{Key=Name,Value=gpu-dev-persistent-wouterdevriendt}]'
   ```

4. **Delete the old empty snapshot:**
   ```bash
   aws ec2 delete-snapshot --region us-east-2 --snapshot-id snap-05521009b69d84803
   ```

5. **Make new H200 reservation:**
   ```bash
   gpu-dev reserve --gpu-type h200 --gpu-count 1 --hours 1
   ```

## Prevention

The `min()` fix we deployed should help, but the real solution is:
- Prevent multiple volumes in same AZ (add locking to volume creation)
- Always verify volume has snapshots before migrating
- Add volume "emptiness" detection before selecting which to snapshot

## Scripts Provided

- `detect_empty_volumes.sh` - Detect users with duplicate volumes
- `cleanup_empty_volumes.sh` - Generate cleanup suggestions (review before running)
