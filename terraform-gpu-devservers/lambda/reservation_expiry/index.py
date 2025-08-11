"""
Reservation Expiry Management Lambda
Handles warning users about expiring reservations and cleaning up expired ones
Also cleans up stale queued/pending reservations
"""

import json
import os
import boto3
import logging
import time
from datetime import datetime, timedelta
from typing import Dict, Any, List

# Setup logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# AWS clients
dynamodb = boto3.resource('dynamodb')
sns_client = boto3.client('sns')

# Environment variables
RESERVATIONS_TABLE = os.environ['RESERVATIONS_TABLE']
SERVERS_TABLE = os.environ['SERVERS_TABLE']
EKS_CLUSTER_NAME = os.environ['EKS_CLUSTER_NAME']
REGION = os.environ['REGION']
WARNING_MINUTES = int(os.environ.get('WARNING_MINUTES', 30))
GRACE_PERIOD_SECONDS = int(os.environ.get('GRACE_PERIOD_SECONDS', 120))


def handler(event, context):
    """Main Lambda handler"""
    try:
        current_time = int(time.time())
        logger.info(f"Running reservation expiry and cleanup check at timestamp {current_time} ({datetime.fromtimestamp(current_time)})")

        # Get all active reservations
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        try:
            response = reservations_table.query(
                IndexName='StatusIndex',
                KeyConditionExpression='#status = :status',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={':status': 'active'}
            )
            active_reservations = response.get('Items', [])
            logger.info(f"Found {len(active_reservations)} active reservations")
            
            # Log details of each active reservation
            for res in active_reservations:
                expires_at = int(res.get('expires_at', 0))
                logger.info(f"Active reservation {res['reservation_id'][:8]}: expires_at={expires_at} ({datetime.fromtimestamp(expires_at)}), pod={res.get('pod_name', 'unknown')}")
                
        except Exception as e:
            logger.error(f"Error querying active reservations: {e}")
            active_reservations = []

        # Also check for stale queued/pending reservations
        stale_statuses = ['queued', 'pending']
        stale_reservations = []
        for status in stale_statuses:
            response = reservations_table.query(
                IndexName='StatusIndex',
                KeyConditionExpression='#status = :status',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={':status': status}
            )
            stale_reservations.extend(response.get('Items', []))

        logger.info(f"Found {len(stale_reservations)} queued/pending reservations")

        warning_threshold = current_time + (WARNING_MINUTES * 60)
        stale_threshold = current_time - (5 * 60)  # 5 minutes ago
        
        logger.info(f"Expiry thresholds: current={current_time}, warning={warning_threshold}, stale={stale_threshold}")

        warned_count = 0
        expired_count = 0
        stale_cancelled_count = 0

        # Process active reservations for expiry
        for reservation in active_reservations:
            expires_at = int(reservation.get('expires_at', 0))
            reservation_id = reservation['reservation_id']
            user_id = reservation['user_id']

            # Check if reservation has already expired (with grace period)
            expiry_with_grace = expires_at + GRACE_PERIOD_SECONDS
            if expiry_with_grace < current_time:
                logger.info(f"Expiring reservation {reservation_id} (expired at {expires_at}, grace until {expiry_with_grace}, current {current_time})")
                try:
                    expire_reservation(reservation)
                    expired_count += 1
                    logger.info(f"Successfully expired reservation {reservation_id}")
                except Exception as e:
                    logger.error(f"Failed to expire reservation {reservation_id}: {e}")

            # Check if reservation is within warning window and hasn't been warned yet
            elif expires_at < warning_threshold and not reservation.get('warning_sent'):
                logger.info(f"Warning user about expiring reservation {reservation_id} (expires {expires_at}, warning threshold {warning_threshold})")
                try:
                    warn_user_expiring(reservation)
                    warned_count += 1
                    logger.info(f"Successfully warned about reservation {reservation_id}")
                except Exception as e:
                    logger.error(f"Failed to warn about reservation {reservation_id}: {e}")

        # Process stale queued/pending reservations
        for reservation in stale_reservations:
            created_at = reservation.get('created_at', '')
            reservation_id = reservation['reservation_id']

            # Parse created_at timestamp
            try:
                if isinstance(created_at, str):
                    # ISO format string
                    created_timestamp = int(datetime.fromisoformat(created_at.replace('Z', '+00:00')).timestamp())
                else:
                    created_timestamp = int(created_at)
            except:
                logger.warning(f"Could not parse created_at for reservation {reservation_id}")
                continue

            # Cancel if stale (>5 minutes in queued/pending state)
            if created_timestamp < stale_threshold:
                logger.info(f"Cancelling stale {reservation['status']} reservation {reservation_id}")
                cancel_stale_reservation(reservation)
                stale_cancelled_count += 1

        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': f'Processed {len(active_reservations)} active and {len(stale_reservations)} queued reservations',
                'warned': warned_count,
                'expired': expired_count,
                'stale_cancelled': stale_cancelled_count
            })
        }

    except Exception as e:
        logger.error(f"Error in expiry check: {str(e)}")
        raise


