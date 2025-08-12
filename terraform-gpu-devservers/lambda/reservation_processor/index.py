"""
GPU Reservation Processor Lambda
Handles reservation requests and manages K8s pod allocation
"""

import json
import logging
import os
import subprocess
import tempfile
import time
import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

import boto3

from shared import K8sGPUTracker, setup_kubernetes_client

# Setup logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# AWS clients
dynamodb = boto3.resource("dynamodb")
eks_client = boto3.client("eks")
ec2_client = boto3.client("ec2")
sqs_client = boto3.client("sqs")

# Environment variables
RESERVATIONS_TABLE = os.environ["RESERVATIONS_TABLE"]
EKS_CLUSTER_NAME = os.environ["EKS_CLUSTER_NAME"]
REGION = os.environ["REGION"]
MAX_RESERVATION_HOURS = int(os.environ["MAX_RESERVATION_HOURS"])
DEFAULT_TIMEOUT_HOURS = int(os.environ["DEFAULT_TIMEOUT_HOURS"])
QUEUE_URL = os.environ["QUEUE_URL"]


def handler(event, context):
    """Main Lambda handler"""
    try:
        logger.info(f"Processing event: {json.dumps(event)}")

        # Check if this is a scheduled event for queue processing
        if event.get("source") == "cloudwatch.schedule":
            logger.info("Processing scheduled queue management and ETA updates")
            return process_scheduled_queue_management()

        # Process SQS messages
        for record in event.get("Records", []):
            if record.get("eventSource") == "aws:sqs":
                # Determine message type and process accordingly
                try:
                    message_body = json.loads(record["body"])
                    message_type = message_body.get("type", "reservation")
                    
                    if message_type == "cancellation":
                        success = process_cancellation_request(record)
                    else:
                        success = process_reservation_request(record)

                    # Delete message from queue if processed successfully
                    if success:
                        delete_sqs_message(record)
                        
                except Exception as parse_error:
                    logger.error(f"Error parsing SQS message: {parse_error}")
                    # Don't delete malformed messages - let them go to DLQ
                    continue

        return {
            "statusCode": 200,
            "body": json.dumps({"message": "Processing completed"}),
        }

    except Exception as e:
        logger.error(f"Error processing event: {str(e)}")
        raise


def process_reservation_request(record: dict[str, Any]) -> bool:
    """Process individual reservation request"""
    try:
        # Parse the reservation request
        reservation_request = json.loads(record["body"])

        logger.info(f"Processing reservation: {reservation_request}")

        # Validate request
        if not validate_reservation_request(reservation_request):
            logger.error(f"Invalid reservation request: {reservation_request}")
            # Let invalid messages go to DLQ by raising an exception
            raise ValueError(f"Invalid reservation request: {reservation_request}")

        # Check availability
        available_gpus = check_gpu_availability()
        requested_gpus = reservation_request.get("gpu_count", 1)

        if available_gpus >= requested_gpus:
            # Update status to show we're preparing the machine
            reservation_id = reservation_request.get("reservation_id")
            if reservation_id:
                update_reservation_status(
                    reservation_id, "preparing", "Preparing GPU resources"
                )

            # Create reservation
            reservation_id = create_reservation(reservation_request)
            logger.info(f"Created reservation: {reservation_id}")

            # Allocate resources (K8s pod creation would go here)
            allocate_gpu_resources(reservation_id, reservation_request)
            return True  # Successfully processed
        else:
            # Insufficient resources - set to queued and let scheduled Lambda handle it
            reservation_id = reservation_request.get("reservation_id")

            if reservation_id:
                # Calculate queue position and estimated wait time
                queue_info = calculate_queue_position_and_wait_time(
                    reservation_id, requested_gpus, available_gpus
                )

                # Update reservation with queue information and set to queued status
                update_reservation_with_queue_info(
                    reservation_id,
                    queue_info["position"],
                    queue_info["estimated_wait_minutes"],
                    available_gpus,
                )
                
                update_reservation_status(
                    reservation_id,
                    "queued",
                    f"In queue (#{queue_info.get('position', '?')})",
                )
                
                logger.info(
                    f"Insufficient resources. Set reservation {reservation_id[:8]} to queued (#{queue_info.get('position', '?')}). Scheduled Lambda will retry."
                )
            else:
                logger.warning("Insufficient resources but no reservation_id found")

            return True  # Delete message - scheduled Lambda will handle queued reservations

    except Exception as e:
        logger.error(f"Error processing reservation request: {str(e)}")

        # Try to update reservation status to failed before raising exception
        try:
            # Try to get reservation_id from the parsed request or record
            reservation_id = None
            try:
                reservation_request = json.loads(record["body"])
                reservation_id = reservation_request.get("reservation_id")
            except Exception:
                pass

            if reservation_id:
                update_reservation_status(
                    reservation_id, "failed", f"Processing error: {str(e)}"
                )
        except Exception as status_error:
            logger.error(f"Failed to update reservation status: {str(status_error)}")

        # Let processing errors (like JSON parsing) go to DLQ
        raise


def validate_reservation_request(request: dict[str, Any]) -> bool:
    """Validate reservation request parameters"""
    required_fields = ["user_id", "gpu_count"]

    for field in required_fields:
        if field not in request:
            logger.error(f"Missing required field: {field}")
            return False

    # Validate GPU count
    gpu_count = request.get("gpu_count", 1)
    if gpu_count not in [1, 2, 4, 8, 16]:  # 16 for 2x8 GPU setup
        logger.error(f"Invalid GPU count: {gpu_count}")
        return False

    # Validate duration
    duration_hours = request.get("duration_hours", DEFAULT_TIMEOUT_HOURS)
    if duration_hours > MAX_RESERVATION_HOURS:
        logger.error(
            f"Duration exceeds maximum: {duration_hours} > {MAX_RESERVATION_HOURS}"
        )
        return False

    return True


def check_gpu_availability() -> int:
    """Check available GPU capacity using K8s API"""
    try:
        # Set up K8s client and tracker
        k8s_client = setup_kubernetes_client()
        gpu_tracker = K8sGPUTracker(k8s_client)

        # Get real-time GPU capacity info
        capacity_info = gpu_tracker.get_gpu_capacity_info()

        logger.info(
            f"K8s GPU status: {capacity_info['available_gpus']}/{capacity_info['total_gpus']} GPUs available"
        )
        return capacity_info["available_gpus"]

    except Exception as e:
        logger.error(f"Error checking GPU availability from K8s: {str(e)}")
        raise RuntimeError(
            f"Failed to check GPU availability via K8s API: {str(e)}"
        ) from e


