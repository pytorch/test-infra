#!/bin/bash

### This script expects a file named instances.txt with one AWS instance id per line.
### It will go through those instances, and kill them if they are running
### To be used in case of runner issues or security concerns to quickly kill a subset of runners.
### Note this will stop and fail tests that are currently running.

# Set your AWS region
REGION="us-east-1"

# Initialize counters
NON_EXISTENT_COUNT=0
RUNNING_COUNT=0
NOT_RUNNING_COUNT=0

# Initialize arrays to keep track of results
TERMINATED_INSTANCES=()
EXISTED_BUT_NOT_RUNNING=()
NON_EXISTENT_INSTANCES=()

# Read instance IDs from file into an array
mapfile -t INSTANCE_IDS < instances.txt
TOTAL_INSTANCES=${#INSTANCE_IDS[@]}

# Process each instance
for ((i=0; i<TOTAL_INSTANCES; i++)); do
  INSTANCE_ID="${INSTANCE_IDS[i]}"
  echo -ne "\rWorking on instance: $INSTANCE_ID ($((i+1))/$TOTAL_INSTANCES) | Non-existent: $NON_EXISTENT_COUNT | Running: $RUNNING_COUNT | Not running: $NOT_RUNNING_COUNT"
  
  # Check if instance exists
  if aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --region "$REGION" &> /dev/null; then
    # Check if instance is running
    STATUS=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --region "$REGION" --query 'Reservations[0].Instances[0].State.Name' --output text)
    if [ "$STATUS" = "running" ]; then
      # Terminate instance
      aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION" &> /dev/null
      TERMINATED_INSTANCES+=("$INSTANCE_ID")
      RUNNING_COUNT=$((RUNNING_COUNT + 1))
    else
      EXISTED_BUT_NOT_RUNNING+=("$INSTANCE_ID")
      NOT_RUNNING_COUNT=$((NOT_RUNNING_COUNT + 1))
    fi
  else
    NON_EXISTENT_INSTANCES+=("$INSTANCE_ID")
    NON_EXISTENT_COUNT=$((NON_EXISTENT_COUNT + 1))
  fi
done

echo -e "\n\nTerminated instances:"
printf '%s\n' "${TERMINATED_INSTANCES[@]}"
echo ""
echo "Existed but not running:"
printf '%s\n' "${EXISTED_BUT_NOT_RUNNING[@]}"
echo ""
echo "Non-existent instances:"
printf '%s\n' "${NON_EXISTENT_INSTANCES[@]}"