def warn_user_expiring(reservation: Dict[str, Any]) -> None:
    """Warn user about expiring reservation"""
    try:
        reservation_id = reservation['reservation_id']
        user_id = reservation['user_id']
        expires_at = int(reservation.get('expires_at', 0))
        pod_name = reservation.get('pod_name')

        # Calculate time until expiry
        current_time = int(time.time())
        minutes_left = (expires_at - current_time) // 60

        # Send warning to the pod
        warning_message = create_warning_message(reservation, minutes_left)

        if pod_name:
            # Send wall message to pod
            send_wall_message_to_pod(pod_name, warning_message)

            # Also create a visible file in the workspace
            create_warning_file_in_pod(pod_name, warning_message, minutes_left)

        # Update reservation to mark warning as sent
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        reservations_table.update_item(
            Key={'reservation_id': reservation_id},
            UpdateExpression='SET warning_sent = :warning_sent, warning_time = :warning_time',
            ExpressionAttributeValues={
                ':warning_sent': True,
                ':warning_time': current_time
            }
        )

        logger.info(f"Warning sent for reservation {reservation_id}")

    except Exception as e:
        logger.error(f"Error warning user for reservation {reservation.get('reservation_id')}: {str(e)}")


def expire_reservation(reservation: Dict[str, Any]) -> None:
    """Expire a reservation and clean up resources"""
    try:
        reservation_id = reservation['reservation_id']
        user_id = reservation['user_id']
        gpu_count = int(reservation.get('gpu_count', 1))

        logger.info(f"Expiring reservation {reservation_id} for user {user_id}")

        # 1. Update reservation status to expired
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        reservations_table.update_item(
            Key={'reservation_id': reservation_id},
            UpdateExpression='SET #status = :status, expired_at = :expired_at',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={
                ':status': 'expired',
                ':expired_at': int(time.time())
            }
        )

        # 2. Clean up K8s pod (would use kubectl or K8s API)
        pod_name = reservation.get('pod_name')
        if pod_name:
            cleanup_pod(pod_name, reservation.get('namespace', 'gpu-dev'))

        # 3. Release GPU resources back to servers
        release_gpu_resources(gpu_count, reservation_id)

        logger.info(f"Successfully expired reservation {reservation_id}")

    except Exception as e:
        logger.error(f"Error expiring reservation {reservation.get('reservation_id')}: {str(e)}")
        raise


def cancel_stale_reservation(reservation: Dict[str, Any]) -> None:
    """Cancel a stale queued/pending reservation"""
    try:
        reservation_id = reservation['reservation_id']
        user_id = reservation.get('user_id', 'unknown')

        logger.info(f"Cancelling stale reservation {reservation_id} for user {user_id}")

        # Update reservation status to cancelled
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        reservations_table.update_item(
            Key={'reservation_id': reservation_id},
            UpdateExpression='SET #status = :status, cancelled_at = :cancelled_at, failure_reason = :reason',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={
                ':status': 'cancelled',
                ':cancelled_at': int(time.time()),
                ':reason': 'Stale reservation - exceeded 5 minute queue time'
            }
        )

        logger.info(f"Successfully cancelled stale reservation {reservation_id}")

    except Exception as e:
        logger.error(f"Error cancelling stale reservation {reservation.get('reservation_id')}: {str(e)}")


def create_warning_message(reservation: Dict[str, Any], minutes_left: int) -> str:
    """Create warning message for user"""
    reservation_id = reservation['reservation_id']
    user_id = reservation['user_id']

    if minutes_left <= 0:
        return f"🚨 URGENT: Reservation {reservation_id[:8]} expires in less than 1 minute! Save your work now!"
    elif minutes_left <= 5:
        return f"⚠️  WARNING: Reservation {reservation_id[:8]} expires in {minutes_left} minutes! Save your work!"
    elif minutes_left <= 15:
        return f"📢 NOTICE: Reservation {reservation_id[:8]} expires in {minutes_left} minutes. Please save your work."
    else:
        return f"📝 INFO: Reservation {reservation_id[:8]} expires in {minutes_left} minutes."


def cleanup_pod(pod_name: str, namespace: str = 'gpu-dev') -> None:
    """Clean up Kubernetes pod and associated resources"""
    try:
        from kubernetes import client
        logger.info(f"Cleaning up pod {pod_name} in namespace {namespace}")

        # Configure Kubernetes client
        k8s_client = setup_kubernetes_client()
        v1 = client.CoreV1Api(k8s_client)

        # Send final warning message before deletion
        try:
            send_wall_message_to_pod(
                pod_name, "🚨 FINAL WARNING: Reservation expired! Pod will be deleted in 2 minutes. Save your work NOW!", namespace)
            time.sleep(120)  # Give user 2 minutes to save work
        except Exception as warn_error:
            logger.warning(f"Could not send final warning: {warn_error}")

        # Delete the NodePort service first
        service_name = f"{pod_name}-ssh"
        try:
            v1.delete_namespaced_service(
                name=service_name,
                namespace=namespace,
                grace_period_seconds=0
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
                name=pod_name,
                namespace=namespace,
                grace_period_seconds=30
            )
            logger.info(f"Deleted pod {pod_name}")
        except client.exceptions.ApiException as e:
            if e.status == 404:
                logger.info(f"Pod {pod_name} not found (already deleted)")
            else:
                logger.error(f"Failed to delete pod {pod_name}: {e}")

                # Force delete if graceful deletion failed
                try:
                    v1.delete_namespaced_pod(
                        name=pod_name,
                        namespace=namespace,
                        grace_period_seconds=0
                    )
                    logger.info(f"Force deleted pod {pod_name}")
                except client.exceptions.ApiException as force_error:
                    logger.error(f"Failed to force delete pod {pod_name}: {force_error}")
                    raise

    except Exception as e:
        logger.error(f"Error cleaning up pod {pod_name}: {str(e)}")
        raise


