"""
Reservation Expiry Management Lambda
Handles warning users about expiring reservations and cleaning up expired ones
Also cleans up stale queued/pending reservations
"""

import json
import logging
import os
import time
from datetime import datetime
from typing import Any

import boto3
from kubernetes import client, stream

from shared import setup_kubernetes_client
from shared.snapshot_utils import (
    create_pod_shutdown_snapshot,
    cleanup_old_snapshots,
    safe_create_snapshot,
    cleanup_all_user_snapshots
)

# Setup logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# AWS clients
dynamodb = boto3.resource("dynamodb")
sns_client = boto3.client("sns")
ec2_client = boto3.client("ec2")

# Environment variables
RESERVATIONS_TABLE = os.environ["RESERVATIONS_TABLE"]
EKS_CLUSTER_NAME = os.environ["EKS_CLUSTER_NAME"]
REGION = os.environ["REGION"]

# Global Kubernetes client (reused across Lambda execution)
_k8s_client = None


def get_k8s_client():
    """Get or create the global Kubernetes client (singleton pattern)"""
    global _k8s_client
    if _k8s_client is None:
        logger.info("Initializing global Kubernetes client...")
        _k8s_client = setup_kubernetes_client()
        logger.info("Global Kubernetes client initialized successfully")
    return _k8s_client


def trigger_availability_update():
    """Trigger the availability updater Lambda function"""
    try:
        import boto3

        # Get the availability updater function name from environment variable
        availability_function_name = os.environ.get(
            "AVAILABILITY_UPDATER_FUNCTION_NAME"
        )
        if not availability_function_name:
            logger.warning(
                "AVAILABILITY_UPDATER_FUNCTION_NAME not set, skipping availability update"
            )
            return

        # Create Lambda client and invoke the availability updater
        lambda_client = boto3.client("lambda")

        # Invoke asynchronously to avoid blocking the expiry process
        response = lambda_client.invoke(
            FunctionName=availability_function_name,
            InvocationType="Event",  # Async invocation
            Payload="{}",  # Empty payload, the function will scan all GPU types
        )

        logger.info(
            f"Successfully triggered availability updater function: {availability_function_name}"
        )

    except Exception as e:
        logger.error(f"Failed to trigger availability update: {str(e)}")
        # Don't raise, just log the error as this is not critical


WARNING_MINUTES = int(os.environ.get("WARNING_MINUTES", 30))
GRACE_PERIOD_SECONDS = int(os.environ.get("GRACE_PERIOD_SECONDS", 120))

# Warning levels in minutes (can be easily extended)
WARNING_LEVELS = [30, 15, 5]




