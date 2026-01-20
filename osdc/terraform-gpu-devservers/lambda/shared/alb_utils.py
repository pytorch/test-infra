"""
ALB/NLB utilities for managing load balancer routing for reservations
Handles target group creation, listener rules, and DNS integration
"""

import logging
import os
import time
from typing import Optional, Dict, Any

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

# Environment variables
JUPYTER_ALB_ARN = os.environ.get("JUPYTER_ALB_ARN", "")
JUPYTER_ALB_LISTENER_ARN = os.environ.get("JUPYTER_ALB_LISTENER_ARN", "")
SSH_NLB_ARN = os.environ.get("SSH_NLB_ARN", "")
SSH_NLB_LISTENER_ARN = os.environ.get("SSH_NLB_LISTENER_ARN", "")
ALB_TARGET_GROUPS_TABLE = os.environ.get("ALB_TARGET_GROUPS_TABLE", "")
ALB_VPC_ID = os.environ.get("ALB_VPC_ID", "")
DOMAIN_NAME = os.environ.get("DOMAIN_NAME", "")

# AWS clients
elbv2_client = boto3.client("elbv2")
dynamodb = boto3.resource("dynamodb")


def is_alb_enabled() -> bool:
    """Check if ALB infrastructure is configured (SSH uses HTTP CONNECT proxy)"""
    return bool(JUPYTER_ALB_ARN and ALB_TARGET_GROUPS_TABLE)


def create_jupyter_target_group(
    reservation_id: str, pod_name: str, instance_id: str, jupyter_port: int
) -> Optional[str]:
    """
    Create target group for Jupyter access to a specific pod

    Args:
        reservation_id: Reservation ID
        pod_name: Pod name
        instance_id: EC2 instance ID where pod is running
        jupyter_port: NodePort for Jupyter service

    Returns:
        Target group ARN if successful, None otherwise
    """
    if not is_alb_enabled():
        logger.info("ALB not configured, skipping target group creation")
        return None

    try:
        # Create target group name (max 32 chars)
        # Use first 8 chars of reservation ID
        tg_name = f"jupyter-{reservation_id[:8]}"

        logger.info(f"Creating Jupyter target group {tg_name} for reservation {reservation_id}")

        response = elbv2_client.create_target_group(
            Name=tg_name,
            Protocol="HTTP",
            Port=jupyter_port,
            VpcId=ALB_VPC_ID,
            HealthCheckEnabled=True,
            HealthCheckProtocol="HTTP",
            HealthCheckPath="/",  # Root path - Jupyter serves redirect or UI
            HealthCheckIntervalSeconds=30,
            HealthCheckTimeoutSeconds=5,
            HealthyThresholdCount=2,
            UnhealthyThresholdCount=2,
            Matcher={"HttpCode": "200,301,302"},  # Accept redirects
            TargetType="instance",
            Tags=[
                {"Key": "Name", "Value": tg_name},
                {"Key": "ReservationId", "Value": reservation_id},
                {"Key": "PodName", "Value": pod_name},
                {"Key": "ManagedBy", "Value": "gpu-dev-lambda"},
            ],
        )

        target_group_arn = response["TargetGroups"][0]["TargetGroupArn"]
        logger.info(f"Created target group {target_group_arn}")

        # Register instance with target group
        elbv2_client.register_targets(
            TargetGroupArn=target_group_arn,
            Targets=[{"Id": instance_id, "Port": jupyter_port}],
        )

        logger.info(f"Registered instance {instance_id}:{jupyter_port} with target group")

        return target_group_arn

    except ClientError as e:
        error_code = e.response["Error"]["Code"]
        if error_code == "DuplicateTargetGroupName":
            logger.warning(f"Target group {tg_name} already exists")
            # Try to describe and return existing
            try:
                response = elbv2_client.describe_target_groups(Names=[tg_name])
                return response["TargetGroups"][0]["TargetGroupArn"]
            except Exception as describe_error:
                logger.error(f"Failed to describe existing target group: {describe_error}")
                return None
        else:
            logger.error(f"Failed to create Jupyter target group: {e}")
            return None
    except Exception as e:
        logger.error(f"Unexpected error creating Jupyter target group: {e}")
        return None


# SSH target groups removed - using HTTP CONNECT proxy instead
# SSH access is now tunneled through https://ssh.devservers.io via ProxyCommand


def create_alb_listener_rule(
    subdomain: str, target_group_arn: str, priority: int = None
) -> Optional[str]:
    """
    Create ALB listener rule for hostname-based routing

    Args:
        subdomain: Subdomain for routing (e.g., 'grumpy_bear')
        target_group_arn: Target group ARN to forward to
        priority: Rule priority (auto-generated if None)

    Returns:
        Rule ARN if successful, None otherwise
    """
    if not is_alb_enabled():
        logger.info("ALB not configured, skipping listener rule creation")
        return None

    try:
        full_domain = f"{subdomain}.{DOMAIN_NAME}"

        # Auto-generate priority based on timestamp if not provided
        if priority is None:
            priority = int(time.time()) % 50000  # Keep within ALB limits

        logger.info(f"Creating ALB rule for {full_domain} with priority {priority}")

        response = elbv2_client.create_rule(
            ListenerArn=JUPYTER_ALB_LISTENER_ARN,
            Conditions=[
                {
                    "Field": "host-header",
                    "HostHeaderConfig": {"Values": [full_domain]},
                }
            ],
            Actions=[
                {
                    "Type": "forward",
                    "TargetGroupArn": target_group_arn,
                }
            ],
            Priority=priority,
            Tags=[
                {"Key": "Name", "Value": f"jupyter-{subdomain}"},
                {"Key": "Subdomain", "Value": subdomain},
                {"Key": "ManagedBy", "Value": "gpu-dev-lambda"},
            ],
        )

        rule_arn = response["Rules"][0]["RuleArn"]
        logger.info(f"Created ALB rule {rule_arn} for {full_domain}")

        return rule_arn

    except ClientError as e:
        error_code = e.response["Error"]["Code"]
        if error_code == "PriorityInUse":
            logger.warning(f"Priority {priority} already in use, retrying with different priority")
            # Retry with different priority
            return create_alb_listener_rule(subdomain, target_group_arn, priority + 1)
        else:
            logger.error(f"Failed to create ALB listener rule: {e}")
            return None
    except Exception as e:
        logger.error(f"Unexpected error creating ALB listener rule: {e}")
        return None


