"""
GPU Reservation Processor Lambda
Handles reservation requests and manages K8s pod allocation
"""

import json
import os
import boto3
import logging
import base64
import tempfile
from datetime import datetime, timedelta
from typing import Dict, Any
import uuid

# Setup logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# AWS clients
dynamodb = boto3.resource('dynamodb')
eks_client = boto3.client('eks')
ec2_client = boto3.client('ec2')
sqs_client = boto3.client('sqs')

# Environment variables
RESERVATIONS_TABLE = os.environ['RESERVATIONS_TABLE']
SERVERS_TABLE = os.environ['SERVERS_TABLE']
EKS_CLUSTER_NAME = os.environ['EKS_CLUSTER_NAME']
REGION = os.environ['REGION']
MAX_RESERVATION_HOURS = int(os.environ['MAX_RESERVATION_HOURS'])
DEFAULT_TIMEOUT_HOURS = int(os.environ['DEFAULT_TIMEOUT_HOURS'])
QUEUE_URL = os.environ['QUEUE_URL']


def handler(event, context):
    """Main Lambda handler"""
    try:
        logger.info(f"Processing event: {json.dumps(event)}")

        # Process SQS messages
        for record in event.get('Records', []):
            if record.get('eventSource') == 'aws:sqs':
                success = process_reservation_request(record)

                # Delete message from queue if processed successfully
                if success:
                    delete_sqs_message(record)

        return {
            'statusCode': 200,
            'body': json.dumps({'message': 'Processing completed'})
        }

    except Exception as e:
        logger.error(f"Error processing event: {str(e)}")
        raise


def process_reservation_request(record: Dict[str, Any]) -> bool:
    """Process individual reservation request"""
    try:
        # Parse the reservation request
        reservation_request = json.loads(record['body'])

        logger.info(f"Processing reservation: {reservation_request}")

        # Validate request
        if not validate_reservation_request(reservation_request):
            logger.error(f"Invalid reservation request: {reservation_request}")
            # Let invalid messages go to DLQ by raising an exception
            raise ValueError(f"Invalid reservation request: {reservation_request}")

        # Check availability
        available_gpus = check_gpu_availability()
        requested_gpus = reservation_request.get('gpu_count', 1)

        if available_gpus >= requested_gpus:
            # Update status to show we're preparing the machine
            reservation_id = reservation_request.get('reservation_id')
            if reservation_id:
                update_reservation_status(reservation_id, 'preparing', 'Preparing GPU resources')
            
            # Create reservation
            reservation_id = create_reservation(reservation_request)
            logger.info(f"Created reservation: {reservation_id}")

            # Allocate resources (K8s pod creation would go here)
            allocate_gpu_resources(reservation_id, reservation_request)
            return True  # Successfully processed
        else:
            # Insufficient resources - update status and retry logic
            receive_count = int(record.get('attributes', {}).get('ApproximateReceiveCount', '1'))
            reservation_id = reservation_request.get('reservation_id')
            
            if receive_count == 1:
                # First attempt failed - update status to queued
                if reservation_id:
                    update_reservation_status(reservation_id, 'queued', 'No resources available, will retry')
                logger.info(f"Insufficient resources, attempt {receive_count}/3. Will retry.")
            elif receive_count == 2:
                # Second attempt - still queued
                logger.warning(f"Insufficient resources on attempt {receive_count}/3. Message will be re-added to queue for retry.")
            elif receive_count >= 3:
                logger.error(f"FINAL ATTEMPT: Insufficient resources after 3 attempts. SQS will move to DLQ.")
                # Update reservation status before SQS moves to DLQ
                if reservation_id:
                    update_reservation_status(reservation_id, 'failed', 
                                            f"Insufficient resources after 3 attempts")
            
            return False  # Don't delete - let SQS handle retry/DLQ

    except Exception as e:
        logger.error(f"Error processing reservation request: {str(e)}")
        
        # Try to update reservation status to failed before raising exception
        try:
            # Try to get reservation_id from the parsed request or record
            reservation_id = None
            try:
                reservation_request = json.loads(record['body'])
                reservation_id = reservation_request.get('reservation_id')
            except Exception:
                pass
                
            if reservation_id:
                update_reservation_status(reservation_id, 'failed', f"Processing error: {str(e)}")
        except Exception as status_error:
            logger.error(f"Failed to update reservation status: {str(status_error)}")
        
        # Let processing errors (like JSON parsing) go to DLQ
        raise