def handler(event, context):
    """Main Lambda handler"""
    try:
        current_time = int(time.time())
        logger.info(
            f"Running reservation expiry and cleanup check at timestamp {current_time} ({datetime.fromtimestamp(current_time)})"
        )

        # Check if this is a scheduled snapshot cleanup run
        if event.get("source") == "cloudwatch.schedule" and event.get("cleanup_type") == "snapshots":
            logger.info("Running scheduled snapshot cleanup for all users")
            deleted_count = cleanup_all_user_snapshots()
            return {
                "statusCode": 200,
                "body": json.dumps({
                    "message": f"Snapshot cleanup completed - deleted {deleted_count} old snapshots"
                }),
            }

        # Get all active, preparing, and failed reservations
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        try:
            # Get active reservations
            active_response = reservations_table.query(
                IndexName="StatusIndex",
                KeyConditionExpression="#status = :status",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={":status": "active"},
            )
            active_reservations = active_response.get("Items", [])

            # Get preparing reservations
            preparing_response = reservations_table.query(
                IndexName="StatusIndex",
                KeyConditionExpression="#status = :status",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={":status": "preparing"},
            )
            preparing_reservations = preparing_response.get("Items", [])

            logger.info(
                f"Found {len(active_reservations)} active reservations and {len(preparing_reservations)} preparing reservations"
            )

            # Log details of each active reservation
            for res in active_reservations:
                expires_at_str = res.get("expires_at", "")
                try:
                    expires_at = int(
                        datetime.fromisoformat(
                            expires_at_str.replace("Z", "+00:00")
                        ).timestamp()
                    )
                except (ValueError, AttributeError):
                    expires_at = 0
                logger.info(
                    f"Active reservation {res['reservation_id'][:8]}: expires_at={expires_at_str}, pod={res.get('pod_name', 'unknown')}"
                )

        except Exception as e:
            logger.error(f"Error querying active reservations: {e}")
            active_reservations = []
            preparing_reservations = []

        # Process preparing reservations for stuck cleanup (>1 hour)
        PREPARING_TIMEOUT_SECONDS = 3600  # 1 hour
        preparing_timeout_threshold = current_time - PREPARING_TIMEOUT_SECONDS

        # Initialize counters
        warned_count = 0
        expired_count = 0
        stale_cancelled_count = 0

        for reservation in preparing_reservations:
            reservation_id = reservation["reservation_id"]
            created_at = reservation.get("created_at", "")

            try:
                if isinstance(created_at, str):
                    # ISO format string
                    created_timestamp = int(
                        datetime.fromisoformat(
                            created_at.replace("Z", "+00:00")
                        ).timestamp()
                    )
                else:
                    created_timestamp = int(created_at)
            except Exception as e:
                logger.warning(
                    f"Could not parse created_at for preparing reservation {reservation_id}: {e}"
                )
                continue

            # Check if preparing reservation is stuck (>1 hour)
            if created_timestamp < preparing_timeout_threshold:
                logger.info(
                    f"Expiring stuck preparing reservation {reservation_id} (created {created_timestamp}, timeout threshold {preparing_timeout_threshold})"
                )
                try:
                    expire_stuck_preparing_reservation(reservation)
                    expired_count += 1
                    logger.info(
                        f"Successfully expired stuck preparing reservation {reservation_id}"
                    )
                except Exception as e:
                    logger.error(
                        f"Failed to expire stuck preparing reservation {reservation_id}: {e}"
                    )

        # Clean up failed reservations that might have orphaned pods
        try:
            failed_response = reservations_table.query(
                IndexName="StatusIndex",
                KeyConditionExpression="#status = :status",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={":status": "failed"},
            )
            failed_reservations = failed_response.get("Items", [])
            logger.info(f"Found {len(failed_reservations)} failed reservations")

            # Clean up failed reservations that have pods (created in the last 24 hours to avoid processing old ones)
            FAILED_CLEANUP_WINDOW = 24 * 3600  # 24 hours
            failed_cleanup_threshold = current_time - FAILED_CLEANUP_WINDOW

            for reservation in failed_reservations:
                reservation_id = reservation["reservation_id"]
                pod_name = reservation.get("pod_name")

                if not pod_name:
                    continue  # No pod to clean up

                # Check if failed recently (within cleanup window)
                failed_at = reservation.get(
                    "failed_at", reservation.get("created_at", "")
                )
                try:
                    if isinstance(failed_at, str):
                        failed_timestamp = int(
                            datetime.fromisoformat(
                                failed_at.replace("Z", "+00:00")
                            ).timestamp()
                        )
                    else:
                        failed_timestamp = int(failed_at)

                    if failed_timestamp < failed_cleanup_threshold:
                        continue  # Too old, skip cleanup

                except (ValueError, AttributeError):
                    continue  # Can't parse timestamp, skip

                logger.info(
                    f"Cleaning up failed reservation {reservation_id[:8]} with pod {pod_name}"
                )
                try:
                    cleanup_pod(pod_name, reservation_data=reservation)
                    logger.info(
                        f"Successfully cleaned up failed reservation {reservation_id[:8]}"
                    )
                except Exception as e:
                    logger.error(
                        f"Failed to cleanup failed reservation {reservation_id[:8]}: {e}"
                    )

        except Exception as e:
            logger.error(f"Error processing failed reservations: {e}")

        # Clean up expired and cancelled reservations that still have running pods
        try:
            expired_statuses = ["expired", "cancelled"]
            expired_cancelled_reservations = []
            
            for status in expired_statuses:
                response = reservations_table.query(
                    IndexName="StatusIndex", 
                    KeyConditionExpression="#status = :status",
                    ExpressionAttributeNames={"#status": "status"},
                    ExpressionAttributeValues={":status": status},
                )
                expired_cancelled_reservations.extend(response.get("Items", []))
            
            logger.info(f"Found {len(expired_cancelled_reservations)} expired/cancelled reservations")
            
            # Clean up pods from expired/cancelled reservations (within last 7 days to avoid processing very old ones)
            EXPIRED_CLEANUP_WINDOW = 7 * 24 * 3600  # 7 days
            expired_cleanup_threshold = current_time - EXPIRED_CLEANUP_WINDOW
            
            for reservation in expired_cancelled_reservations:
                reservation_id = reservation["reservation_id"]
                pod_name = reservation.get("pod_name")
                
                if not pod_name:
                    continue  # No pod to clean up
                
                # Check if expired/cancelled recently (within cleanup window)
                expired_at = reservation.get("expired_at", reservation.get("cancelled_at", ""))
                if not expired_at:
                    continue  # No expiry/cancel timestamp
                
                try:
                    if isinstance(expired_at, str):
                        expired_timestamp = int(
                            datetime.fromisoformat(
                                expired_at.replace("Z", "+00:00")
                            ).timestamp()
                        )
                    else:
                        expired_timestamp = int(expired_at)
                        
                    if expired_timestamp < expired_cleanup_threshold:
                        continue  # Too old, skip cleanup
                        
                except (ValueError, AttributeError):
                    continue  # Can't parse timestamp, skip
                
                logger.info(
                    f"Cleaning up {reservation.get('status', 'unknown')} reservation {reservation_id[:8]} with pod {pod_name}"
                )
                try:
                    cleanup_pod(pod_name, reservation_data=reservation)
                    logger.info(
                        f"Successfully cleaned up {reservation.get('status', 'unknown')} reservation {reservation_id[:8]}"
                    )
                except Exception as e:
                    logger.error(
                        f"Failed to cleanup {reservation.get('status', 'unknown')} reservation {reservation_id[:8]}: {e}"
                    )
        
        except Exception as e:
            logger.error(f"Error processing expired/cancelled reservations: {e}")

        # Also check for stale queued/pending reservations
        stale_statuses = ["queued", "pending"]
        stale_reservations = []
        for status in stale_statuses:
            response = reservations_table.query(
                IndexName="StatusIndex",
                KeyConditionExpression="#status = :status",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={":status": status},
            )
            stale_reservations.extend(response.get("Items", []))

        logger.info(f"Found {len(stale_reservations)} queued/pending reservations")

        warning_threshold = current_time + (WARNING_MINUTES * 60)
        stale_threshold = current_time - (
            48 * 60 * 60
        )  # 48 hours ago (only cancel queued after 48+ hours)

        logger.info(
            f"Expiry thresholds: current={current_time}, warning={warning_threshold}, stale={stale_threshold}"
        )

        # Process active reservations for expiry
        for reservation in active_reservations:
            expires_at_str = reservation.get("expires_at", "")
            try:
                expires_at = int(
                    datetime.fromisoformat(
                        expires_at_str.replace("Z", "+00:00")
                    ).timestamp()
                )
            except (ValueError, AttributeError):
                expires_at = 0
            reservation_id = reservation["reservation_id"]

            # Check if reservation has already expired (with grace period)
            expiry_with_grace = expires_at + GRACE_PERIOD_SECONDS
            logger.info(
                f"Checking expiry for {reservation_id[:8]}: expires_at={expires_at}, grace_until={expiry_with_grace}, current={current_time}, should_expire={expiry_with_grace < current_time}"
            )
            if expiry_with_grace < current_time:
                logger.info(
                    f"Expiring reservation {reservation_id} (expired at {expires_at}, grace until {expiry_with_grace}, current {current_time})"
                )
                try:
                    expire_reservation(reservation)
                    expired_count += 1
                    logger.info(f"Successfully expired reservation {reservation_id}")
                except Exception as e:
                    logger.error(f"Failed to expire reservation {reservation_id}: {e}")

            # Check for multiple warning levels
            else:
                # First check if the pod still exists - if not, mark as expired
                # But add a grace period for newly launched reservations (10 minutes)
                pod_name = reservation.get("pod_name")
                if pod_name:
                    # Check if reservation was launched recently (within 10 minutes)
                    launched_at = reservation.get("launched_at", "")
                    grace_period_minutes = 10
                    skip_pod_check = False

                    if launched_at:
                        try:
                            launched_timestamp = int(
                                datetime.fromisoformat(
                                    launched_at.replace("Z", "+00:00")
                                ).timestamp()
                            )
                            grace_period_end = launched_timestamp + (
                                grace_period_minutes * 60
                            )
                            if current_time < grace_period_end:
                                skip_pod_check = True
                                logger.info(
                                    f"Skipping pod existence check for reservation {reservation_id[:8]} - within {grace_period_minutes}min grace period"
                                )
                        except (ValueError, AttributeError) as e:
                            logger.warning(
                                f"Could not parse launched_at for reservation {reservation_id}: {e}"
                            )

                    if not skip_pod_check and not check_pod_exists(pod_name):
                        logger.warning(
                            f"Pod {pod_name} for active reservation {reservation_id} no longer exists - marking as expired"
                        )
                        try:
                            expire_reservation_due_to_missing_pod(reservation)
                            expired_count += 1
                            continue  # Skip warning processing for this reservation
                        except Exception as e:
                            logger.error(
                                f"Failed to expire reservation {reservation_id} due to missing pod: {e}"
                            )

                minutes_until_expiry = (expires_at - current_time) // 60
                warnings_sent = reservation.get("warnings_sent", {})

                # Find the most appropriate warning to send (only send one at a time)
                warning_to_send = None
                for warning_minutes in sorted(
                    WARNING_LEVELS, reverse=True
                ):  # Start with highest (30, 15, 5)
                    warning_key = f"{warning_minutes}min_warning_sent"

                    if (
                        minutes_until_expiry <= warning_minutes
                        and not warnings_sent.get(warning_key, False)
                    ):
                        warning_to_send = warning_minutes
                        break  # Only send the most urgent unsent warning

                # Send the selected warning
                if warning_to_send:
                    logger.info(
                        f"Sending {warning_to_send}-minute warning for reservation {reservation_id}"
                    )
                    try:
                        warn_user_expiring(reservation, warning_to_send)
                        warned_count += 1
                        logger.info(
                            f"Successfully sent {warning_to_send}-minute warning for reservation {reservation_id}"
                        )
                    except Exception as e:
                        logger.error(
                            f"Failed to send {warning_to_send}-minute warning for reservation {reservation_id}: {e}"
                        )

        # Process stale queued/pending reservations
        for reservation in stale_reservations:
            created_at = reservation.get("created_at", "")
            reservation_id = reservation["reservation_id"]

            # Parse created_at timestamp
            try:
                if isinstance(created_at, str):
                    # ISO format string
                    created_timestamp = int(
                        datetime.fromisoformat(
                            created_at.replace("Z", "+00:00")
                        ).timestamp()
                    )
                else:
                    created_timestamp = int(created_at)
            except Exception as e:
                logger.warning(
                    f"Could not parse created_at for reservation {reservation_id}: {e}"
                )
                continue

            # Cancel if stale (>5 minutes in queued/pending state)
            if created_timestamp < stale_threshold:
                logger.info(
                    f"Cancelling stale {reservation['status']} reservation {reservation_id}"
                )
                cancel_stale_reservation(reservation)
                stale_cancelled_count += 1

        return {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "message": f"Processed {len(active_reservations)} active and {len(stale_reservations)} queued reservations",
                    "warned": warned_count,
                    "expired": expired_count,
                    "stale_cancelled": stale_cancelled_count,
                }
            ),
        }

    except Exception as e:
        logger.error(f"Error in expiry check: {str(e)}")
        raise


