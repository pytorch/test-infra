#!/usr/bin/env bash
# p5-capacity-map.sh
# Discover AZs that OFFER an instance type across multiple Regions,
# and optionally PROBE live capacity via a 1x ODCR (create+cancel).
#
# Usage:
#   ./p5-capacity-map.sh                                  # default regions, dry-run
#   ./p5-capacity-map.sh --run                            # probe live capacity (billed per-second; 60s min)
#   ./p5-capacity-map.sh --regions "us-east-1,us-west-2"  # custom regions
#   ./p5-capacity-map.sh --region us-west-2 --region us-east-2 --run
#   ./p5-capacity-map.sh --type p5.48xlarge --count 1 --verbose --run
#
# Requires: aws CLI v2, jq
set -uo pipefail

# Defaults
DEFAULT_REGIONS=("us-east-1" "us-east-2" "us-west-1" "us-west-2")
INSTANCE_TYPE="p5.48xlarge"
COUNT=1
RUN=0
VERBOSE=0
declare -a REGIONS=("${DEFAULT_REGIONS[@]}")

usage() {
  cat <<EOF
Usage: $0 [--regions "r1,r2,..."] [--region R]... [--type INSTANCE_TYPE] [--count N] [--run] [--verbose]
Defaults: regions=${DEFAULT_REGIONS[*]}  type=${INSTANCE_TYPE}  count=${COUNT}  mode=LIST
Dry-run by default (no reservations created). Use --run to actually probe capacity.
EOF
}

log() { [[ $VERBOSE -eq 1 ]] && echo "[$(date -Is)] $*" >&2 || true; }

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --regions)
      IFS=',' read -r -a REGIONS <<< "${2:?}"; shift 2 ;;
    --region)
      REGIONS+=("${2:?}"); shift 2 ;;
    --type)
      INSTANCE_TYPE="${2:?}"; shift 2 ;;
    --count)
      COUNT="${2:?}"; shift 2 ;;
    --run|--execute)
      RUN=1; shift ;;
    --verbose)
      VERBOSE=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown arg: $1"; usage; exit 1 ;;
  esac
done

command -v aws >/dev/null || { echo "aws CLI not found"; exit 2; }
command -v jq  >/dev/null || { echo "jq is required"; exit 2; }

az_name() {
  local region="$1" azid="$2"
  aws ec2 describe-availability-zones \
    --region "$region" \
    --filters "Name=zone-id,Values=${azid}" \
    --query 'AvailabilityZones[0].ZoneName' \
    --output text 2>/dev/null
}

probe_az() {
  local region="$1" azid="$2" errfile create_out crid state
  errfile="$(mktemp)"
  if create_out=$(aws ec2 create-capacity-reservation \
        --region "$region" \
        --availability-zone-id "$azid" \
        --instance-type "$INSTANCE_TYPE" \
        --instance-platform Linux/UNIX \
        --tenancy default \
        --instance-count "$COUNT" \
        --output json 2>"$errfile"); then
    crid=$(jq -r '.CapacityReservation.CapacityReservationId' <<<"$create_out")
    state=$(jq -r '.CapacityReservation.State' <<<"$create_out")
    aws ec2 cancel-capacity-reservation \
      --region "$region" \
      --capacity-reservation-id "$crid" >/dev/null 2>&1 || true
    if [[ "$state" == "active" ]]; then
      echo "IN_STOCK|Created+cancelled CR ${crid}"
    else
      echo "UNKNOWN|CR state=${state}; cancelled ${crid}"
    fi
  else
    local msg; msg="$(<"$errfile")"; rm -f "$errfile"
    if [[ "$msg" == *"InsufficientInstanceCapacity"* ]]; then
      echo "NO_CAPACITY|InsufficientInstanceCapacity"
    elif [[ "$msg" == *"InstanceLimitExceeded"* ]]; then
      echo "QUOTA_BLOCKED|InstanceLimitExceeded (Service Quotas)"
    elif [[ "$msg" == *"UnauthorizedOperation"* ]]; then
      echo "PERMISSION_DENIED|UnauthorizedOperation"
    elif [[ "$msg" == *"OptInRequired"* ]]; then
      echo "REGION_NOT_ENABLED|OptInRequired"
    else
      echo "ERROR|${msg}"
    fi
  fi
}

printf "Instance: %s | Count: %s | Mode: %s\n" "$INSTANCE_TYPE" "$COUNT" "$( ((RUN)) && echo PROBE || echo LIST )"
printf "%-12s  %-11s  %-12s  %-12s  %-20s  %-s\n" "REGION" "AZ_ID" "AZ_NAME" "OFFERED?" "STATUS" "DETAILS"
printf "%-12s  %-11s  %-12s  %-12s  %-20s  %-s\n" "------------" "-----------" "------------" "------------" "--------------------" "------------------------------"

# Deduplicate regions if both --regions and --region used
declare -A seen
for r in "${REGIONS[@]}"; do
  [[ -n "${seen[$r]:-}" ]] && continue
  seen[$r]=1

  log "Querying AZ IDs in ${r} that OFFER ${INSTANCE_TYPE}..."
  mapfile -t AZ_IDS < <(
    aws ec2 describe-instance-type-offerings \
      --region "$r" \
      --location-type availability-zone-id \
      --filters Name=instance-type,Values="$INSTANCE_TYPE" \
      --query 'InstanceTypeOfferings[].Location' \
      --output text 2>/dev/null | tr '\t' '\n' | sort -u
  )

  if [[ ${#AZ_IDS[@]} -eq 0 ]]; then
    printf "%-12s  %-11s  %-12s  %-12s  %-20s  %-s\n" "$r" "-" "-" "NO" "N/A" "No AZs offer ${INSTANCE_TYPE} (or insufficient permissions)"
    continue
  fi

  for AZID in "${AZ_IDS[@]}"; do
    AZNAME="$(az_name "$r" "$AZID")"
    if [[ $RUN -eq 0 ]]; then
      printf "%-12s  %-11s  %-12s  %-12s  %-20s  %-s\n" "$r" "$AZID" "$AZNAME" "YES" "OFFERED" "Dry-run (no probe)"
    else
      IFS='|' read -r status detail < <(probe_az "$r" "$AZID")
      printf "%-12s  %-11s  %-12s  %-12s  %-20s  %-s\n" "$r" "$AZID" "$AZNAME" "YES" "$status" "$detail"
    fi
  done
done

echo
echo "Notes:"
echo " - OFFERED=YES: AZ advertises the instance type (catalog), not live capacity."
echo " - PROBE mode: creates+immediately cancels a 1x ODCR per AZ; billed per second at On-Demand price (60s min). Keep probes brief."