def validate_reservation_request(request: Dict[str, Any]) -> bool:
    """Validate reservation request parameters"""
    required_fields = ['user_id', 'gpu_count']

    for field in required_fields:
        if field not in request:
            logger.error(f"Missing required field: {field}")
            return False

    # Validate GPU count
    gpu_count = request.get('gpu_count', 1)
    if gpu_count not in [1, 2, 4, 8, 16]:  # 16 for 2x8 GPU setup
        logger.error(f"Invalid GPU count: {gpu_count}")
        return False

    # Validate duration
    duration_hours = request.get('duration_hours', DEFAULT_TIMEOUT_HOURS)
    if duration_hours > MAX_RESERVATION_HOURS:
        logger.error(f"Duration exceeds maximum: {duration_hours} > {MAX_RESERVATION_HOURS}")
        return False

    return True


def check_gpu_availability() -> int:
    """Check available GPU capacity"""
    try:
        # Query server status from DynamoDB
        servers_table = dynamodb.Table(SERVERS_TABLE)
        response = servers_table.scan(
            FilterExpression='#status = :status',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':status': 'available'}
        )

        total_available_gpus = 0
        for server in response['Items']:
            available_gpus = server.get('available_gpus', 0)
            total_available_gpus += available_gpus

        logger.info(f"Total available GPUs: {total_available_gpus}")
        return total_available_gpus

    except Exception as e:
        logger.error(f"Error checking GPU availability: {str(e)}")
        return 0


def create_reservation(request: Dict[str, Any]) -> str:
    """Create a new reservation record"""
    try:
        # Use the reservation_id from the CLI request if provided, otherwise generate new one
        reservation_id = request.get('reservation_id', str(uuid.uuid4()))
        now = datetime.utcnow()
        duration_hours = request.get('duration_hours', DEFAULT_TIMEOUT_HOURS)
        expires_at = now + timedelta(hours=duration_hours)

        reservation = {
            'reservation_id': reservation_id,
            'user_id': request['user_id'],
            'gpu_count': request['gpu_count'],
            'status': 'preparing',
            'created_at': request.get('created_at', now.isoformat()),
            'expires_at': int(expires_at.timestamp()),
            'duration_hours': duration_hours,
            'pod_name': f"gpu-dev-{reservation_id[:8]}",
            'namespace': 'gpu-dev',
            'ssh_command': f"ssh user@gpu-dev-{reservation_id[:8]}.cluster.local",  # Placeholder
        }

        # Add optional fields
        if 'name' in request:
            reservation['name'] = request['name']
        if 'instance_preference' in request:
            reservation['instance_preference'] = request['instance_preference']

        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        reservations_table.put_item(Item=reservation)

        logger.info(f"Created reservation record: {reservation_id}")
        return reservation_id

    except Exception as e:
        logger.error(f"Error creating reservation: {str(e)}")
        raise