def check_pod_exists(pod_name: str, namespace: str = "gpu-dev") -> bool:
    """Check if a pod exists in the cluster"""
    try:
        k8s_client = get_k8s_client()
        v1 = client.CoreV1Api(k8s_client)

        v1.read_namespaced_pod(name=pod_name, namespace=namespace)
        return True
    except client.exceptions.ApiException as e:
        if e.status == 404:
            return False
        else:
            logger.warning(f"Error checking pod {pod_name}: {e}")
            return False
    except Exception as e:
        logger.warning(f"Error checking pod {pod_name}: {e}")
        return False


def warn_user_expiring(reservation: dict[str, Any], warning_minutes: int) -> None:
    """Warn user about expiring reservation at specific warning level"""
    try:
        reservation_id = reservation["reservation_id"]
        expires_at_str = reservation.get("expires_at", "")
        try:
            expires_at = int(
                datetime.fromisoformat(
                    expires_at_str.replace("Z", "+00:00")
                ).timestamp()
            )
        except (ValueError, AttributeError):
            expires_at = 0
        pod_name = reservation.get("pod_name")

        # Calculate time until expiry
        current_time = int(time.time())
        minutes_left = (expires_at - current_time) // 60

        # Send warning to the pod
        warning_message = create_warning_message(reservation, minutes_left)

        if pod_name:
            # Check if pod still exists before trying to send warnings
            if check_pod_exists(pod_name):
                # Send wall message to pod
                send_wall_message_to_pod(pod_name, warning_message)

                # Also create a visible file in the workspace
                create_warning_file_in_pod(pod_name, warning_message, minutes_left)
            else:
                logger.warning(
                    f"Pod {pod_name} no longer exists - reservation {reservation_id} may have been manually deleted or expired"
                )
                # Mark the reservation as expired since the pod is gone
                expire_reservation_due_to_missing_pod(reservation)

        # Update reservation to mark this specific warning as sent
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        warning_key = f"{warning_minutes}min_warning_sent"
        warnings_sent = reservation.get("warnings_sent", {})
        warnings_sent[warning_key] = True

        reservations_table.update_item(
            Key={"reservation_id": reservation_id},
            UpdateExpression="SET warnings_sent = :warnings_sent, last_warning_time = :warning_time",
            ExpressionAttributeValues={
                ":warnings_sent": warnings_sent,
                ":warning_time": current_time,
            },
        )

        logger.info(
            f"{warning_minutes}-minute warning sent for reservation {reservation_id}"
        )

    except Exception as e:
        logger.error(
            f"Error warning user for reservation {reservation.get('reservation_id')}: {str(e)}"
        )


