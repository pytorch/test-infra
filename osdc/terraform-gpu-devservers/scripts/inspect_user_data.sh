#!/bin/bash
# Script to inspect all volumes and snapshots for a specific user
# Usage: ./inspect_user_data.sh user@email.com

if [ -z "$1" ]; then
  echo "Usage: $0 USER_EMAIL"
  echo "Example: $0 wouterdevriendt@meta.com"
  exit 1
fi

USER_EMAIL="$1"
REGION="us-east-2"

echo "=== Inspecting data for user: $USER_EMAIL ==="
echo ""

# Simple approach: Use an existing GPU node from the cluster
echo "Finding available GPU node..."
NODE_IP=$(kubectl get nodes -l node.kubernetes.io/instance-type -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')
NODE_NAME=$(kubectl get nodes -l node.kubernetes.io/instance-type -o jsonpath='{.items[0].metadata.name}')

if [ -z "$NODE_IP" ]; then
  echo "❌ No nodes found in cluster"
  exit 1
fi

echo "Using node: $NODE_NAME ($NODE_IP)"
echo ""

# Function to inspect a volume by mounting it to a pod
inspect_volume() {
  local vol_id=$1
  local vol_type=$2  # "volume" or "snapshot"
  local source_info=$3

  # Generate unique names to avoid conflicts
  local timestamp=$(date +%s)
  local unique_suffix="${timestamp}-$(echo $vol_id | tail -c 6)"
  local pod_name="volume-inspector-$unique_suffix"
  local pvc_name="inspect-pvc-$unique_suffix"
  local pv_name="inspect-pv-$unique_suffix"

  echo "  Creating inspection pod ($pod_name)..."

  # First, ensure any old resources are gone
  kubectl delete pod $pod_name -n gpu-dev >/dev/null 2>&1
  kubectl delete pvc $pvc_name -n gpu-dev >/dev/null 2>&1
  kubectl delete pv $pv_name >/dev/null 2>&1
  sleep 2

  # Create a simple pod that mounts the volume and lists contents
  cat <<EOF | kubectl apply -f - >/dev/null
apiVersion: v1
kind: PersistentVolume
metadata:
  name: $pv_name
spec:
  capacity:
    storage: 100Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Delete
  storageClassName: ebs-sc
  csi:
    driver: ebs.csi.aws.com
    volumeHandle: $vol_id
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $pvc_name
  namespace: gpu-dev
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: ebs-sc
  volumeName: $pv_name
  resources:
    requests:
      storage: 100Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: $pod_name
  namespace: gpu-dev
spec:
  nodeSelector:
    kubernetes.io/hostname: $NODE_NAME
  containers:
  - name: inspector
    image: busybox
    command: ['sh', '-c', 'sleep 3600']
    volumeMounts:
    - name: inspect-vol
      mountPath: /inspect
  volumes:
  - name: inspect-vol
    persistentVolumeClaim:
      claimName: $pvc_name
EOF

  echo "  Waiting for pod to be ready..."
  kubectl wait --for=condition=ready pod/$pod_name -n gpu-dev --timeout=60s >/dev/null 2>&1

  if [ $? -eq 0 ]; then
    echo ""
    echo "  === Contents of $vol_type $source_info ==="
    kubectl exec -n gpu-dev $pod_name -- ls -lh /inspect/ 2>/dev/null || echo "  ❌ Failed to list contents"

    echo ""
    echo "  === Disk usage ==="
    kubectl exec -n gpu-dev $pod_name -- sh -c 'cd /inspect && du -sh * 2>/dev/null | sort -h' || echo "  (empty or no files)"
    echo ""
  else
    echo "  ❌ Failed to mount volume"
  fi

  # Async cleanup - start deletion and don't wait
  echo "  Cleaning up (async)..."
  (
    kubectl delete pod $pod_name -n gpu-dev >/dev/null 2>&1
    sleep 5  # Wait longer for pod to fully detach volume
    kubectl delete pvc $pvc_name -n gpu-dev >/dev/null 2>&1
    sleep 3  # Wait for PVC deletion to release volume
    kubectl delete pv $pv_name >/dev/null 2>&1
  ) &

  # Just a brief pause to let deletion start
  sleep 1
}

echo "=== Volumes for user $USER_EMAIL ==="
echo ""

# Get all volumes for this user
aws ec2 describe-volumes \
  --region $REGION \
  --filters "Name=tag:gpu-dev-user,Values=$USER_EMAIL" \
  --query 'Volumes[*].[VolumeId,AvailabilityZone,State,CreateTime,Size]' \
  --output text | while IFS=$'\t' read vol_id vol_az state created size; do

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Volume: $vol_id"
  echo "  AZ: $vol_az"
  echo "  State: $state"
  echo "  Created: $created"
  echo "  Size: ${size}GB"
  echo ""

  if [ "$state" = "in-use" ]; then
    echo "  ⚠️  Volume is in-use, skipping (currently attached to a pod)"
    echo ""
    continue
  fi

  # Get instance AZ for this node
  INSTANCE_ID=$(kubectl get node $NODE_NAME -o jsonpath='{.spec.providerID}' | cut -d'/' -f5)
  INSTANCE_AZ=$(aws ec2 describe-instances --region $REGION --instance-ids $INSTANCE_ID --query 'Reservations[0].Instances[0].Placement.AvailabilityZone' --output text)

  if [ "$vol_az" != "$INSTANCE_AZ" ]; then
    echo "  ⚠️  Volume is in different AZ ($vol_az vs $INSTANCE_AZ) - need to inspect via snapshot"

    # Get latest snapshot for this volume instead
    latest_snap=$(aws ec2 describe-snapshots \
      --region $REGION \
      --filters "Name=volume-id,Values=$vol_id" "Name=status,Values=completed" \
      --query 'reverse(sort_by(Snapshots, &StartTime))[0].[SnapshotId,StartTime]' \
      --output text 2>/dev/null)

    if [ -n "$latest_snap" ] && [ "$latest_snap" != "None" ]; then
      snap_id=$(echo "$latest_snap" | awk '{print $1}')
      echo "  Using latest snapshot: $snap_id"

      # Create temp volume in instance AZ from snapshot
      temp_vol=$(aws ec2 create-volume \
        --region $REGION \
        --availability-zone $INSTANCE_AZ \
        --snapshot-id $snap_id \
        --volume-type gp3 \
        --size 100 \
        --tag-specifications "ResourceType=volume,Tags=[{Key=Name,Value=temp-inspect}]" \
        --query 'VolumeId' \
        --output text)

      echo "  Created temp volume in $INSTANCE_AZ: $temp_vol"
      aws ec2 wait volume-available --region $REGION --volume-ids $temp_vol

      inspect_volume $temp_vol "snapshot-based volume" "$vol_id (via $snap_id)"

      # Cleanup temp volume (async to avoid VolumeInUse errors)
      echo "  Scheduling temp volume cleanup..."
      (
        sleep 10  # Wait for any lingering attachments to clear
        aws ec2 delete-volume --region $REGION --volume-id $temp_vol 2>/dev/null || echo "  (temp volume cleanup will retry later)"
      ) &
    else
      echo "  ❌ No snapshots available - cannot inspect cross-AZ volume"
    fi
    echo ""
    continue
  fi

  inspect_volume $vol_id "volume" "$vol_id"
  echo ""
done

echo ""
echo "=== Snapshots for user $USER_EMAIL ==="
echo ""

# Get instance AZ
INSTANCE_ID=$(kubectl get node $NODE_NAME -o jsonpath='{.spec.providerID}' | cut -d'/' -f5)
INSTANCE_AZ=$(aws ec2 describe-instances --region $REGION --instance-ids $INSTANCE_ID --query 'Reservations[0].Instances[0].Placement.AvailabilityZone' --output text)

# Get all snapshots for this user
aws ec2 describe-snapshots \
  --region $REGION \
  --owner-ids self \
  --filters "Name=tag:gpu-dev-user,Values=$USER_EMAIL" "Name=status,Values=completed" \
  --query 'Snapshots[*].[SnapshotId,VolumeId,StartTime,VolumeSize]' \
  --output text | while IFS=$'\t' read snap_id vol_id start_time size; do

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Snapshot: $snap_id"
  echo "  From volume: $vol_id"
  echo "  Created: $start_time"
  echo "  Size: ${size}GB"
  echo ""

  # Create temp volume from snapshot in instance AZ
  echo "  Creating temp volume from snapshot..."
  temp_vol=$(aws ec2 create-volume \
    --region $REGION \
    --availability-zone $INSTANCE_AZ \
    --snapshot-id $snap_id \
    --volume-type gp3 \
    --size 100 \
    --tag-specifications "ResourceType=volume,Tags=[{Key=Name,Value=temp-inspect-snapshot}]" \
    --query 'VolumeId' \
    --output text)

  echo "  Created temp volume: $temp_vol"
  aws ec2 wait volume-available --region $REGION --volume-ids $temp_vol

  inspect_volume $temp_vol "snapshot" "$snap_id"

  # Cleanup temp volume (async to avoid VolumeInUse errors)
  echo "  Scheduling temp volume cleanup..."
  (
    sleep 10  # Wait for any lingering attachments to clear
    aws ec2 delete-volume --region $REGION --volume-id $temp_vol 2>/dev/null || echo "  (temp volume cleanup will retry later)"
  ) &
  echo ""
done

echo ""
echo "=== Done ==="