def create_reservation(request: dict[str, Any]) -> str:
    """Create a new reservation record"""
    try:
        # Use the reservation_id from the CLI request if provided, otherwise generate new one
        reservation_id = request.get("reservation_id", str(uuid.uuid4()))
        now = datetime.utcnow()
        duration_hours = request.get("duration_hours", DEFAULT_TIMEOUT_HOURS)
        expires_at = now + timedelta(hours=duration_hours)

        # Convert duration_hours to Decimal for DynamoDB compatibility
        duration_decimal = Decimal(str(duration_hours))

        reservation = {
            "reservation_id": reservation_id,
            "user_id": request["user_id"],
            "gpu_count": request["gpu_count"],
            "status": "preparing",
            "created_at": request.get("created_at", now.isoformat()),
            "expires_at": expires_at.isoformat(),
            "duration_hours": duration_decimal,
            "pod_name": f"gpu-dev-{reservation_id[:8]}",
            "namespace": "gpu-dev",
            "ssh_command": f"ssh user@gpu-dev-{reservation_id[:8]}.cluster.local",  # Placeholder
        }

        # Add optional fields
        if "name" in request:
            reservation["name"] = request["name"]
        if "instance_preference" in request:
            reservation["instance_preference"] = request["instance_preference"]

        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        reservations_table.put_item(Item=reservation)

        logger.info(f"Created reservation record: {reservation_id}")
        return reservation_id

    except Exception as e:
        logger.error(f"Error creating reservation: {str(e)}")
        raise


def allocate_gpu_resources(reservation_id: str, request: dict[str, Any]) -> None:
    """Allocate GPU resources via K8s pod creation"""
    try:
        gpu_count = request["gpu_count"]
        user_id = request["user_id"]
        pod_name = f"gpu-dev-{reservation_id[:8]}"

        logger.info(f"Allocating {gpu_count} GPUs for reservation {reservation_id}")
        logger.info(f"Pod name: {pod_name}")

        # Get user's GitHub public key
        github_user = request.get(
            "github_user", user_id
        )  # Fallback to user_id for compatibility
        github_public_key = get_github_public_key(github_user)
        if not github_public_key:
            raise ValueError(
                f"Could not fetch GitHub public key for GitHub user '{github_user}'"
            )

        # Set up K8s client for resource management
        k8s_client = setup_kubernetes_client()

        # Create Kubernetes pod and service
        node_port = create_kubernetes_resources(
            pod_name=pod_name,
            gpu_count=gpu_count,
            github_public_key=github_public_key,
            reservation_id=reservation_id,
        )

        # Get node public IP
        node_public_ip = get_node_public_ip()

        # Generate SSH command
        ssh_command = f"ssh -p {node_port} dev@{node_public_ip}"

        # Wait for SSH service to be fully ready (additional wait beyond pod ready)
        logger.info(f"Pod is ready, waiting for SSH service to start on {node_public_ip}:{node_port}")
        ssh_ready = wait_for_ssh_service(k8s_client, pod_name, node_public_ip, node_port, timeout_seconds=180)
        
        if ssh_ready:
            # Update reservation with connection details and mark as active
            update_reservation_connection_info(
                reservation_id=reservation_id,
                ssh_command=ssh_command,
                pod_name=pod_name,
                node_port=node_port,
                node_ip=node_public_ip,
            )
        else:
            # Check pod status to determine if it's failed or still starting
            pod_status = get_detailed_pod_status(k8s_client, pod_name)
            if pod_status['phase'] == 'Failed' or pod_status['has_errors']:
                update_reservation_status(
                    reservation_id, "failed", f"Pod failed to start properly: {pod_status['reason']}"
                )
                raise RuntimeError(f"Pod failed: {pod_status['reason']}")
            else:
                # Pod is running but SSH not ready yet - keep as preparing
                update_reservation_status(
                    reservation_id, "preparing", "Pod is running, SSH service still starting"
                )
                logger.warning(f"SSH not ready yet for {pod_name}, keeping reservation in preparing state")

        # GPU allocation handled automatically by K8s scheduler

        logger.info(
            f"Successfully created pod {pod_name} with SSH access on port {node_port}"
        )

    except Exception as e:
        logger.error(f"Error allocating GPU resources: {str(e)}")
        # Update reservation status to failed
        update_reservation_status(
            reservation_id, "failed", f"Resource allocation failed: {str(e)}"
        )
        raise


# Removed update_server_allocation - K8s handles GPU scheduling automatically


def delete_sqs_message(record: dict[str, Any]) -> None:
    """Delete message from SQS queue after successful processing"""
    try:
        receipt_handle = record.get("receiptHandle")
        if receipt_handle:
            sqs_client.delete_message(QueueUrl=QUEUE_URL, ReceiptHandle=receipt_handle)
            logger.info(f"Deleted message from queue: {record.get('messageId')}")
        else:
            logger.warning("No receipt handle found for message deletion")
    except Exception as e:
        logger.error(f"Error deleting SQS message: {str(e)}")


def update_reservation_status(
    reservation_id: str, status: str, reason: str = None
) -> None:
    """Update reservation status in DynamoDB"""
    try:
        if not reservation_id:
            return

        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        update_expression = "SET #status = :status"
        expression_values = {":status": status}

        if reason:
            update_expression += ", failure_reason = :reason"
            expression_values[":reason"] = reason

        reservations_table.update_item(
            Key={"reservation_id": reservation_id},
            UpdateExpression=update_expression,
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues=expression_values,
        )

        logger.info(f"Updated reservation {reservation_id} status to {status}")
    except Exception as e:
        logger.error(f"Error updating reservation status: {str(e)}")


def get_github_public_key(github_username: str) -> str:
    """Fetch GitHub public keys for user (all keys)"""
    try:
        import urllib.request

        url = f"https://github.com/{github_username}.keys"
        with urllib.request.urlopen(url) as response:
            keys = response.read().decode("utf-8").strip()
            if keys:
                # Return ALL SSH keys (users may have multiple)
                return keys
        return None
    except Exception as e:
        logger.error(f"Error fetching GitHub key for {github_username}: {str(e)}")
        return None