def expire_reservation_due_to_missing_pod(reservation: dict[str, Any]) -> None:
    """Mark reservation as expired when pod is missing (likely manually deleted)"""
    try:
        reservation_id = reservation["reservation_id"]

        logger.info(
            f"Marking reservation {reservation_id} as expired due to missing pod"
        )

        # Update reservation status to expired
        now = datetime.utcnow().isoformat()
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        reservations_table.update_item(
            Key={"reservation_id": reservation_id},
            UpdateExpression="SET #status = :status, expired_at = :expired_at, reservation_ended = :reservation_ended, failure_reason = :reason",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":status": "expired",
                ":expired_at": now,
                ":reservation_ended": now,
                ":reason": "Pod was manually deleted or removed outside of reservation system",
            },
        )

        logger.info(
            f"Successfully marked reservation {reservation_id} as expired due to missing pod"
        )

    except Exception as e:
        logger.error(
            f"Error marking reservation {reservation.get('reservation_id')} as expired: {str(e)}"
        )


def expire_stuck_preparing_reservation(reservation: dict[str, Any]) -> None:
    """Mark stuck preparing reservation as failed when it's been preparing too long"""
    try:
        reservation_id = reservation["reservation_id"]

        logger.info(f"Marking stuck preparing reservation {reservation_id} as failed")

        # Update reservation status to failed
        now = datetime.utcnow().isoformat()
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        reservations_table.update_item(
            Key={"reservation_id": reservation_id},
            UpdateExpression="SET #status = :status, failed_at = :failed_at, reservation_ended = :reservation_ended, failure_reason = :reason",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":status": "failed",
                ":failed_at": now,
                ":reservation_ended": now,
                ":reason": "Reservation stuck in preparing status for more than 1 hour - likely pod creation failed",
            },
        )

        # Try to clean up any partial pod resources that might exist
        pod_name = reservation.get("pod_name")
        if pod_name:
            try:
                cleanup_stuck_pod_resources(pod_name)
                logger.info(
                    f"Cleaned up partial resources for stuck preparing reservation {reservation_id}"
                )
            except Exception as cleanup_error:
                logger.warning(
                    f"Error cleaning up partial resources for {pod_name}: {cleanup_error}"
                )

        logger.info(
            f"Successfully marked stuck preparing reservation {reservation_id} as failed"
        )

    except Exception as e:
        logger.error(
            f"Error marking stuck preparing reservation {reservation.get('reservation_id')} as failed: {str(e)}"
        )