def allocate_gpu_resources(reservation_id: str, request: Dict[str, Any]) -> None:
    """Allocate GPU resources via K8s pod creation"""
    try:
        gpu_count = request['gpu_count']
        user_id = request['user_id']
        pod_name = f"gpu-dev-{reservation_id[:8]}"
        
        logger.info(f"Allocating {gpu_count} GPUs for reservation {reservation_id}")
        logger.info(f"Pod name: {pod_name}")

        # Get user's GitHub public key
        github_user = request.get('github_user', user_id)  # Fallback to user_id for compatibility
        github_public_key = get_github_public_key(github_user)
        if not github_public_key:
            raise ValueError(f"Could not fetch GitHub public key for GitHub user '{github_user}'")

        # Create Kubernetes pod and service
        node_port = create_kubernetes_resources(
            pod_name=pod_name,
            gpu_count=gpu_count, 
            github_public_key=github_public_key,
            reservation_id=reservation_id
        )
        
        # Get node public IP
        node_public_ip = get_node_public_ip()
        
        # Generate SSH command
        ssh_command = f"ssh -p {node_port} dev@{node_public_ip}"
        
        # Update reservation with connection details
        update_reservation_connection_info(
            reservation_id=reservation_id,
            ssh_command=ssh_command,
            pod_name=pod_name,
            node_port=node_port,
            node_ip=node_public_ip
        )

        # Update server allocation in DynamoDB
        update_server_allocation(gpu_count, reservation_id)

        logger.info(f"Successfully created pod {pod_name} with SSH access on port {node_port}")

    except Exception as e:
        logger.error(f"Error allocating GPU resources: {str(e)}")
        # Update reservation status to failed
        update_reservation_status(reservation_id, 'failed', f"Resource allocation failed: {str(e)}")
        raise


def update_server_allocation(gpu_count: int, reservation_id: str) -> None:
    """Update server allocation status"""
    try:
        # For simplicity, we'll track total allocated GPUs
        # In production, this would be more sophisticated

        servers_table = dynamodb.Table(SERVERS_TABLE)

        # Find available servers and allocate GPUs
        response = servers_table.scan(
            FilterExpression='#status = :status',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':status': 'available'}
        )

        remaining_gpus = gpu_count

        for server in response['Items']:
            if remaining_gpus <= 0:
                break

            server_id = server['server_id']
            available_gpus = server.get('available_gpus', 8)  # Default 8 GPUs per p5.48xlarge

            if available_gpus > 0:
                allocated = min(remaining_gpus, available_gpus)
                new_available = available_gpus - allocated

                # Update server record
                servers_table.update_item(
                    Key={'server_id': server_id},
                    UpdateExpression='SET available_gpus = :new_available, allocated_gpus = allocated_gpus + :allocated',
                    ExpressionAttributeValues={
                        ':new_available': new_available,
                        ':allocated': allocated
                    }
                )

                remaining_gpus -= allocated
                logger.info(f"Allocated {allocated} GPUs on server {server_id}")

        if remaining_gpus > 0:
            logger.warning(f"Could not allocate {remaining_gpus} GPUs")

    except Exception as e:
        logger.error(f"Error updating server allocation: {str(e)}")
        raise


def delete_sqs_message(record: Dict[str, Any]) -> None:
    """Delete message from SQS queue after successful processing"""
    try:
        receipt_handle = record.get('receiptHandle')
        if receipt_handle:
            sqs_client.delete_message(
                QueueUrl=QUEUE_URL,
                ReceiptHandle=receipt_handle
            )
            logger.info(f"Deleted message from queue: {record.get('messageId')}")
        else:
            logger.warning("No receipt handle found for message deletion")
    except Exception as e:
        logger.error(f"Error deleting SQS message: {str(e)}")




def update_reservation_status(reservation_id: str, status: str, reason: str = None) -> None:
    """Update reservation status in DynamoDB"""
    try:
        if not reservation_id:
            return

        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        update_expression = 'SET #status = :status'
        expression_values = {':status': status}

        if reason:
            update_expression += ', failure_reason = :reason'
            expression_values[':reason'] = reason

        reservations_table.update_item(
            Key={'reservation_id': reservation_id},
            UpdateExpression=update_expression,
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues=expression_values
        )

        logger.info(f"Updated reservation {reservation_id} status to {status}")
    except Exception as e:
        logger.error(f"Error updating reservation status: {str(e)}")


def get_github_public_key(github_username: str) -> str:
    """Fetch GitHub public key for user"""
    try:
        import urllib.request
        url = f"https://github.com/{github_username}.keys"
        with urllib.request.urlopen(url) as response:
            keys = response.read().decode('utf-8').strip()
            if keys:
                # Return first SSH key (most users have one)
                return keys.split('\n')[0]
        return None
    except Exception as e:
        logger.error(f"Error fetching GitHub key for {github_username}: {str(e)}")
        return None