def create_kubernetes_resources(
    pod_name: str, gpu_count: int, github_public_key: str, reservation_id: str
) -> int:
    """Create Kubernetes pod and NodePort service using Python client"""
    try:
        from kubernetes import client
        
        # Configure Kubernetes client
        k8s_client = setup_kubernetes_client()
        v1 = client.CoreV1Api(k8s_client)

        # Check if pod already exists
        pod_exists = False
        existing_service_port = None
        
        try:
            existing_pod = v1.read_namespaced_pod(name=pod_name, namespace="gpu-dev")
            pod_exists = True
            pod_phase = existing_pod.status.phase
            logger.info(f"Pod {pod_name} already exists (phase: {pod_phase}), checking service...")
            
            # Check if service exists too
            try:
                existing_service = v1.read_namespaced_service(name=f"{pod_name}-ssh", namespace="gpu-dev")
                existing_service_port = existing_service.spec.ports[0].node_port
                logger.info(f"Service {pod_name}-ssh already exists on port {existing_service_port}")
            except client.exceptions.ApiException as service_error:
                if service_error.status == 404:
                    logger.info(f"Service {pod_name}-ssh does not exist, will create it")
                else:
                    raise
                    
        except client.exceptions.ApiException as pod_error:
            if pod_error.status != 404:
                raise
        
        if pod_exists and existing_service_port:
            # Both pod and service exist, use existing port
            node_port = existing_service_port
            logger.info(f"Using existing resources: pod {pod_name}, service port {node_port}")
        else:
            # Find available node port (30000-32767 range)
            node_port = find_available_node_port(k8s_client)

            # Create pod if it doesn't exist
            if not pod_exists:
                create_pod(k8s_client, pod_name, gpu_count, github_public_key)
                logger.info(f"Created new pod {pod_name}")
            
            # Create service if it doesn't exist
            if not existing_service_port:
                create_service(k8s_client, pod_name, node_port)
                logger.info(f"Created new service {pod_name}-ssh on port {node_port}")

        # Wait for pod to be ready (regardless of whether it was just created or already existed)
        wait_for_pod_ready(k8s_client, pod_name)

        return node_port

    except Exception as e:
        logger.error(f"Error creating Kubernetes resources: {str(e)}")
        raise


def find_available_node_port(k8s_client) -> int:
    """Find an available NodePort in the valid range"""
    try:
        import random

        from kubernetes import client

        # Get all services to check used ports
        v1 = client.CoreV1Api(k8s_client)
        services = v1.list_service_for_all_namespaces()

        used_ports = set()
        for svc in services.items:
            if svc.spec.ports:
                for port in svc.spec.ports:
                    if port.node_port:
                        used_ports.add(port.node_port)

        # NodePort range: 30000-32767
        for _ in range(10):  # Try 10 random ports
            port = random.randint(30000, 32767)
            if port not in used_ports:
                return port

        # Fallback to sequential search
        for port in range(30000, 32768):
            if port not in used_ports:
                return port

        raise ValueError("No available NodePort found")

    except Exception as e:
        logger.error(f"Error finding available node port: {str(e)}")
        # Fallback to random port if can't check
        import random

        return random.randint(30000, 32767)