def expire_reservation(reservation: dict[str, Any]) -> None:
    """Expire a reservation and clean up resources"""
    try:
        reservation_id = reservation["reservation_id"]
        user_id = reservation["user_id"]

        logger.info(f"Expiring reservation {reservation_id} for user {user_id}")

        # 1. Update reservation status to expired
        logger.info(
            f"Updating DynamoDB status to expired for reservation {reservation_id}"
        )
        now = datetime.utcnow().isoformat()
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)

        try:
            reservations_table.update_item(
                Key={"reservation_id": reservation_id},
                UpdateExpression="SET #status = :status, expired_at = :expired_at, reservation_ended = :reservation_ended",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={
                    ":status": "expired",
                    ":expired_at": now,
                    ":reservation_ended": now,
                },
            )
            logger.info(
                f"Successfully updated DynamoDB status to expired for reservation {reservation_id}"
            )
        except Exception as db_error:
            logger.error(
                f"Failed to update DynamoDB status for reservation {reservation_id}: {db_error}"
            )
            raise

        # 2. Clean up K8s pod (would use kubectl or K8s API)
        pod_name = reservation.get("pod_name")
        if pod_name:
            logger.info(
                f"Starting pod cleanup for reservation {reservation_id}, pod: {pod_name}"
            )
            try:
                cleanup_pod(pod_name, reservation.get("namespace", "gpu-dev"), reservation_data=reservation)
                logger.info(f"Pod cleanup completed for reservation {reservation_id}")
            except Exception as cleanup_error:
                logger.error(
                    f"Pod cleanup failed for reservation {reservation_id}: {cleanup_error}"
                )
                # Don't re-raise - we want to continue processing other reservations
                # The DynamoDB status is already updated correctly
        else:
            logger.warning(
                f"No pod_name found for reservation {reservation_id}, skipping pod cleanup"
            )

        # GPU resources released automatically by K8s when pod is deleted

        logger.info(f"Successfully expired reservation {reservation_id}")

    except Exception as e:
        logger.error(
            f"Error expiring reservation {reservation.get('reservation_id')}: {str(e)}"
        )
        logger.error(f"Exception type: {type(e).__name__}")
        import traceback

        logger.error(f"Full traceback: {traceback.format_exc()}")
        # Re-raise only for critical errors, not pod cleanup failures
        raise