def create_kubernetes_resources(pod_name: str, gpu_count: int, github_public_key: str, reservation_id: str) -> int:
    """Create Kubernetes pod and NodePort service using Python client"""
    try:
        # Configure Kubernetes client
        k8s_client = setup_kubernetes_client()
        
        # Find available node port (30000-32767 range)
        node_port = find_available_node_port(k8s_client)
        
        # Create pod
        create_pod(k8s_client, pod_name, gpu_count, github_public_key)
        
        # Create service
        create_service(k8s_client, pod_name, node_port)
        
        # Wait for pod to be ready
        wait_for_pod_ready(k8s_client, pod_name)
        
        return node_port
        
    except Exception as e:
        logger.error(f"Error creating Kubernetes resources: {str(e)}")
        raise


def get_bearer_token():
    """Get EKS bearer token using AWS STS signing"""
    import base64
    import re
    import boto3
    from botocore.signers import RequestSigner
    
    STS_TOKEN_EXPIRES_IN = 60
    session = boto3.session.Session(region_name=REGION)

    sts_client = session.client('sts')
    service_id = sts_client.meta.service_model.service_id

    signer = RequestSigner(
        service_id,
        REGION,
        'sts',
        'v4',
        session.get_credentials(),
        session.events
    )

    params = {
        'method': 'GET',
        'url': f'https://sts.{REGION}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15',
        'body': {},
        'headers': {
            'x-k8s-aws-id': EKS_CLUSTER_NAME
        },
        'context': {}
    }

    signed_url = signer.generate_presigned_url(
        params,
        region_name=REGION,
        expires_in=STS_TOKEN_EXPIRES_IN,
        operation_name=''
    )

    base64_url = base64.urlsafe_b64encode(signed_url.encode('utf-8')).decode('utf-8')
    # Remove any base64 encoding padding
    return 'k8s-aws-v1.' + re.sub(r'=*', '', base64_url)


def setup_kubernetes_client():
    """Set up Kubernetes client for EKS cluster using AWS STS signing"""
    try:
        from kubernetes import client
        import boto3
        import base64
        
        # Get EKS cluster info
        eks = boto3.client('eks', region_name=REGION)
        cluster_info = eks.describe_cluster(name=EKS_CLUSTER_NAME)
        cluster = cluster_info['cluster']
        
        # Get cluster endpoint and certificate
        cluster_endpoint = cluster['endpoint']
        cert_authority = cluster['certificateAuthority']['data']
        
        # Write CA cert to temp file
        with open('/tmp/ca.crt', 'wb') as f:
            f.write(base64.b64decode(cert_authority))
        
        # Create configuration
        configuration = client.Configuration()
        configuration.api_key = {'authorization': get_bearer_token()}
        configuration.api_key_prefix = {'authorization': 'Bearer'}
        configuration.host = cluster_endpoint
        configuration.ssl_ca_cert = '/tmp/ca.crt'
        
        return client.ApiClient(configuration)
        
    except Exception as e:
        logger.error(f"Failed to configure Kubernetes client: {str(e)}")
        raise