def create_pod(k8s_client, pod_name: str, gpu_count: int, github_public_key: str):
    """Create Kubernetes pod with GPU resources and SSH setup"""
    try:
        from kubernetes import client

        v1 = client.CoreV1Api(k8s_client)

        # Create pod spec
        pod_spec = client.V1PodSpec(
            restart_policy="Never",
            init_containers=[
                client.V1Container(
                    name="ssh-setup",
                    image="alpine:latest",
                    command=["/bin/sh"],
                    args=[
                        "-c",
                        f"""
                        echo "[INIT] Setting up dev user and SSH keys..."

                        # Create dev user with specific UID for consistency (Alpine uses adduser)
                        adduser -D -u 1000 -s /bin/bash dev

                        # Set up SSH directory and keys with correct ownership
                        mkdir -p /home/dev/.ssh
                        echo '{github_public_key}' > /home/dev/.ssh/authorized_keys
                        chmod 700 /home/dev/.ssh
                        chmod 600 /home/dev/.ssh/authorized_keys
                        chown -R 1000:1000 /home/dev/.ssh
                        chown -R 1000:1000 /home/dev

                        # Create marker file to verify init completed
                        echo "SSH keys initialized at $(date)" > /home/dev/.ssh/init_complete
                        chown 1000:1000 /home/dev/.ssh/init_complete

                        echo "[INIT] Dev user and SSH key setup complete"
                        """,
                    ],
                    volume_mounts=[
                        client.V1VolumeMount(name="dev-home", mount_path="/home/dev")
                    ],
                )
            ],
            containers=[
                client.V1Container(
                    name="gpu-dev",
                    image="pytorch/pytorch:2.8.0-cuda12.9-cudnn9-runtime",
                    command=["/bin/bash"],
                    args=[
                        "-c",
                        """
                        set -e  # Exit on any error

                        echo "[STARTUP] Installing SSH server..."
                        apt-get update -qq
                        apt-get install -y openssh-server sudo curl vim

                        echo "[STARTUP] Setting up dev user..."
                        # Create dev user with same UID as init container (should already exist from volume)
                        id dev &>/dev/null || useradd -u 1000 -m -s /bin/bash dev
                        # NO password for dev user - passwordless sudo only
                        usermod -aG sudo dev
                        # Allow passwordless sudo for dev user
                        echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev

                        echo "[STARTUP] Configuring SSH..."
                        mkdir -p /run/sshd
                        mkdir -p /var/run/sshd

                        # Configure SSH daemon - NO password authentication
                        cat > /etc/ssh/sshd_config << 'EOF'
Port 22
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
HostKey /etc/ssh/ssh_host_rsa_key
HostKey /etc/ssh/ssh_host_ecdsa_key
HostKey /etc/ssh/ssh_host_ed25519_key
UsePAM yes
X11Forwarding yes
PrintMotd no
PrintLastLog yes
AcceptEnv LANG LC_*
Subsystem sftp /usr/lib/openssh/sftp-server
EOF

                        # Generate host keys if they don't exist
                        ssh-keygen -A

                        echo "[STARTUP] Setting up dev user home directory..."
                        chown -R 1000:1000 /home/dev

                        # Verify SSH keys were set up by init container
                        if [ -f /home/dev/.ssh/authorized_keys ]; then
                            echo "[STARTUP] SSH keys found, setting proper ownership"
                            chown -R 1000:1000 /home/dev/.ssh
                            chmod 700 /home/dev/.ssh
                            chmod 600 /home/dev/.ssh/authorized_keys
                        else
                            echo "[STARTUP] WARNING: No SSH keys found from init container!"
                        fi

                        echo "[STARTUP] Setting up custom MOTD..."
                        # Remove ALL default Ubuntu MOTD files and disclaimers
                        rm -f /etc/motd /etc/update-motd.d/* /etc/legal /usr/share/base-files/motd 2>/dev/null || true
                        
                        # Create necessary directories if they don't exist
                        mkdir -p /etc/motd.d /etc/update-motd.d /var/lib/sudo/lectured
                        
                        # Disable Ubuntu's built-in copyright notices
                        touch /etc/motd.d/00-header
                        chmod 644 /etc/motd.d/00-header
                        
                        # Disable the sudo reminder by creating empty file and all possible methods
                        touch /var/lib/sudo/lectured/dev
                        mkdir -p /var/lib/sudo/lectured 
                        echo "dev" > /var/lib/sudo/lectured/dev
                        
                        # Also disable sudo lecture in sudoers
                        echo 'Defaults lecture=never' >> /etc/sudoers.d/dev
                        echo 'Defaults !lecture' >> /etc/sudoers.d/dev
                        
                        # Create custom MOTD script with proper error handling
                        cat > /etc/update-motd.d/00-custom << 'MOTD_EOF'
#!/bin/bash
# Custom MOTD for GPU dev servers

# Get OS info
OS_INFO=$(lsb_release -d 2>/dev/null | cut -f2 || echo "Ubuntu 22.04.5 LTS")

# Get container info  
CONTAINER_IMAGE="pytorch/pytorch:2.8.0-cuda12.9-cudnn9-runtime"

# Get GPU info with error handling
GPU_INFO="GPU detection unavailable"
if command -v nvidia-smi >/dev/null 2>&1; then
    # Parse nvidia-smi output to get GPU count and model
    GPU_DATA=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null)
    if [ $? -eq 0 ] && [ -n "$GPU_DATA" ]; then
        # Count GPUs and get first GPU model/memory
        GPU_COUNT=$(echo "$GPU_DATA" | wc -l)
        FIRST_GPU=$(echo "$GPU_DATA" | head -1)
        GPU_NAME=$(echo "$FIRST_GPU" | cut -d',' -f1 | xargs)
        GPU_MEMORY=$(echo "$FIRST_GPU" | cut -d',' -f2 | xargs)
        
        if [ "$GPU_COUNT" -eq 1 ]; then
            GPU_INFO="1x $GPU_NAME, ${GPU_MEMORY}MiB"
        else
            GPU_INFO="${GPU_COUNT}x $GPU_NAME, ${GPU_MEMORY}MiB each"
        fi
    fi
fi

# Display custom welcome message
cat << WELCOME_EOF

🚀 Welcome to your GPU development server!

System: $OS_INFO
Container: $CONTAINER_IMAGE  
GPUs: $GPU_INFO

For support, reach out to: oncall:pytorch_release_engineering

Happy coding! 🐍⚡

WELCOME_EOF
MOTD_EOF

                        # Make MOTD script executable
                        chmod +x /etc/update-motd.d/00-custom
                        
                        # Generate the MOTD once (no dynamic updates to avoid duplicates)
                        /etc/update-motd.d/00-custom > /etc/motd 2>/dev/null || echo "Welcome to GPU dev server!" > /etc/motd
                        
                        # Also add to user's shell profile to ensure it shows
                        cat > /home/dev/.bash_profile << 'PROFILE_EOF'
# Custom welcome message
if [ -f /etc/motd ]; then
    cat /etc/motd
fi
PROFILE_EOF
                        chown 1000:1000 /home/dev/.bash_profile
                        
                        # Disable PAM's dynamic MOTD completely
                        sed -i 's/session    optional     pam_motd.so/#&/g' /etc/pam.d/sshd 2>/dev/null || true
                        sed -i 's/session    optional     pam_motd.so  motd=/#&/g' /etc/pam.d/sshd 2>/dev/null || true
                        
                        # Remove additional Ubuntu legal notices and update system
                        rm -rf /etc/update-motd.d/00-header /etc/update-motd.d/10-help-text /etc/update-motd.d/80-esm /etc/update-motd.d/95-hwe-eol 2>/dev/null || true
                        chmod -x /usr/sbin/update-motd 2>/dev/null || true
                        
                        # Disable Ubuntu Pro advertisements and legal notices
                        echo 'export UBUNTU_PRO_HIDDEN=1' >> /home/dev/.bashrc
                        touch /etc/motd.d/00-header /etc/motd.d/10-help-text

                        echo "[STARTUP] Starting SSH daemon..."
                        # Test SSH config first
                        /usr/sbin/sshd -t

                        # Start SSH daemon in foreground
                        echo "[STARTUP] SSH daemon starting on port 22"
                        exec /usr/sbin/sshd -D -e
                        """,
                    ],
                    ports=[client.V1ContainerPort(container_port=22)],
                    resources=client.V1ResourceRequirements(
                        limits={"nvidia.com/gpu": str(gpu_count)},
                        requests={"nvidia.com/gpu": str(gpu_count)},
                    ),
                    volume_mounts=[
                        client.V1VolumeMount(name="dev-home", mount_path="/home/dev"),
                        client.V1VolumeMount(
                            name="shared-workspace", mount_path="/workspace"
                        ),
                    ],
                )
            ],
            volumes=[
                client.V1Volume(
                    name="dev-home", empty_dir=client.V1EmptyDirVolumeSource()
                ),
                client.V1Volume(
                    name="shared-workspace",
                    empty_dir=client.V1EmptyDirVolumeSource(size_limit="100Gi"),
                ),
            ],
            tolerations=[
                client.V1Toleration(
                    key="nvidia.com/gpu", operator="Exists", effect="NoSchedule"
                )
            ],
        )

        # Create pod metadata
        pod_metadata = client.V1ObjectMeta(
            name=pod_name,
            namespace="gpu-dev",
            labels={"app": "gpu-dev-pod", "reservation": pod_name},
        )

        # Create pod
        pod = client.V1Pod(metadata=pod_metadata, spec=pod_spec)
        v1.create_namespaced_pod(namespace="gpu-dev", body=pod)

        logger.info(f"Created pod {pod_name}")

    except Exception as e:
        logger.error(f"Error creating pod {pod_name}: {str(e)}")
        raise


def create_service(k8s_client, pod_name: str, node_port: int):
    """Create NodePort service for SSH access"""
    try:
        from kubernetes import client

        v1 = client.CoreV1Api(k8s_client)

        # Create service spec
        service_spec = client.V1ServiceSpec(
            type="NodePort",
            ports=[
                client.V1ServicePort(
                    port=22, target_port=22, node_port=node_port, protocol="TCP"
                )
            ],
            selector={"reservation": pod_name},
        )

        # Create service metadata
        service_metadata = client.V1ObjectMeta(
            name=f"{pod_name}-ssh", namespace="gpu-dev"
        )

        # Create service
        service = client.V1Service(metadata=service_metadata, spec=service_spec)
        v1.create_namespaced_service(namespace="gpu-dev", body=service)

        logger.info(f"Created service {pod_name}-ssh on port {node_port}")

    except Exception as e:
        logger.error(f"Error creating service for {pod_name}: {str(e)}")
        raise