def cancel_stale_reservation(reservation: dict[str, Any]) -> None:
    """Cancel a stale queued/pending reservation"""
    try:
        reservation_id = reservation["reservation_id"]
        user_id = reservation.get("user_id", "unknown")

        logger.info(f"Cancelling stale reservation {reservation_id} for user {user_id}")

        # Update reservation status to cancelled
        now = datetime.utcnow().isoformat()
        reservations_table = dynamodb.Table(RESERVATIONS_TABLE)
        reservations_table.update_item(
            Key={"reservation_id": reservation_id},
            UpdateExpression="SET #status = :status, cancelled_at = :cancelled_at, reservation_ended = :reservation_ended, failure_reason = :reason",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":status": "cancelled",
                ":cancelled_at": now,
                ":reservation_ended": now,
                ":reason": "Stale reservation - exceeded 5 minute queue time",
            },
        )

        logger.info(f"Successfully cancelled stale reservation {reservation_id}")

    except Exception as e:
        logger.error(
            f"Error cancelling stale reservation {reservation.get('reservation_id')}: {str(e)}"
        )


def create_warning_message(reservation: dict[str, Any], minutes_left: int) -> str:
    """Create warning message for user"""
    reservation_id = reservation["reservation_id"]

    if minutes_left <= 0:
        return f"🚨 URGENT: Reservation {reservation_id[:8]} expires in less than 1 minute! Save your work now!"
    elif minutes_left <= 5:
        return f"⚠️  WARNING: Reservation {reservation_id[:8]} expires in {minutes_left} minutes! Save your work!"
    elif minutes_left <= 15:
        return f"📢 NOTICE: Reservation {reservation_id[:8]} expires in {minutes_left} minutes. Please save your work."
    else:
        return f"📝 INFO: Reservation {reservation_id[:8]} expires in {minutes_left} minutes."