def release_gpu_resources(gpu_count: int, reservation_id: str) -> None:
    """Release GPU resources back to the servers table"""
    try:
        servers_table = dynamodb.Table(SERVERS_TABLE)

        # Find servers that had GPUs allocated to this reservation
        # This would typically be tracked in the server allocation logic
        response = servers_table.scan(
            FilterExpression='allocated_gpus > :zero',
            ExpressionAttributeValues={':zero': 0}
        )

        servers_with_allocations = response.get('Items', [])
        remaining_gpus_to_release = gpu_count

        for server in servers_with_allocations:
            if remaining_gpus_to_release <= 0:
                break

            server_id = server['server_id']
            allocated_gpus = int(server.get('allocated_gpus', 0))
            available_gpus = int(server.get('available_gpus', 0))

            # Release GPUs (this is simplified - in reality we'd track which reservation owns which GPUs)
            gpus_to_release = min(remaining_gpus_to_release, allocated_gpus)

            new_allocated = allocated_gpus - gpus_to_release
            new_available = available_gpus + gpus_to_release

            servers_table.update_item(
                Key={'server_id': server_id},
                UpdateExpression='SET allocated_gpus = :new_allocated, available_gpus = :new_available',
                ExpressionAttributeValues={
                    ':new_allocated': new_allocated,
                    ':new_available': new_available
                }
            )

            remaining_gpus_to_release -= gpus_to_release
            logger.info(f"Released {gpus_to_release} GPUs on server {server_id}")

        if remaining_gpus_to_release > 0:
            logger.warning(f"Could not release {remaining_gpus_to_release} GPUs - may be a tracking issue")

    except Exception as e:
        logger.error(f"Error releasing GPU resources: {str(e)}")
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


def send_wall_message_to_pod(pod_name: str, message: str, namespace: str = 'gpu-dev'):
    """Send wall message to all logged-in users in the pod"""
    try:
        from kubernetes import client, stream

        # Configure Kubernetes client
        k8s_client = setup_kubernetes_client()
        v1 = client.CoreV1Api(k8s_client)

        # Execute wall command in the pod
        wall_cmd = f'echo "{message}" | wall'
        exec_command = ['bash', '-c', wall_cmd]

        try:
            resp = stream.stream(
                v1.connect_get_namespaced_pod_exec,
                pod_name,
                namespace,
                command=exec_command,
                container='gpu-dev',
                stderr=True,
                stdin=False,
                stdout=True,
                tty=False,
                _request_timeout=30
            )
            logger.info(f"Wall message sent to pod {pod_name}")
        except Exception as e:
            logger.warning(f"Failed to send wall message to pod {pod_name}: {e}")

    except Exception as e:
        logger.warning(f"Error sending wall message to pod {pod_name}: {str(e)}")


def create_warning_file_in_pod(pod_name: str, warning_message: str, minutes_left: int, namespace: str = 'gpu-dev'):
    """Create a visible warning file in the pod's workspace"""
    try:
        from kubernetes import client, stream

        # Configure Kubernetes client
        k8s_client = setup_kubernetes_client()
        v1 = client.CoreV1Api(k8s_client)

        # Create warning file content
        warning_content = f"""
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  GPU RESERVATION EXPIRY WARNING ⚠️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{warning_message}

Time remaining: {minutes_left} minutes

IMPORTANT: 
- Save your work immediately
- Your reservation will expire and this pod will be deleted
- All unsaved data will be lost

To extend your reservation, use the CLI:
  gpu-dev extend <reservation-id>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Generated at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S UTC')}
"""

        # Write file to workspace using Kubernetes exec
        file_cmd = f'echo "{warning_content}" > /workspace/⚠️_RESERVATION_EXPIRY_WARNING.txt'
        exec_command = ['bash', '-c', file_cmd]

        try:
            resp = stream.stream(
                v1.connect_get_namespaced_pod_exec,
                pod_name,
                namespace,
                command=exec_command,
                container='gpu-dev',
                stderr=True,
                stdin=False,
                stdout=True,
                tty=False,
                _request_timeout=30
            )
            logger.info(f"Warning file created in pod {pod_name}")
        except Exception as e:
            logger.warning(f"Failed to create warning file in pod {pod_name}: {e}")

    except Exception as e:
        logger.warning(f"Error creating warning file in pod {pod_name}: {str(e)}")