# NLB listener rules removed - using HTTP CONNECT proxy instead


def store_alb_mapping(
    reservation_id: str,
    domain_name: str,
    jupyter_target_group_arn: str,
    jupyter_rule_arn: str,
    expires_at: int,
) -> bool:
    """
    Store ALB mapping in DynamoDB for cleanup (Jupyter only, SSH uses proxy)

    Args:
        reservation_id: Reservation ID
        domain_name: Subdomain name
        jupyter_target_group_arn: Jupyter target group ARN
        jupyter_rule_arn: Jupyter listener rule ARN
        expires_at: Unix timestamp when mapping expires

    Returns:
        True if successful, False otherwise
    """
    if not ALB_TARGET_GROUPS_TABLE:
        logger.info("ALB target groups table not configured")
        return True

    try:
        table = dynamodb.Table(ALB_TARGET_GROUPS_TABLE)

        table.put_item(
            Item={
                "reservation_id": reservation_id,
                "domain_name": domain_name,
                "jupyter_target_group_arn": jupyter_target_group_arn,
                "jupyter_rule_arn": jupyter_rule_arn,
                "expires_at": expires_at,
                "created_at": int(time.time()),
            }
        )

        logger.info(f"Stored ALB mapping for reservation {reservation_id}")
        return True

    except Exception as e:
        logger.error(f"Failed to store ALB mapping: {e}")
        return False


def delete_alb_mapping(reservation_id: str) -> bool:
    """
    Delete ALB/NLB resources for a reservation

    Args:
        reservation_id: Reservation ID

    Returns:
        True if successful, False otherwise
    """
    if not ALB_TARGET_GROUPS_TABLE:
        logger.info("ALB target groups table not configured")
        return True

    try:
        table = dynamodb.Table(ALB_TARGET_GROUPS_TABLE)

        # Get mapping
        response = table.get_item(Key={"reservation_id": reservation_id})
        if "Item" not in response:
            logger.warning(f"No ALB mapping found for reservation {reservation_id}")
            return True

        mapping = response["Item"]

        # Delete ALB listener rule
        if mapping.get("jupyter_rule_arn"):
            try:
                elbv2_client.delete_rule(RuleArn=mapping["jupyter_rule_arn"])
                logger.info(f"Deleted Jupyter ALB rule {mapping['jupyter_rule_arn']}")
            except Exception as e:
                logger.error(f"Failed to delete Jupyter ALB rule: {e}")

        # Wait a bit for rule to be deleted
        time.sleep(2)

        # Delete Jupyter target group
        if mapping.get("jupyter_target_group_arn"):
            try:
                elbv2_client.delete_target_group(
                    TargetGroupArn=mapping["jupyter_target_group_arn"]
                )
                logger.info(f"Deleted Jupyter target group {mapping['jupyter_target_group_arn']}")
            except Exception as e:
                logger.error(f"Failed to delete Jupyter target group: {e}")

        # Delete DynamoDB record
        table.delete_item(Key={"reservation_id": reservation_id})
        logger.info(f"Deleted ALB mapping for reservation {reservation_id}")

        return True

    except Exception as e:
        logger.error(f"Failed to delete ALB mapping: {e}")
        return False


def get_instance_id_from_pod(k8s_client, pod_name: str, namespace: str = "gpu-dev") -> Optional[str]:
    """
    Get EC2 instance ID from pod's node

    Args:
        k8s_client: Kubernetes client
        pod_name: Pod name
        namespace: Kubernetes namespace

    Returns:
        EC2 instance ID if found, None otherwise
    """
    try:
        from kubernetes import client

        v1 = client.CoreV1Api(k8s_client)
        pod = v1.read_namespaced_pod(name=pod_name, namespace=namespace)
        node_name = pod.spec.node_name

        if not node_name:
            logger.error(f"Pod {pod_name} has no node assigned")
            return None

        # Get node to find instance ID
        node = v1.read_node(name=node_name)

        # Instance ID is in provider ID: aws:///us-east-2a/i-1234567890abcdef0
        provider_id = node.spec.provider_id
        if provider_id and provider_id.startswith("aws:///"):
            instance_id = provider_id.split("/")[-1]
            logger.info(f"Found instance ID {instance_id} for pod {pod_name}")
            return instance_id

        logger.error(f"Could not parse instance ID from provider_id: {provider_id}")
        return None

    except Exception as e:
        logger.error(f"Failed to get instance ID for pod {pod_name}: {e}")
        return None