def cleanup_pod(pod_name: str, namespace: str = "gpu-dev", reservation_data: dict = None) -> None:
    """Clean up Kubernetes pod and associated resources"""
    try:
        logger.info(f"Cleaning up pod {pod_name} in namespace {namespace}")

        # Configure Kubernetes client
        logger.info(f"Setting up Kubernetes client for cleanup...")
        k8s_client = get_k8s_client()
        v1 = client.CoreV1Api(k8s_client)
        logger.info(f"Kubernetes client configured successfully")
        
        # Create shutdown snapshot if pod has persistent storage
        try:
            user_id = None
            volume_id = None
            
            # Get user_id and volume_id from reservation data if provided
            if reservation_data:
                user_id = reservation_data.get('user_id')
                volume_id = reservation_data.get('ebs_volume_id')
                
            # Quick check - if we have reservation data with EBS info, use it directly
            if user_id and volume_id:
                logger.info(f"Found persistent storage in reservation data: volume {volume_id} for user {user_id}")
            
            # If no reservation data or missing info, try to get from pod spec
            elif not user_id or not volume_id:
                try:
                    pod = v1.read_namespaced_pod(name=pod_name, namespace=namespace)
                    
                    # Extract user_id from pod labels or annotations
                    if pod.metadata.labels:
                        user_id = pod.metadata.labels.get('user-id') or user_id
                    
                    # Look for EBS volume in pod spec
                    if pod.spec.volumes:
                        for volume in pod.spec.volumes:
                            if volume.aws_elastic_block_store:
                                # Extract volume ID from AWS EBS volume
                                volume_id = volume.aws_elastic_block_store.volume_id
                                break
                                
                except Exception as pod_read_error:
                    logger.warning(f"Could not read pod {pod_name} for snapshot info: {pod_read_error}")
            
            # Create shutdown snapshot if we have the necessary info
            if user_id and volume_id:
                logger.info(f"Creating shutdown snapshot for user {user_id}, volume {volume_id}")
                snapshot_id = create_pod_shutdown_snapshot(volume_id, user_id)
                if snapshot_id:
                    logger.info(f"Shutdown snapshot {snapshot_id} initiated for {pod_name}")
                else:
                    logger.warning(f"Failed to create shutdown snapshot for {pod_name}")
            else:
                logger.info(f"No persistent storage found for pod {pod_name} - skipping shutdown snapshot")
                
        except Exception as snapshot_error:
            logger.warning(f"Error creating shutdown snapshot for {pod_name}: {snapshot_error}")
            # Continue with pod deletion even if snapshot fails

        # Send final warning message before deletion
        try:
            logger.info(f"Sending final warning message to pod {pod_name}")
            send_wall_message_to_pod(
                pod_name,
                "🚨 FINAL WARNING: Reservation expired! Pod will be deleted now. All unsaved work will be lost!",
                namespace,
            )
            logger.info(f"Final warning message sent to pod {pod_name}")
        except Exception as warn_error:
            logger.warning(
                f"Could not send final warning to pod {pod_name}: {warn_error}"
            )

        # Delete the NodePort service first
        service_name = f"{pod_name}-ssh"
        try:
            logger.info(f"Attempting to delete service {service_name}")
            v1.delete_namespaced_service(
                name=service_name, namespace=namespace, grace_period_seconds=0
            )
            logger.info(f"Successfully deleted service {service_name}")
        except client.exceptions.ApiException as e:
            if e.status == 404:
                logger.info(f"Service {service_name} not found (already deleted)")
            else:
                logger.warning(f"Failed to delete service {service_name}: {e}")
        except Exception as e:
            logger.error(f"Unexpected error deleting service {service_name}: {e}")

        # Delete the pod with grace period
        try:
            logger.info(f"Attempting to delete pod {pod_name} with 30s grace period")
            v1.delete_namespaced_pod(
                name=pod_name, namespace=namespace, grace_period_seconds=30
            )
            logger.info(f"Successfully initiated deletion of pod {pod_name}")
        except client.exceptions.ApiException as e:
            if e.status == 404:
                logger.info(f"Pod {pod_name} not found (already deleted)")
            else:
                logger.error(f"Failed to delete pod {pod_name}: {e}")

                # Force delete if graceful deletion failed
                try:
                    logger.info(f"Attempting force delete of pod {pod_name}")
                    v1.delete_namespaced_pod(
                        name=pod_name, namespace=namespace, grace_period_seconds=0
                    )
                    logger.info(f"Successfully force deleted pod {pod_name}")
                except client.exceptions.ApiException as force_error:
                    logger.error(
                        f"Failed to force delete pod {pod_name}: {force_error}"
                    )
                    raise
        except Exception as e:
            logger.error(f"Unexpected error deleting pod {pod_name}: {e}")
            raise

        logger.info(f"Pod cleanup completed successfully for {pod_name}")
        
        # NOTE: EBS volumes (persistent disks) are NOT deleted here
        # They automatically detach when the pod is deleted and remain
        # available for the user's next reservation

        # Trigger availability table update after pod cleanup
        try:
            trigger_availability_update()
            logger.info("Triggered availability table update after pod cleanup")
        except Exception as update_error:
            logger.warning(
                f"Failed to trigger availability update after pod cleanup: {update_error}"
            )
            # Don't fail the expiry for this

    except Exception as e:
        logger.error(f"Error cleaning up pod {pod_name}: {str(e)}")
        logger.error(f"Exception type: {type(e).__name__}")
        import traceback

        logger.error(f"Full traceback: {traceback.format_exc()}")
        raise