def generate_pod_yaml(pod_name: str, gpu_count: int, github_public_key: str) -> str:
    """Generate Kubernetes pod YAML with GPU resources and SSH setup"""
    return f"""
apiVersion: v1
kind: Pod
metadata:
  name: {pod_name}
  namespace: gpu-dev
  labels:
    app: gpu-dev-pod
    reservation: {pod_name}
spec:
  restartPolicy: Never
  initContainers:
  - name: ssh-setup
    image: alpine:latest
    command: ["/bin/sh"]
    args:
    - -c
    - |
      mkdir -p /home/dev/.ssh
      echo '{github_public_key}' > /home/dev/.ssh/authorized_keys
      chmod 700 /home/dev/.ssh
      chmod 600 /home/dev/.ssh/authorized_keys
      chown -R 1000:1000 /home/dev/.ssh
    volumeMounts:
    - name: dev-home
      mountPath: /home/dev
  containers:
  - name: gpu-dev
    image: pytorch/pytorch:2.8.0-cuda12.9-cudnn9-runtime

    command: ["/bin/bash"]
    args:
    - -c
    - |
      # Install SSH server
      apt-get update && apt-get install -y openssh-server sudo

      # Create dev user
      useradd -m -s /bin/bash dev
      echo 'dev:dev' | chpasswd
      usermod -aG sudo dev

      # Configure SSH
      mkdir -p /run/sshd
      echo 'PermitRootLogin no' >> /etc/ssh/sshd_config
      echo 'PasswordAuthentication no' >> /etc/ssh/sshd_config
      echo 'PubkeyAuthentication yes' >> /etc/ssh/sshd_config

      # Start SSH daemon
      /usr/sbin/sshd -D
    ports:
    - containerPort: 22
    resources:
      limits:
        nvidia.com/gpu: {gpu_count}
      requests:
        nvidia.com/gpu: {gpu_count}
    volumeMounts:
    - name: dev-home
      mountPath: /home/dev
    - name: shared-workspace
      mountPath: /workspace
  volumes:
  - name: dev-home
    emptyDir: {{}}
  - name: shared-workspace
    emptyDir:
      sizeLimit: 100Gi
  tolerations:
  - key: nvidia.com/gpu
    operator: Exists
    effect: NoSchedule
"""


def generate_service_yaml(pod_name: str, node_port: int) -> str:
    """Generate Kubernetes NodePort service YAML"""
    return f"""
apiVersion: v1
kind: Service
metadata:
  name: {pod_name}-ssh
  namespace: gpu-dev
spec:
  type: NodePort
  ports:
  - port: 22
    targetPort: 22
    nodePort: {node_port}
    protocol: TCP
  selector:
    reservation: {pod_name}
"""


def apply_kubernetes_yaml(yaml_content: str, filename: str):
    """Apply Kubernetes YAML using kubectl"""
    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
            f.write(yaml_content)
            f.flush()

            cmd = ["kubectl", "apply", "-f", f.name]
            result = subprocess.run(cmd, check=True, capture_output=True, text=True)
            logger.info(f"Applied {filename}: {result.stdout.strip()}")

    except subprocess.CalledProcessError as e:
        logger.error(f"Failed to apply {filename}: {e.stderr.decode()}")
        raise
    finally:
        try:
            os.unlink(f.name)
        except Exception:
            pass


def wait_for_pod_ready(k8s_client, pod_name: str, timeout_seconds: int = 300):
    """Wait for pod to be ready"""
    try:
        import time

        from kubernetes import client

        v1 = client.CoreV1Api(k8s_client)

        start_time = time.time()
        while time.time() - start_time < timeout_seconds:
            try:
                pod = v1.read_namespaced_pod(name=pod_name, namespace="gpu-dev")

                # Check if pod is ready
                if pod.status.conditions:
                    for condition in pod.status.conditions:
                        if condition.type == "Ready" and condition.status == "True":
                            logger.info(f"Pod {pod_name} is ready")
                            return

            except Exception as e:
                logger.warning(f"Error checking pod status: {str(e)}")

            time.sleep(10)

        raise TimeoutError(
            f"Pod {pod_name} did not become ready within {timeout_seconds} seconds"
        )

    except Exception as e:
        logger.error(f"Error waiting for pod ready: {str(e)}")
        raise


def get_node_public_ip() -> str:
    """Get public IP of EKS node for SSH access"""
    try:
        # Get node information using Kubernetes client
        k8s_client = setup_kubernetes_client()
        from kubernetes import client

        v1 = client.CoreV1Api(k8s_client)
        nodes = v1.list_node()

        for node in nodes.items:
            if node.status.addresses:
                for addr in node.status.addresses:
                    if addr.type == "ExternalIP":
                        return addr.address

        # Fallback: try to get from instance metadata
        instance_id = get_node_instance_id()
        if instance_id:
            response = ec2_client.describe_instances(InstanceIds=[instance_id])
            instance = response["Reservations"][0]["Instances"][0]
            return instance.get("PublicIpAddress", "")

        raise ValueError("Could not determine node public IP")

    except Exception as e:
        logger.error(f"Error getting node public IP: {str(e)}")
        raise


def get_node_instance_id() -> str:
    """Get EC2 instance ID of one of the EKS nodes"""
    try:
        k8s_client = setup_kubernetes_client()
        from kubernetes import client

        v1 = client.CoreV1Api(k8s_client)
        nodes = v1.list_node()

        for node in nodes.items:
            if node.spec.provider_id:
                provider_id = node.spec.provider_id
                if "aws:///" in provider_id:
                    # Extract instance ID from providerID like "aws:///us-east-2a/i-1234567890abcdef0"
                    return provider_id.split("/")[-1]

        return None

    except Exception as e:
        logger.error(f"Error getting node instance ID: {str(e)}")
        return None


def get_instance_type_and_gpu_info(k8s_client, pod_name: str) -> tuple[str, str]:
    """Get instance type and GPU type from the node where pod is scheduled"""
    try:
        from kubernetes import client
        
        v1 = client.CoreV1Api(k8s_client)
        
        # Get pod to find which node it's scheduled on
        pod = v1.read_namespaced_pod(name=pod_name, namespace="gpu-dev")
        node_name = pod.spec.node_name
        
        if not node_name:
            return "unknown", "unknown"
        
        # Get node details to find instance type
        node = v1.read_node(name=node_name)
        instance_type = node.metadata.labels.get("node.kubernetes.io/instance-type", "unknown")
        
        # Map instance type to GPU type
        gpu_type_mapping = {
            "g4dn.xlarge": "T4",
            "g4dn.2xlarge": "T4", 
            "g4dn.4xlarge": "T4",
            "g4dn.8xlarge": "T4",
            "g4dn.12xlarge": "T4",
            "g4dn.16xlarge": "T4",
            "p5.48xlarge": "H100",
        }
        
        gpu_type = gpu_type_mapping.get(instance_type, "Unknown")
        
        logger.info(f"Pod {pod_name} scheduled on node {node_name} with instance type {instance_type} (GPU: {gpu_type})")
        return instance_type, gpu_type
        
    except Exception as e:
        logger.error(f"Error getting instance type for pod {pod_name}: {e}")
        return "unknown", "unknown"


