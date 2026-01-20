#!/bin/bash
set -e

# Backfill snapshot contents by spinning up a temporary EC2 instance
# This script handles the full lifecycle: create instance, run backfill, cleanup

REGION="us-east-2"
INSTANCE_TYPE="t3.small"
KEY_NAME="temp-backfill-key-$(date +%s)"
KEY_FILE="/tmp/${KEY_NAME}.pem"
SECURITY_GROUP_NAME="temp-backfill-sg-$(date +%s)"

echo "🚀 Starting snapshot content backfill for region: $REGION"
echo ""

# Cleanup function
cleanup() {
    echo ""
    echo "🧹 Cleaning up resources..."

    if [ ! -z "$INSTANCE_ID" ]; then
        echo "  • Terminating instance $INSTANCE_ID..."
        aws ec2 terminate-instances --region $REGION --instance-ids $INSTANCE_ID >/dev/null 2>&1 || true
    fi

    if [ ! -z "$SECURITY_GROUP_ID" ]; then
        echo "  • Waiting for instance to terminate before deleting security group..."
        sleep 10
        echo "  • Deleting security group $SECURITY_GROUP_ID..."
        aws ec2 delete-security-group --region $REGION --group-id $SECURITY_GROUP_ID >/dev/null 2>&1 || true
    fi

    if [ -f "$KEY_FILE" ]; then
        echo "  • Removing key file..."
        rm -f "$KEY_FILE"
    fi

    if [ ! -z "$KEY_NAME" ]; then
        echo "  • Deleting key pair..."
        aws ec2 delete-key-pair --region $REGION --key-name $KEY_NAME >/dev/null 2>&1 || true
    fi

    echo "✓ Cleanup complete"
}

# Set trap to cleanup on exit
trap cleanup EXIT

# Step 1: Get default VPC
echo "📡 Getting default VPC..."
VPC_ID=$(aws ec2 describe-vpcs --region $REGION --filters "Name=is-default,Values=true" --query 'Vpcs[0].VpcId' --output text)
if [ "$VPC_ID" = "None" ] || [ -z "$VPC_ID" ]; then
    echo "❌ No default VPC found in $REGION"
    exit 1
fi
echo "✓ Using VPC: $VPC_ID"

# Step 2: Create security group
echo ""
echo "🔒 Creating security group..."
SECURITY_GROUP_ID=$(aws ec2 create-security-group \
    --region $REGION \
    --group-name $SECURITY_GROUP_NAME \
    --description "Temporary security group for snapshot backfill" \
    --vpc-id $VPC_ID \
    --query 'GroupId' \
    --output text)
echo "✓ Created security group: $SECURITY_GROUP_ID"

# Add SSH ingress rule (from current IP)
MY_IP=$(curl -s https://checkip.amazonaws.com)
echo "  • Adding SSH rule for IP: $MY_IP"
aws ec2 authorize-security-group-ingress \
    --region $REGION \
    --group-id $SECURITY_GROUP_ID \
    --protocol tcp \
    --port 22 \
    --cidr ${MY_IP}/32 >/dev/null

# Step 3: Create SSH key pair
echo ""
echo "🔑 Creating SSH key pair..."
aws ec2 create-key-pair \
    --region $REGION \
    --key-name $KEY_NAME \
    --query 'KeyMaterial' \
    --output text > $KEY_FILE
chmod 400 $KEY_FILE
echo "✓ Created key pair: $KEY_NAME"

# Step 4: Get latest Amazon Linux 2023 AMI
echo ""
echo "🖼️  Finding latest Amazon Linux 2023 AMI..."
AMI_ID=$(aws ec2 describe-images \
    --region $REGION \
    --owners amazon \
    --filters "Name=name,Values=al2023-ami-2023.*-x86_64" "Name=state,Values=available" \
    --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
    --output text)
echo "✓ Using AMI: $AMI_ID"

# Step 5: Launch instance
echo ""
echo "🚀 Launching EC2 instance..."
INSTANCE_ID=$(aws ec2 run-instances \
    --region $REGION \
    --image-id $AMI_ID \
    --instance-type $INSTANCE_TYPE \
    --key-name $KEY_NAME \
    --security-group-ids $SECURITY_GROUP_ID \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=temp-snapshot-backfill},{Key=Purpose,Value=snapshot-content-backfill}]' \
    --query 'Instances[0].InstanceId' \
    --output text)
echo "✓ Launched instance: $INSTANCE_ID"

# Step 6: Wait for instance to be running
echo ""
echo "⏳ Waiting for instance to be running..."
aws ec2 wait instance-running --region $REGION --instance-ids $INSTANCE_ID
echo "✓ Instance is running"

# Get instance IP
INSTANCE_IP=$(aws ec2 describe-instances \
    --region $REGION \
    --instance-ids $INSTANCE_ID \
    --query 'Reservations[0].Instances[0].PublicIpAddress' \
    --output text)
echo "✓ Instance IP: $INSTANCE_IP"

# Step 7: Wait for SSH to be ready
echo ""
echo "⏳ Waiting for SSH to be ready..."
MAX_ATTEMPTS=30
ATTEMPT=0
while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if ssh -i $KEY_FILE -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 ec2-user@$INSTANCE_IP "echo 'SSH ready'" >/dev/null 2>&1; then
        echo "✓ SSH is ready"
        break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    echo "  Attempt $ATTEMPT/$MAX_ATTEMPTS..."
    sleep 10
done

if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
    echo "❌ SSH did not become ready in time"
    exit 1
fi

# Step 8: Get bucket name from terraform/tofu
echo ""
echo "🪣 Getting S3 bucket name from terraform..."
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TF_DIR="$SCRIPT_DIR/.."

# Try tf first (aliased to tofu), fall back to tofu, then terraform
set +e
BUCKET_NAME=$(cd "$TF_DIR" && tf output -raw disk_contents_bucket_name 2>/dev/null)
if [ -z "$BUCKET_NAME" ]; then
    BUCKET_NAME=$(cd "$TF_DIR" && tofu output -raw disk_contents_bucket_name 2>/dev/null)
fi
if [ -z "$BUCKET_NAME" ]; then
    BUCKET_NAME=$(cd "$TF_DIR" && terraform output -raw disk_contents_bucket_name 2>/dev/null)
fi
set -e

if [ -z "$BUCKET_NAME" ]; then
    echo "❌ Could not get bucket name from terraform/tofu output"
    exit 1
fi
echo "✓ Bucket: $BUCKET_NAME"

# Step 9: Run backfill script
echo ""
echo "📦 Running backfill script..."
python3 $SCRIPT_DIR/backfill_snapshot_contents.py \
    --instance-id $INSTANCE_ID \
    --ssh-key $KEY_FILE \
    --region $REGION \
    --bucket $BUCKET_NAME

echo ""
echo "✅ Backfill complete!"