def cleanup_stuck_pod_resources(pod_name: str, namespace: str = "gpu-dev") -> None:
    """Clean up any partial resources for stuck preparing reservations"""
    try:
        logger.info(
            f"Cleaning up stuck pod resources for {pod_name} in namespace {namespace}"
        )

        # Configure Kubernetes client
        from kubernetes import client

        k8s_client = get_k8s_client()
        v1 = client.CoreV1Api(k8s_client)

        # Try to delete the pod if it exists (it might be in a failed state)
        try:
            v1.delete_namespaced_pod(
                name=pod_name, namespace=namespace, grace_period_seconds=0
            )
            logger.info(f"Deleted stuck pod {pod_name}")
        except client.exceptions.ApiException as e:
            if e.status == 404:
                logger.info(
                    f"Pod {pod_name} not found (already deleted or never created)"
                )
            else:
                logger.warning(f"Failed to delete stuck pod {pod_name}: {e}")

        # Try to delete the service if it exists
        service_name = f"{pod_name}-ssh"
        try:
            v1.delete_namespaced_service(
                name=service_name, namespace=namespace, grace_period_seconds=0
            )
            logger.info(f"Deleted stuck service {service_name}")
        except client.exceptions.ApiException as e:
            if e.status == 404:
                logger.info(
                    f"Service {service_name} not found (already deleted or never created)"
                )
            else:
                logger.warning(f"Failed to delete stuck service {service_name}: {e}")

    except Exception as e:
        logger.error(f"Error cleaning up stuck pod {pod_name}: {str(e)}")
        # Don't raise - cleanup failures shouldn't prevent marking reservation as failed


def send_wall_message_to_pod(pod_name: str, message: str, namespace: str = "gpu-dev"):
    """Send wall message to all logged-in users in the pod"""
    try:
        # Configure Kubernetes client
        k8s_client = get_k8s_client()
        v1 = client.CoreV1Api(k8s_client)

        # Warning message will be displayed via shell rc files (bashrc/zshrc)
        # No need for wall/terminal messaging since the file-based approach is more reliable
        logger.info(
            f"Warning file created for pod {pod_name} - will be shown via shell prompt"
        )

    except Exception as e:
        logger.warning(f"Error preparing warning for pod {pod_name}: {str(e)}")


def create_warning_file_in_pod(
    pod_name: str, warning_message: str, minutes_left: int, namespace: str = "gpu-dev"
):
    """Create a visible warning file in the pod's workspace"""
    try:
        # Configure Kubernetes client
        k8s_client = get_k8s_client()
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
Generated at: {datetime.now().strftime("%Y-%m-%d %H:%M:%S UTC")}
"""

        # Write file to /home/dev using Kubernetes exec, removing old warning files first
        file_cmd = f'rm -f /home/dev/WARN_EXPIRES_IN_*MIN.txt 2>/dev/null; echo "{warning_content}" > /home/dev/WARN_EXPIRES_IN_{minutes_left}MIN.txt'
        exec_command = ["bash", "-c", file_cmd]

        try:
            stream.stream(
                v1.connect_get_namespaced_pod_exec,
                pod_name,
                namespace,
                command=exec_command,
                container="gpu-dev",
                stderr=True,
                stdin=False,
                stdout=True,
                tty=False,
                _request_timeout=30,
            )
            logger.info(f"Warning file created in pod {pod_name}")
        except Exception as e:
            logger.warning(f"Failed to create warning file in pod {pod_name}: {e}")

    except Exception as e:
        logger.warning(f"Error creating warning file in pod {pod_name}: {str(e)}")