def update_reservation_connection_info(
    reservation_id: str, ssh_command: str, pod_name: str, node_port: int, node_ip: str
):
    """Update reservation with connection details and set proper expiration time"""
    try:
        from datetime import datetime, timedelta
        
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        
        # Get the original reservation to find the duration
        response = reservations_table.get_item(Key={"reservation_id": reservation_id})
        if "Item" not in response:
            raise ValueError(f"Reservation {reservation_id} not found")
        
        reservation = response["Item"]
        duration_hours = float(reservation.get("duration_hours", 2))  # Default 2 hours if not found
        
        # Set expiration time from NOW (when reservation becomes active)
        now = datetime.utcnow()
        expires_at = (now + timedelta(hours=duration_hours)).isoformat()
        launched_at = now.isoformat()
        
        # Get instance type and GPU type info
        k8s_client = setup_kubernetes_client()
        instance_type, gpu_type = get_instance_type_and_gpu_info(k8s_client, pod_name)
        
        reservations_table.update_item(
            Key={"reservation_id": reservation_id},
            UpdateExpression="""
                SET ssh_command = :ssh_command,
                    pod_name = :pod_name,
                    node_port = :node_port,
                    node_ip = :node_ip,
                    expires_at = :expires_at,
                    launched_at = :launched_at,
                    namespace = :namespace,
                    instance_type = :instance_type,
                    gpu_type = :gpu_type,
                    #status = :status
            """,
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":ssh_command": ssh_command,
                ":pod_name": pod_name,
                ":node_port": node_port,
                ":node_ip": node_ip,
                ":expires_at": expires_at,
                ":launched_at": launched_at,
                ":namespace": "gpu-dev",
                ":instance_type": instance_type,
                ":gpu_type": gpu_type,
                ":status": "active",
            },
        )
        logger.info(f"Updated reservation {reservation_id} with connection info and expires_at={expires_at}")

    except Exception as e:
        logger.error(f"Error updating reservation connection info: {str(e)}")
        raise


def calculate_queue_position_and_wait_time(
    reservation_id: str, requested_gpus: int, available_gpus: int
) -> dict:
    """Calculate queue position and estimated wait time for a reservation"""
    try:
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)

        # Get all active reservations to calculate expiry times
        active_response = reservations_table.query(
            IndexName="StatusIndex",
            KeyConditionExpression="#status = :status",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":status": "active"},
        )
        active_reservations = active_response.get("Items", [])

        # Get all queued/pending reservations to calculate queue position
        queued_reservations = []
        for status in ["queued", "pending"]:
            response = reservations_table.query(
                IndexName="StatusIndex",
                KeyConditionExpression="#status = :status",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={":status": status},
            )
            queued_reservations.extend(response.get("Items", []))

        # Sort queued reservations by creation time to determine position
        queued_reservations.sort(key=lambda x: x.get("created_at", ""))

        # Find position of current reservation
        queue_position = 1
        for i, reservation in enumerate(queued_reservations):
            if reservation["reservation_id"] == reservation_id:
                queue_position = i + 1
                break

        # Use K8s GPU tracker for more accurate wait time estimation
        try:
            k8s_client = setup_kubernetes_client()
            gpu_tracker = K8sGPUTracker(k8s_client)
            wait_estimate = gpu_tracker.estimate_wait_time(
                requested_gpus, active_reservations
            )
            estimated_wait_minutes = wait_estimate.get("estimated_wait_minutes", 30)
        except Exception as e:
            logger.warning(f"Could not get K8s wait estimate: {e}")
            # Fallback: simple estimation based on queue position
            estimated_wait_minutes = (
                queue_position * 15
            )  # 15 minutes per position estimate

        return {
            "position": queue_position,
            "estimated_wait_minutes": estimated_wait_minutes,
            "total_queued": len(queued_reservations),
            "available_gpus": available_gpus,
        }

    except Exception as e:
        logger.error(f"Error calculating queue position: {e}")
        return {
            "position": "?",
            "estimated_wait_minutes": "?",
            "total_queued": 0,
            "available_gpus": available_gpus,
        }


def update_reservation_with_queue_info(
    reservation_id: str,
    queue_position: str,
    estimated_wait_minutes: str,
    available_gpus: int,
):
    """Update reservation with queue position and wait time information"""
    try:
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)

        reservations_table.update_item(
            Key={"reservation_id": reservation_id},
            UpdateExpression="""
                SET queue_position = :queue_position,
                    estimated_wait_minutes = :estimated_wait_minutes,
                    available_gpus = :available_gpus,
                    last_queue_update = :last_update
            """,
            ExpressionAttributeValues={
                ":queue_position": queue_position if queue_position != "?" else None,
                ":estimated_wait_minutes": (
                    estimated_wait_minutes if estimated_wait_minutes != "?" else None
                ),
                ":available_gpus": available_gpus,
                ":last_update": datetime.utcnow().isoformat(),
            },
        )
        logger.info(
            f"Updated reservation {reservation_id} with queue info: pos={queue_position}, wait={estimated_wait_minutes}min"
        )

    except Exception as e:
        logger.error(f"Error updating reservation queue info: {str(e)}")


def wait_for_ssh_service(k8s_client, pod_name: str, node_ip: str, node_port: int, timeout_seconds: int = 180) -> bool:
    """Wait for SSH service to be ready by checking pod logs and testing connectivity"""
    try:
        import socket
        from kubernetes import client
        
        v1 = client.CoreV1Api(k8s_client)
        start_time = time.time()
        
        logger.info(f"Waiting up to {timeout_seconds}s for SSH service on {pod_name}")
        
        while time.time() - start_time < timeout_seconds:
            try:
                # Check pod logs for SSH daemon startup
                logs = v1.read_namespaced_pod_log(
                    name=pod_name, 
                    namespace="gpu-dev", 
                    tail_lines=50
                )
                
                if "SSH daemon starting on port 22" in logs:
                    logger.info("SSH daemon has started according to logs")
                    
                    # Give SSH daemon a moment to fully start
                    time.sleep(5)
                    
                    # Test actual connectivity
                    try:
                        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                        sock.settimeout(10)
                        result = sock.connect_ex((node_ip, node_port))
                        sock.close()
                        
                        if result == 0:
                            logger.info(f"SSH service is responding on {node_ip}:{node_port}")
                            return True
                        else:
                            logger.info(f"SSH port not yet accessible: {result}")
                    except Exception as e:
                        logger.info(f"SSH connectivity test failed: {e}")
                
            except Exception as e:
                logger.warning(f"Error checking SSH readiness: {e}")
            
            time.sleep(10)
        
        logger.warning(f"SSH service not ready after {timeout_seconds} seconds")
        return False
        
    except Exception as e:
        logger.error(f"Error waiting for SSH service: {e}")
        return False


