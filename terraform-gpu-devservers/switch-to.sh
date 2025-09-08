#!/bin/bash

set -e

if [ $# -ne 1 ]; then
    echo "Usage: $0 <prod|test>"
    echo ""
    echo "Switches between prod and test environments by:"
    echo "  - Updating kubeconfig for the correct EKS cluster"
    echo "  - Switching kubens to gpu-dev namespace"
    echo "  - Selecting the correct Terraform workspace"
    echo "  - Setting AWS region via aws-cli config"
    exit 1
fi

ENVIRONMENT=$1

case $ENVIRONMENT in
    "prod")
        REGION="us-east-2"
        WORKSPACE="prod"
        ;;
    "test")
        REGION="us-west-1"
        WORKSPACE="default"
        ;;
    *)
        echo "Error: Environment must be 'prod' or 'test'"
        exit 1
        ;;
esac

echo "🔄 Switching to $ENVIRONMENT environment..."
echo ""

# Set AWS region via gpu-dev config
echo "📍 Setting AWS region to $REGION..."
if command -v gpu-dev >/dev/null 2>&1; then
    gpu-dev config environment $ENVIRONMENT
else
    echo "⚠️  gpu-dev command not found, setting AWS_DEFAULT_REGION manually"
    export AWS_DEFAULT_REGION=$REGION
    echo "   Set AWS_DEFAULT_REGION=$REGION (session only)"
fi

# Update kubeconfig for EKS cluster
echo "☸️  Updating kubeconfig for EKS cluster in $REGION..."
aws eks update-kubeconfig --region $REGION --name pytorch-gpu-dev-cluster

# Switch to gpu-dev namespace
echo "📦 Switching to gpu-dev namespace..."
if command -v kubens >/dev/null 2>&1; then
    kubens gpu-dev
else
    echo "⚠️  kubens not found, using kubectl"
    kubectl config set-context --current --namespace=gpu-dev
fi

# Select Terraform workspace
echo "🏗️  Selecting Terraform workspace: $WORKSPACE..."
tofu workspace select $WORKSPACE

echo ""
echo "✅ Successfully switched to $ENVIRONMENT environment!"
echo "   Region: $REGION"
echo "   Workspace: $WORKSPACE"
echo "   Namespace: gpu-dev"