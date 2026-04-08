#!/usr/bin/env bash
#
# Deletes orphaned (available/unattached) EBS volumes older than N days in a given region.
#
# Dry-run by default — pass --delete to actually delete.
#
# Usage:
#   ./cleanup-orphan-ebs.sh                          # dry-run, us-east-1, 90 days
#   ./cleanup-orphan-ebs.sh --region us-west-2       # different region
#   ./cleanup-orphan-ebs.sh --age-days 180            # only volumes older than 180 days
#   ./cleanup-orphan-ebs.sh --delete                  # actually delete
#   ./cleanup-orphan-ebs.sh --delete --batch-size 50  # delete in batches of 50

set -euo pipefail

REGION="us-east-1"
AGE_DAYS=90
DRY_RUN=true
BATCH_SIZE=25
BATCH_DELAY=2
LOG_FILE=""
VOLUMES_FILE=""

DELETED=0
FAILED=0
TOTAL=0

# --- Dependency checks ---

command -v python3 &>/dev/null || { echo "Error: python3 is required but not found in PATH"; exit 1; }
command -v aws &>/dev/null || { echo "Error: aws CLI is required but not found in PATH"; exit 1; }

# --- Argument parsing ---

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)
      [[ $# -ge 2 ]] || { echo "Error: --region requires a value"; exit 1; }
      REGION="$2"; shift 2 ;;
    --age-days)
      [[ $# -ge 2 ]] || { echo "Error: --age-days requires a value"; exit 1; }
      AGE_DAYS="$2"; shift 2 ;;
    --delete)      DRY_RUN=false; shift ;;
    --batch-size)
      [[ $# -ge 2 ]] || { echo "Error: --batch-size requires a value"; exit 1; }
      BATCH_SIZE="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [--region REGION] [--age-days N] [--batch-size N] [--delete]"
      echo ""
      echo "  --region      AWS region (default: us-east-1)"
      echo "  --age-days    Minimum age in days to consider orphaned (default: 90)"
      echo "  --batch-size  Number of volumes to delete per batch (default: 25)"
      echo "  --delete      Actually delete volumes (default: dry-run)"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# --- Input validation ---

if ! [[ "$AGE_DAYS" =~ ^[0-9]+$ ]] || [[ "$AGE_DAYS" -eq 0 ]]; then
  echo "Error: --age-days must be a positive integer, got: $AGE_DAYS"
  exit 1
fi

if ! [[ "$BATCH_SIZE" =~ ^[0-9]+$ ]] || [[ "$BATCH_SIZE" -eq 0 ]]; then
  echo "Error: --batch-size must be a positive integer, got: $BATCH_SIZE"
  exit 1
fi

# --- Setup temp files and trap ---

LOG_FILE=$(mktemp /tmp/cleanup-orphan-ebs-XXXXXX.log)
VOLUMES_FILE=$(mktemp /tmp/cleanup-orphan-ebs-volumes-XXXXXX.json)

cleanup_and_summary() {
  local exit_code=$?
  echo ""
  echo "=== Summary ==="
  echo "Deleted: $DELETED / $TOTAL"
  echo "Failed:  $FAILED"
  echo "Log file: $LOG_FILE"
  if [[ -f "$VOLUMES_FILE" ]]; then
    rm -f "$VOLUMES_FILE"
  fi
  exit "$exit_code"
}
trap cleanup_and_summary EXIT

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_FILE"; }

log "=== Orphaned EBS Volume Cleanup ==="
log "Region:     $REGION"
log "Age cutoff: $AGE_DAYS days"
log "Dry run:    $DRY_RUN"
log "Batch size: $BATCH_SIZE"
log "Log file:   $LOG_FILE"
echo ""

# --- Fetch all available volumes (write to temp file to avoid shell variable size limits) ---

log "Querying available (unattached) EBS volumes..."
if ! aws ec2 describe-volumes \
  --region "$REGION" \
  --filters "Name=status,Values=available" \
  --output json > "$VOLUMES_FILE" 2>"$LOG_FILE.aws-err"; then
  log "ERROR: AWS API call failed:"
  cat "$LOG_FILE.aws-err" | tee -a "$LOG_FILE"
  rm -f "$LOG_FILE.aws-err"
  exit 1
fi
rm -f "$LOG_FILE.aws-err"

# --- Filter by age and extract volume info using Python (proper datetime comparison) ---

SUMMARY=$(python3 - "$AGE_DAYS" "$VOLUMES_FILE" << 'PYEOF'
import json, sys
from datetime import datetime, timezone, timedelta

age_days = int(sys.argv[1])
volumes_file = sys.argv[2]

with open(volumes_file) as f:
    raw = json.load(f)

# Handle both CLI v1 and CLI v2 pagination output.
# CLI v2 returns {"Volumes": [...]}.
# CLI v1 may return different structures depending on pagination behavior.
# We avoid --query entirely and do all filtering here to sidestep the issue.
if isinstance(raw, list):
    volumes = []
    for item in raw:
        if isinstance(item, dict) and "Volumes" in item:
            volumes.extend(item["Volumes"])
        elif isinstance(item, dict):
            volumes.append(item)
        elif isinstance(item, list):
            volumes.extend(item)
elif isinstance(raw, dict) and "Volumes" in raw:
    volumes = raw["Volumes"]
else:
    print("ERROR: unexpected JSON structure", file=sys.stderr)
    sys.exit(1)

cutoff = datetime.now(timezone.utc) - timedelta(days=age_days)
filtered = []
for v in volumes:
    ct_str = v["CreateTime"]
    # AWS returns ISO-8601, e.g. "2024-01-15T10:30:00.000Z" or "2024-01-15T10:30:00+00:00"
    ct_str = ct_str.replace("Z", "+00:00")
    ct = datetime.fromisoformat(ct_str)
    if ct <= cutoff:
        name_tag = ""
        for t in v.get("Tags", []):
            if t.get("Key") == "Name":
                name_tag = t.get("Value", "")
                break
        filtered.append({
            "VolumeId": v["VolumeId"],
            "Size": v["Size"],
            "VolumeType": v["VolumeType"],
            "CreateTime": v["CreateTime"],
            "Name": name_tag,
            "Tags": v.get("Tags", []),
        })

total_gb = sum(v["Size"] for v in filtered)

# Write filtered volumes to a separate file for the delete loop
out_path = volumes_file + ".filtered"
with open(out_path, "w") as out:
    json.dump(filtered, out)

# Print summary to stdout for the shell to capture
print(f"{len(filtered)}\t{total_gb}\t{out_path}")
PYEOF
)

TOTAL=$(echo "$SUMMARY" | cut -f1)
TOTAL_GB=$(echo "$SUMMARY" | cut -f2)
FILTERED_FILE=$(echo "$SUMMARY" | cut -f3)

log "Found $TOTAL volumes older than $AGE_DAYS days"
log "Total size: ${TOTAL_GB} GiB"
echo ""

if [[ "$TOTAL" -eq 0 ]]; then
  log "Nothing to clean up."
  rm -f "$FILTERED_FILE"
  exit 0
fi

if $DRY_RUN; then
  log "[DRY RUN] Would delete $TOTAL volumes (${TOTAL_GB} GiB). Re-run with --delete to proceed."
  echo ""
  echo "First 20 volumes that would be deleted:"
  python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    vols = json.load(f)[:20]
for v in vols:
    name = v.get('Name', '')
    name_str = f'  name={name}' if name else ''
    print(f\"  {v['VolumeId']}  {v['Size']:>5} GiB  {v['VolumeType']}  created {v['CreateTime']}{name_str}\")
" "$FILTERED_FILE"
  echo ""
  log "Full list written to: $FILTERED_FILE"
  # Keep the filtered file for user inspection; clean up the raw volumes file
  rm -f "$VOLUMES_FILE"
  VOLUMES_FILE=""  # prevent trap from trying to remove it again
  exit 0
fi

# --- Confirmation ---

echo "========================================"
echo " DESTRUCTIVE OPERATION"
echo " About to delete $TOTAL EBS volumes"
echo " Total size: ${TOTAL_GB} GiB"
echo " Region: $REGION"
echo "========================================"
read -r -p "Type 'yes' to confirm: " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  log "Aborted by user."
  rm -f "$FILTERED_FILE"
  exit 1
fi

# --- Delete loop with retry ---

MAX_RETRIES=3
BATCH_NUM=0

delete_with_retry() {
  local vol_id="$1"
  local attempt=0
  local delay=1

  while [[ $attempt -lt $MAX_RETRIES ]]; do
    if aws ec2 delete-volume --region "$REGION" --volume-id "$vol_id" 2>>"$LOG_FILE"; then
      return 0
    fi

    attempt=$((attempt + 1))
    if [[ $attempt -lt $MAX_RETRIES ]]; then
      log "  Retry $attempt/$MAX_RETRIES for $vol_id (waiting ${delay}s)..."
      sleep "$delay"
      delay=$((delay * 2))
    fi
  done

  return 1
}

# Read volume IDs from the filtered JSON
VOLUME_IDS=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    for v in json.load(f):
        print(v['VolumeId'])
" "$FILTERED_FILE")

while IFS= read -r vol_id; do
  BATCH_NUM=$((BATCH_NUM + 1))

  if delete_with_retry "$vol_id"; then
    DELETED=$((DELETED + 1))
    log "Deleted $vol_id ($DELETED/$TOTAL)"
  else
    FAILED=$((FAILED + 1))
    log "FAILED to delete $vol_id (after $MAX_RETRIES attempts)"
  fi

  # Pause between batches to avoid API throttling
  if [[ $((BATCH_NUM % BATCH_SIZE)) -eq 0 ]]; then
    log "Batch pause (${BATCH_DELAY}s)..."
    sleep "$BATCH_DELAY"
  fi
done <<< "$VOLUME_IDS"

rm -f "$FILTERED_FILE"
# Summary is printed by the EXIT trap
