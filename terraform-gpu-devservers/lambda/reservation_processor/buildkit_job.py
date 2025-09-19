"""
BuildKit Job Creation for Dockerfile builds
Creates Kubernetes Jobs that build Docker images from Dockerfiles using daemonless BuildKit
"""

import logging
import os
from kubernetes import client
from typing import Dict, Any

logger = logging.getLogger(__name__)

def create_buildkit_job(
    k8s_client,
    reservation_id: str,
    dockerfile_base64_data: str,
    image_tag: str,
    ecr_repository_url: str
) -> str:
    """
    Create a Kubernetes Job that builds a Docker image using BuildKit

    Args:
        k8s_client: Kubernetes API client
        reservation_id: Unique reservation ID
        dockerfile_base64_data: Base64 encoded tar.gz build context
        image_tag: Tag for the built image (e.g., reservation_id[:8])
        ecr_repository_url: ECR repository URL

    Returns:
        Job name that was created
    """

    job_name = f"buildkit-{reservation_id[:8]}"

    # Full image URI for the built image
    full_image_uri = f"{ecr_repository_url}:{image_tag}"

    logger.info(f"Creating BuildKit job {job_name} to build {full_image_uri}")

    # BuildKit container - back to working approach
    buildkit_container = client.V1Container(
        name="buildkit",
        image="moby/buildkit:master",
        command=["/bin/sh"],
        args=[
            "-c",
            f"""
            set -ex
            echo "[BUILDKIT] Starting daemonless build for reservation {reservation_id}"

            # Install AWS CLI
            echo "[BUILDKIT] Installing AWS CLI..."
            apk add --no-cache aws-cli
            echo "[BUILDKIT] AWS CLI installation completed"

            # Decode and extract build context
            echo "[BUILDKIT] Preparing build context..."
            echo "{dockerfile_base64_data}" | base64 -d > /tmp/build_context.tar.gz
            mkdir -p /tmp/work
            cd /tmp/work
            tar -xzf /tmp/build_context.tar.gz
            echo "[BUILDKIT] Build context extracted, files:"
            ls -la

            # Setup ECR authentication - create proper Docker config
            echo "[BUILDKIT] Setting up ECR authentication..."
            ECR_REGISTRY="{ecr_repository_url.split('/')[0]}"
            ECR_TOKEN=$(aws ecr get-login-password --region {os.environ.get('REGION', 'us-east-2')})

            # Create Docker config directory and auth file
            mkdir -p ~/.docker
            cat > ~/.docker/config.json << EOF
{{
  "auths": {{
    "$ECR_REGISTRY": {{
      "auth": "$(echo -n AWS:$ECR_TOKEN | base64 -w 0)"
    }}
  }}
}}
EOF
            echo "[BUILDKIT] Docker config created"

            # Build with BuildKit daemonless mode
            echo "[BUILDKIT] Starting BuildKit build..."
            buildctl-daemonless.sh build \\
                --frontend dockerfile.v0 \\
                --local context=/tmp/work \\
                --local dockerfile=/tmp/work \\
                --output type=image,name={full_image_uri},push=true

            echo "[BUILDKIT] Build completed successfully: {full_image_uri}"
            """
        ],
        env=[
            client.V1EnvVar(name="AWS_REGION", value=os.environ.get("REGION", "us-east-2")),
        ],
        security_context=client.V1SecurityContext(
            privileged=True,
            allow_privilege_escalation=True,
        ),
        resources=client.V1ResourceRequirements(
            requests={
                "cpu": "2",
                "memory": "4Gi",
                "ephemeral-storage": "50Gi"  # Request 50GB ephemeral storage
            },
            limits={
                "cpu": "8",
                "memory": "16Gi",
                "ephemeral-storage": "500Gi"  # Allow up to 500GB for very large Docker builds and layer caching
            }
        )
    )

    # Job spec
    job_spec = client.V1JobSpec(
        template=client.V1PodTemplateSpec(
            metadata=client.V1ObjectMeta(
                labels={
                    "app": "buildkit",
                    "reservation-id": reservation_id[:8],
                    "type": "docker-build"
                }
            ),
            spec=client.V1PodSpec(
                containers=[buildkit_container],
                restart_policy="Never",
                service_account_name="buildkit-service-account",  # IRSA service account
                security_context=client.V1PodSecurityContext(
                    run_as_non_root=False,  # Allow root for package installation and BuildKit
                    # Remove seccomp profile restrictions for privileged BuildKit operations
                ),
                node_selector={
                    "NodeType": "cpu"  # Run on CPU nodes, not GPU nodes
                }
            )
        ),
        backoff_limit=2,  # Retry up to 2 times
        ttl_seconds_after_finished=3600,  # Clean up job after 1 hour
    )

    # Create Job
    job = client.V1Job(
        api_version="batch/v1",
        kind="Job",
        metadata=client.V1ObjectMeta(
            name=job_name,
            namespace="gpu-dev",
            labels={
                "app": "buildkit",
                "reservation-id": reservation_id[:8],
                "type": "docker-build"
            }
        ),
        spec=job_spec
    )

    # Create the job
    batch_v1 = client.BatchV1Api(k8s_client)
    try:
        batch_v1.create_namespaced_job(namespace="gpu-dev", body=job)
        logger.info(f"Successfully created BuildKit job: {job_name}")
        return job_name
    except Exception as e:
        logger.error(f"Failed to create BuildKit job {job_name}: {str(e)}")
        raise


