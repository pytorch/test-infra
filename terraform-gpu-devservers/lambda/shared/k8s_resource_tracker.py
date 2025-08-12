"""
GPU Resource Tracking via Kubernetes API
Replaces manual GPU counting with real-time K8s resource queries
"""

import logging
import time
from typing import Any

from kubernetes import client

logger = logging.getLogger(__name__)


class K8sGPUTracker:
    """Track GPU resources using Kubernetes API instead of DynamoDB table"""

    def __init__(self, k8s_client):
        self.k8s_client = k8s_client
        self.v1 = client.CoreV1Api(k8s_client)

    def get_gpu_capacity_info(self) -> dict[str, Any]:
        """Get real-time GPU capacity and availability from K8s"""
        try:
            # Get all nodes
            nodes = self.v1.list_node()

            total_gpus = 0
            available_gpus = 0
            nodes_info = []

            for node in nodes.items:
                node_name = node.metadata.name

                # Get GPU capacity (total GPUs on this node)
                gpu_capacity = 0
                if node.status.capacity and "nvidia.com/gpu" in node.status.capacity:
                    gpu_capacity = int(node.status.capacity["nvidia.com/gpu"])

                # Get GPU allocatable (available for scheduling)
                gpu_allocatable = 0
                if (
                    node.status.allocatable
                    and "nvidia.com/gpu" in node.status.allocatable
                ):
                    gpu_allocatable = int(node.status.allocatable["nvidia.com/gpu"])

                # Get currently used GPUs by examining pods on this node
                gpu_used = self._get_gpus_used_on_node(node_name)
                gpu_available_now = max(0, gpu_allocatable - gpu_used)

                total_gpus += gpu_capacity
                available_gpus += gpu_available_now

                nodes_info.append(
                    {
                        "node_name": node_name,
                        "gpu_capacity": gpu_capacity,
                        "gpu_allocatable": gpu_allocatable,
                        "gpu_used": gpu_used,
                        "gpu_available": gpu_available_now,
                        "ready": self._is_node_ready(node),
                    }
                )

            return {
                "total_gpus": total_gpus,
                "available_gpus": available_gpus,
                "used_gpus": total_gpus - available_gpus,
                "nodes": nodes_info,
                "timestamp": int(time.time()),
            }

        except Exception as e:
            logger.error(f"Error getting GPU capacity info: {e}")
            raise

    def _get_gpus_used_on_node(self, node_name: str) -> int:
        """Count GPUs currently used by pods on a specific node"""
        try:
            # Get all pods on this node
            pods = self.v1.list_pod_for_all_namespaces(
                field_selector=f"spec.nodeName={node_name}"
            )

            gpus_used = 0
            for pod in pods.items:
                if pod.status.phase in ["Running", "Pending"]:
                    for container in pod.spec.containers:
                        if container.resources and container.resources.requests:
                            gpu_request = container.resources.requests.get(
                                "nvidia.com/gpu"
                            )
                            if gpu_request:
                                gpus_used += int(gpu_request)

            return gpus_used

        except Exception as e:
            logger.warning(f"Error counting GPUs on node {node_name}: {e}")
            return 0

    def _is_node_ready(self, node) -> bool:
        """Check if node is in Ready state"""
        if not node.status.conditions:
            return False

        for condition in node.status.conditions:
            if condition.type == "Ready":
                return condition.status == "True"
        return False

    def get_pending_gpu_reservations(self) -> list[dict[str, Any]]:
        """Get pods pending due to insufficient GPU resources"""
        try:
            pending_pods = []

            # Get all pending pods across all namespaces
            pods = self.v1.list_pod_for_all_namespaces(
                field_selector="status.phase=Pending"
            )

            for pod in pods.items:
                # Check if pending due to GPU constraints
                gpu_requests = 0
                for container in pod.spec.containers:
                    if container.resources and container.resources.requests:
                        gpu_request = container.resources.requests.get("nvidia.com/gpu")
                        if gpu_request:
                            gpu_requests += int(gpu_request)

                if gpu_requests > 0:
                    # Check pod events to see if it's GPU-related
                    reason = self._get_pending_reason(pod)

                    pending_pods.append(
                        {
                            "pod_name": pod.metadata.name,
                            "namespace": pod.metadata.namespace,
                            "gpu_requests": gpu_requests,
                            "created_at": pod.metadata.creation_timestamp,
                            "pending_reason": reason,
                            "labels": pod.metadata.labels or {},
                        }
                    )

            return pending_pods

        except Exception as e:
            logger.error(f"Error getting pending GPU reservations: {e}")
            return []

    def _get_pending_reason(self, pod) -> str:
        """Get the reason why a pod is pending"""
        try:
            events = self.v1.list_namespaced_event(
                namespace=pod.metadata.namespace,
                field_selector=f"involvedObject.name={pod.metadata.name}",
            )

            for event in events.items:
                if "Insufficient" in event.reason or "FailedScheduling" in event.reason:
                    return event.message

            return "Unknown"

        except Exception as e:
            logger.warning(
                f"Error getting pending reason for pod {pod.metadata.name}: {e}"
            )
            return "Unknown"

    def estimate_wait_time(
        self, requested_gpus: int, active_reservations: list[dict]
    ) -> dict[str, Any]:
        """Estimate wait time for GPU reservation based on current usage and expiry times"""
        try:
            capacity_info = self.get_gpu_capacity_info()
            available_now = capacity_info["available_gpus"]

            if available_now >= requested_gpus:
                return {
                    "can_schedule_now": True,
                    "estimated_wait_minutes": 0,
                    "message": f"{requested_gpus} GPU(s) available immediately",
                }

            # Calculate when GPUs will be freed based on reservation expiry times
            current_time = int(time.time())
            expiry_times = []

            for reservation in active_reservations:
                expires_at_raw = reservation.get("expires_at", 0)
                gpu_count = int(reservation.get("gpu_count", 1))

                # Handle both ISO string and Unix timestamp formats
                try:
                    if isinstance(expires_at_raw, str):
                        # ISO format: 2025-08-12T02:30:04.823958
                        from datetime import datetime, timezone
                        expires_dt = datetime.fromisoformat(expires_at_raw.replace("Z", "+00:00"))
                        if expires_dt.tzinfo is None:
                            # Naive datetime, assume UTC
                            expires_dt = expires_dt.replace(tzinfo=timezone.utc)
                        expires_at = int(expires_dt.timestamp())
                    else:
                        # Legacy Unix timestamp
                        expires_at = int(expires_at_raw)
                except (ValueError, TypeError):
                    # Skip invalid timestamps
                    continue

                if expires_at > current_time:
                    minutes_until_expiry = (expires_at - current_time) // 60
                    expiry_times.extend([minutes_until_expiry] * gpu_count)

            # Sort expiry times to see when GPUs become available
            expiry_times.sort()

            # Calculate when we'll have enough GPUs
            gpus_available = available_now
            estimated_wait = 0

            for _i, expiry_time in enumerate(expiry_times):
                gpus_available += 1
                if gpus_available >= requested_gpus:
                    estimated_wait = expiry_time
                    break

            pending_pods = self.get_pending_gpu_reservations()
            queue_position = (
                len([p for p in pending_pods if p["gpu_requests"] <= requested_gpus])
                + 1
            )

            return {
                "can_schedule_now": False,
                "estimated_wait_minutes": estimated_wait,
                "queue_position": queue_position,
                "available_now": available_now,
                "total_capacity": capacity_info["total_gpus"],
                "message": f"Expecting {requested_gpus} GPU(s) to be freed in ~{estimated_wait} minutes. You are #{queue_position} in queue.",
            }

        except Exception as e:
            logger.error(f"Error estimating wait time: {e}")
            return {
                "can_schedule_now": False,
                "estimated_wait_minutes": 60,  # Default estimate
                "message": "Unable to estimate wait time",
            }