def find_available_node_port(k8s_client) -> int:
    """Find an available NodePort in the valid range"""
    try:
        from kubernetes import client
        import random
        
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
                        mkdir -p /home/dev/.ssh
                        echo '{github_public_key}' > /home/dev/.ssh/authorized_keys
                        chmod 700 /home/dev/.ssh
                        chmod 600 /home/dev/.ssh/authorized_keys
                        chown -R 1000:1000 /home/dev/.ssh
                        """
                    ],
                    volume_mounts=[
                        client.V1VolumeMount(name="dev-home", mount_path="/home/dev")
                    ]
                )
            ],
            containers=[
                client.V1Container(
                    name="gpu-dev",
                    image="pytorch/pytorch:2.1.0-cuda12.1-devel-ubuntu20.04",
                    command=["/bin/bash"],
                    args=[
                        "-c",
                        """
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
                        """
                    ],
                    ports=[client.V1ContainerPort(container_port=22)],
                    resources=client.V1ResourceRequirements(
                        limits={"nvidia.com/gpu": str(gpu_count)},
                        requests={"nvidia.com/gpu": str(gpu_count)}
                    ),
                    volume_mounts=[
                        client.V1VolumeMount(name="dev-home", mount_path="/home/dev"),
                        client.V1VolumeMount(name="shared-workspace", mount_path="/workspace")
                    ]
                )
            ],
            volumes=[
                client.V1Volume(name="dev-home", empty_dir=client.V1EmptyDirVolumeSource()),
                client.V1Volume(
                    name="shared-workspace", 
                    empty_dir=client.V1EmptyDirVolumeSource(size_limit="100Gi")
                )
            ],
            tolerations=[
                client.V1Toleration(
                    key="nvidia.com/gpu",
                    operator="Exists",
                    effect="NoSchedule"
                )
            ]
        )
        
        # Create pod metadata
        pod_metadata = client.V1ObjectMeta(
            name=pod_name,
            namespace="gpu-dev",
            labels={"app": "gpu-dev-pod", "reservation": pod_name}
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
                    port=22,
                    target_port=22,
                    node_port=node_port,
                    protocol="TCP"
                )
            ],
            selector={"reservation": pod_name}
        )
        
        # Create service metadata
        service_metadata = client.V1ObjectMeta(
            name=f"{pod_name}-ssh",
            namespace="gpu-dev"
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
    image: pytorch/pytorch:2.1.0-cuda12.1-devel-ubuntu20.04
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
        with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
            f.write(yaml_content)
            f.flush()
            
            cmd = ['kubectl', 'apply', '-f', f.name]
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
        from kubernetes import client
        import time
        
        v1 = client.CoreV1Api(k8s_client)
        
        start_time = time.time()
        while time.time() - start_time < timeout_seconds:
            try:
                pod = v1.read_namespaced_pod(name=pod_name, namespace="gpu-dev")
                
                # Check if pod is ready
                if pod.status.conditions:
                    for condition in pod.status.conditions:
                        if condition.type == 'Ready' and condition.status == 'True':
                            logger.info(f"Pod {pod_name} is ready")
                            return
                            
            except Exception as e:
                logger.warning(f"Error checking pod status: {str(e)}")
                
            time.sleep(10)
            
        raise TimeoutError(f"Pod {pod_name} did not become ready within {timeout_seconds} seconds")
        
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
                    if addr.type == 'ExternalIP':
                        return addr.address
                        
        # Fallback: try to get from instance metadata
        instance_id = get_node_instance_id()
        if instance_id:
            response = ec2_client.describe_instances(InstanceIds=[instance_id])
            instance = response['Reservations'][0]['Instances'][0]
            return instance.get('PublicIpAddress', '')
            
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
                if 'aws:///' in provider_id:
                    # Extract instance ID from providerID like "aws:///us-east-2a/i-1234567890abcdef0"
                    return provider_id.split('/')[-1]
                
        return None
        
    except Exception as e:
        logger.error(f"Error getting node instance ID: {str(e)}")
        return None


def update_reservation_connection_info(reservation_id: str, ssh_command: str, pod_name: str, node_port: int, node_ip: str):
    """Update reservation with connection details"""
    try:
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        reservations_table.update_item(
            Key={'reservation_id': reservation_id},
            UpdateExpression="""
                SET ssh_command = :ssh_command,
                    pod_name = :pod_name,
                    node_port = :node_port,
                    node_ip = :node_ip,
                    #status = :status
            """,
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={
                ':ssh_command': ssh_command,
                ':pod_name': pod_name,
                ':node_port': node_port,
                ':node_ip': node_ip,
                ':status': 'active'
            }
        )
        logger.info(f"Updated reservation {reservation_id} with connection info")
        
    except Exception as e:
        logger.error(f"Error updating reservation connection info: {str(e)}")
        raise