def get_detailed_pod_status(k8s_client, pod_name: str) -> dict:
    """Get detailed pod status including phase, conditions, and error messages"""
    try:
        from kubernetes import client
        
        v1 = client.CoreV1Api(k8s_client)
        pod = v1.read_namespaced_pod(name=pod_name, namespace="gpu-dev")
        
        phase = pod.status.phase
        has_errors = False
        reason = "Unknown"
        
        # Check container statuses for errors
        if pod.status.container_statuses:
            for container_status in pod.status.container_statuses:
                if container_status.state.waiting:
                    if container_status.state.waiting.reason in ['ImagePullBackOff', 'ErrImagePull', 'CrashLoopBackOff']:
                        has_errors = True
                        reason = f"Container {container_status.name}: {container_status.state.waiting.reason}"
                elif container_status.state.terminated:
                    if container_status.state.terminated.exit_code != 0:
                        has_errors = True
                        reason = f"Container {container_status.name} exited with code {container_status.state.terminated.exit_code}"
        
        # Check pod conditions
        if pod.status.conditions:
            for condition in pod.status.conditions:
                if condition.type == "PodScheduled" and condition.status == "False":
                    has_errors = True
                    reason = f"Scheduling failed: {condition.message}"
        
        return {
            'phase': phase,
            'has_errors': has_errors,
            'reason': reason
        }
        
    except Exception as e:
        logger.error(f"Error getting pod status: {e}")
        return {
            'phase': 'Unknown',
            'has_errors': True,
            'reason': f"Error getting status: {e}"
        }


def process_scheduled_queue_management():
    """Process queued reservations and update ETAs every minute"""
    try:
        current_time = int(time.time())
        logger.info(f"Processing scheduled queue management at timestamp {current_time}")

        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        
        # Get all queued reservations (NOT pending - those are handled by SQS)
        # Scheduled processing should only handle reservations that are truly queued
        queued_statuses = ["queued"]  # Only process truly queued, not fresh pending ones
        all_queued_reservations = []
        
        for status in queued_statuses:
            try:
                response = reservations_table.query(
                    IndexName="StatusIndex",
                    KeyConditionExpression="#status = :status",
                    ExpressionAttributeNames={"#status": "status"},
                    ExpressionAttributeValues={":status": status},
                )
                # Filter out reservations that are too new (less than 30 seconds old)
                # This prevents collision with SQS processing
                raw_reservations = response.get("Items", [])
                filtered_reservations = []
                
                for reservation in raw_reservations:
                    created_at = reservation.get("created_at", "")
                    try:
                        if isinstance(created_at, str):
                            created_timestamp = int(
                                datetime.fromisoformat(created_at.replace("Z", "+00:00")).timestamp()
                            )
                        else:
                            created_timestamp = int(created_at)
                        
                        # Only process reservations older than 30 seconds to avoid SQS collision
                        if current_time - created_timestamp > 30:
                            filtered_reservations.append(reservation)
                        else:
                            logger.info(f"Skipping recent reservation {reservation['reservation_id'][:8]} to avoid SQS collision")
                    except Exception as e:
                        logger.warning(f"Could not parse created_at for reservation {reservation.get('reservation_id', 'unknown')}: {e}")
                        # If we can't parse timestamp, include it to be safe
                        filtered_reservations.append(reservation)
                
                all_queued_reservations.extend(filtered_reservations)
            except Exception as e:
                logger.error(f"Error querying {status} reservations: {e}")

        logger.info(f"Found {len(all_queued_reservations)} queued reservations (excluding recent ones)")

        if not all_queued_reservations:
            return {
                "statusCode": 200,
                "body": json.dumps({"message": "No queued reservations to process", "processed": 0}),
            }

        # Set up K8s client and tracker for resource checking
        k8s_client = setup_kubernetes_client()
        gpu_tracker = K8sGPUTracker(k8s_client)
        
        # Get current GPU availability
        try:
            capacity_info = gpu_tracker.get_gpu_capacity_info()
            available_gpus = capacity_info["available_gpus"]
            logger.info(f"Current GPU availability: {available_gpus} GPUs available")
        except Exception as e:
            logger.error(f"Error getting GPU capacity: {e}")
            available_gpus = 0

        # Get active reservations for ETA calculations
        try:
            active_response = reservations_table.query(
                IndexName="StatusIndex",
                KeyConditionExpression="#status = :status",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={":status": "active"},
            )
            active_reservations = active_response.get("Items", [])
        except Exception as e:
            logger.error(f"Error querying active reservations: {e}")
            active_reservations = []

        # Sort queued reservations by creation time (FIFO)
        all_queued_reservations.sort(key=lambda x: x.get("created_at", ""))
        
        processed_count = 0
        allocated_count = 0
        updated_count = 0

        # Try to allocate resources for queued reservations
        for i, reservation in enumerate(all_queued_reservations):
            try:
                reservation_id = reservation["reservation_id"]
                requested_gpus = int(reservation.get("gpu_count", 1))
                current_status = reservation.get("status", "pending")
                
                # Check if this reservation can be allocated now
                if available_gpus >= requested_gpus:
                    logger.info(f"Allocating {requested_gpus} GPUs for reservation {reservation_id}")
                    
                    # Update status to preparing
                    update_reservation_status(reservation_id, "preparing", "GPUs available - preparing environment")
                    
                    # Try to create the actual resources
                    try:
                        # Create reservation using the same logic as the SQS handler
                        allocation_success = allocate_gpu_resources(reservation_id, reservation)
                        if allocation_success is not False:  # None or True means success
                            available_gpus -= requested_gpus  # Reduce available count
                            allocated_count += 1
                            logger.info(f"Successfully allocated resources for reservation {reservation_id}")
                        else:
                            logger.warning(f"Failed to allocate resources for reservation {reservation_id}")
                            update_reservation_status(reservation_id, "queued", "Allocation failed, back to queue")
                    except Exception as alloc_error:
                        logger.error(f"Error allocating resources for {reservation_id}: {alloc_error}")
                        update_reservation_status(reservation_id, "queued", f"Allocation error: {str(alloc_error)}")
                else:
                    # Update queue position and ETA for waiting reservations
                    queue_position = i + 1
                    
                    # Calculate estimated wait time using K8s tracker
                    try:
                        wait_estimate = gpu_tracker.estimate_wait_time(requested_gpus, active_reservations)
                        estimated_wait_minutes = wait_estimate.get("estimated_wait_minutes", 30)
                    except Exception as e:
                        logger.warning(f"Could not calculate wait time: {e}")
                        estimated_wait_minutes = queue_position * 15  # Fallback: 15min per position

                    # Update reservation with current queue info
                    update_reservation_with_queue_info(
                        reservation_id, 
                        str(queue_position), 
                        str(estimated_wait_minutes),
                        available_gpus
                    )
                    
                    # Update status with human-readable timestamps if needed
                    if current_status == "pending":
                        update_reservation_status(reservation_id, "queued", f"In queue position #{queue_position}")
                    
                    updated_count += 1
                    logger.info(f"Updated queue info for reservation {reservation_id}: pos={queue_position}, wait={estimated_wait_minutes}min")

                processed_count += 1

            except Exception as e:
                logger.error(f"Error processing reservation {reservation.get('reservation_id', 'unknown')}: {e}")
                continue

        logger.info(f"Queue processing complete: {processed_count} processed, {allocated_count} allocated, {updated_count} updated")

        return {
            "statusCode": 200,
            "body": json.dumps({
                "message": "Queue processing completed",
                "processed": processed_count,
                "allocated": allocated_count,
                "updated": updated_count,
                "available_gpus": available_gpus
            }),
        }

    except Exception as e:
        logger.error(f"Error in scheduled queue management: {str(e)}")
        raise