def wait_for_buildkit_job(k8s_client, job_name: str, timeout_seconds: int = 600) -> Dict[str, Any]:
    """
    Wait for BuildKit job to complete and return status

    Args:
        k8s_client: Kubernetes API client
        job_name: Name of the BuildKit job
        timeout_seconds: Maximum time to wait

    Returns:
        Dict with status information: {"success": bool, "message": str, "logs": str}
    """
    import time

    logger.info(f"Waiting for BuildKit job {job_name} to complete...")

    batch_v1 = client.BatchV1Api(k8s_client)
    core_v1 = client.CoreV1Api(k8s_client)

    start_time = time.time()

    while time.time() - start_time < timeout_seconds:
        try:
            # Get job status
            job = batch_v1.read_namespaced_job(name=job_name, namespace="gpu-dev")

            if job.status.succeeded:
                # Job completed successfully
                logs = _get_job_logs(core_v1, job_name)
                return {
                    "success": True,
                    "message": "Docker image built successfully",
                    "logs": logs
                }
            elif job.status.failed:
                # Job failed
                logs = _get_job_logs(core_v1, job_name)
                return {
                    "success": False,
                    "message": f"Docker build failed (attempts: {job.status.failed})",
                    "logs": logs
                }

            # Job still running, wait and check again
            time.sleep(10)

        except Exception as e:
            logger.error(f"Error checking job status: {str(e)}")
            time.sleep(5)

    # Timeout reached
    logs = _get_job_logs(core_v1, job_name)
    return {
        "success": False,
        "message": f"Docker build timed out after {timeout_seconds} seconds",
        "logs": logs
    }


def _get_job_logs(core_v1, job_name: str) -> str:
    """Get logs from all pods of a job"""
    try:
        # Find pods for this job
        pod_list = core_v1.list_namespaced_pod(
            namespace="gpu-dev",
            label_selector=f"job-name={job_name}"
        )

        all_logs = []
        for pod in pod_list.items:
            try:
                logs = core_v1.read_namespaced_pod_log(
                    name=pod.metadata.name,
                    namespace="gpu-dev",
                    tail_lines=100  # Get last 100 lines
                )
                all_logs.append(f"=== Pod {pod.metadata.name} ===\\n{logs}")
            except Exception as e:
                all_logs.append(f"=== Pod {pod.metadata.name} ===\\nFailed to get logs: {str(e)}")

        return "\\n\\n".join(all_logs)
    except Exception as e:
        return f"Failed to get job logs: {str(e)}"


def cleanup_buildkit_job(k8s_client, job_name: str) -> bool:
    """
    Clean up a BuildKit job and its pods

    Args:
        k8s_client: Kubernetes API client
        job_name: Name of the BuildKit job to clean up

    Returns:
        True if cleanup was successful
    """
    try:
        batch_v1 = client.BatchV1Api(k8s_client)

        # Delete the job (this will also delete associated pods)
        batch_v1.delete_namespaced_job(
            name=job_name,
            namespace="gpu-dev",
            propagation_policy="Background"  # Delete pods in background
        )

        logger.info(f"Successfully cleaned up BuildKit job: {job_name}")
        return True
    except Exception as e:
        logger.error(f"Failed to cleanup BuildKit job {job_name}: {str(e)}")
        return False