def process_cancellation_request(record: dict[str, Any]) -> bool:
    """Process cancellation request from SQS message"""
    try:
        # Parse the cancellation request
        message_body = json.loads(record["body"])
        
        logger.info(f"Processing cancellation: {message_body}")
        
        reservation_id = message_body.get("reservation_id")
        user_id = message_body.get("user_id")
        
        if not reservation_id or not user_id:
            logger.error(f"Invalid cancellation request - missing reservation_id or user_id: {message_body}")
            return True  # Don't retry malformed messages
        
        # Get current reservation to check status and ownership
        # Search by prefix - allows short reservation IDs
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)

        try:
            scan_response = reservations_table.scan(
                FilterExpression="begins_with(reservation_id, :prefix) AND user_id = :user_id",
                ExpressionAttributeValues={
                    ":prefix": reservation_id,
                    ":user_id": user_id
                }
            )

            items = scan_response.get("Items", [])
            if len(items) == 0:
                logger.warning(f"Reservation {reservation_id} not found for user {user_id}")
                return True  # Don't retry - reservation doesn't exist
            elif len(items) > 1:
                logger.error(f"Ambiguous reservation ID {reservation_id} - found {len(items)} matches for user {user_id}")
                return True  # Don't retry - ambiguous prefix

            reservation = items[0]
            full_reservation_id = reservation["reservation_id"]  # Get the full UUID

            current_status = reservation.get("status")

            # Can only cancel active, queued, pending, or preparing reservations
            if current_status not in ["active", "queued", "pending", "preparing"]:
                logger.warning(f"Cannot cancel reservation {full_reservation_id} in status {current_status}")
                return True  # Don't retry - invalid status

            logger.info(f"Cancelling reservation {full_reservation_id} (prefix: {reservation_id}) for user {user_id} (current status: {current_status})")

            # Update reservation status to cancelled
            now = datetime.utcnow().isoformat()
            reservations_table.update_item(
                Key={"reservation_id": full_reservation_id},
                UpdateExpression="SET #status = :status, cancelled_at = :cancelled_at, reservation_ended = :reservation_ended",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={
                    ":status": "cancelled",
                    ":cancelled_at": now,
                    ":reservation_ended": now,
                },
            )
            
            # If it was an active reservation, clean up the pod
            if current_status == "active":
                pod_name = reservation.get("pod_name")
                namespace = reservation.get("namespace", "gpu-dev")
                
                if pod_name:
                    try:
                        cleanup_pod_resources(pod_name, namespace)
                        logger.info(f"Cleaned up pod resources for cancelled reservation {full_reservation_id}")
                    except Exception as cleanup_error:
                        logger.error(f"Error cleaning up pod {pod_name}: {cleanup_error}")
                        # Don't fail the cancellation if cleanup fails

            logger.info(f"Successfully cancelled reservation {full_reservation_id}")
            return True

        except Exception as db_error:
            logger.error(f"Database error processing cancellation for {reservation_id}: {db_error}")
            return False  # Retry on database errors
            
    except Exception as e:
        logger.error(f"Error processing cancellation request: {str(e)}")
        return False  # Retry on processing errors


def cleanup_pod_resources(pod_name: str, namespace: str = "gpu-dev") -> None:
    """Clean up Kubernetes pod and associated service resources"""
    try:
        logger.info(f"Cleaning up pod {pod_name} in namespace {namespace}")

        # Configure Kubernetes client
        from kubernetes import client
        k8s_client = setup_kubernetes_client()
        v1 = client.CoreV1Api(k8s_client)

        # Delete the NodePort service first
        service_name = f"{pod_name}-ssh"
        try:
            v1.delete_namespaced_service(
                name=service_name, namespace=namespace, grace_period_seconds=0
            )
            logger.info(f"Deleted service {service_name}")
        except client.exceptions.ApiException as e:
            if e.status == 404:
                logger.info(f"Service {service_name} not found (already deleted)")
            else:
                logger.warning(f"Failed to delete service {service_name}: {e}")

        # Delete the pod with grace period  
        try:
            v1.delete_namespaced_pod(
                name=pod_name, namespace=namespace, grace_period_seconds=30
            )
            logger.info(f"Deleted pod {pod_name}")
        except client.exceptions.ApiException as e:
            if e.status == 404:
                logger.info(f"Pod {pod_name} not found (already deleted)")
            else:
                logger.error(f"Failed to delete pod {pod_name}: {e}")
                # Try force delete if graceful deletion failed
                try:
                    v1.delete_namespaced_pod(
                        name=pod_name, namespace=namespace, grace_period_seconds=0
                    )
                    logger.info(f"Force deleted pod {pod_name}")
                except client.exceptions.ApiException as force_error:
                    logger.error(f"Failed to force delete pod {pod_name}: {force_error}")
                    raise

    except Exception as e:
        logger.error(f"Error cleaning up pod {pod_name}: {str(e)}")
        raise
