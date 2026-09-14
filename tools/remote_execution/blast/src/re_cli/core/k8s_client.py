"""
Kubernetes CRD Client for Blast CLI

Provides methods to interact with CRDs:
- RemoteExecutionRun: create/cancel runs
- RunQuery: query task/run status
- Logs via API extension
"""

import base64
import collections
import time
import uuid
from dataclasses import dataclass
from typing import Generator, Optional

from kubernetes import client, config  # type: ignore[import-untyped]

from .core_types import console

# Default EKS cluster settings for RE service
_DEFAULT_CLUSTER_NAME = "pytorch-re-prod-production"
_DEFAULT_CLUSTER_ENDPOINT = "https://27AA21635A8B6A637F0ADC00DA80A293.gr7.us-east-2.eks.amazonaws.com"
_DEFAULT_REGION = "us-east-2"


@dataclass
class K8sConfig:
    namespace: str = "remote-execution-system"
    job_namespace: str = "remote-execution-job-space-beta"
    timeout: int = 30  # seconds to wait for CRD status


@dataclass
class CredentialsConfig:
    """Configuration for AWS credentials-based authentication."""
    access_key: str = ""
    secret_key: str = ""
    role_arn: str = ""
    cluster_name: str = _DEFAULT_CLUSTER_NAME
    cluster_endpoint: str = _DEFAULT_CLUSTER_ENDPOINT
    region: str = _DEFAULT_REGION
    ca_data: str = ""  # base64-encoded cluster CA certificate


class K8sClient:
    """Client for interacting with CRDs and API extensions."""

    CRD_GROUP = "remote-execution.io"
    CRD_VERSION = "v1"

    # Rate limit: max calls per minute for credentials-based clients
    _RATE_LIMIT_MAX_CALLS = 30
    _RATE_LIMIT_WINDOW = 60  # seconds

    def __init__(self, cfg: K8sConfig):
        self.config = cfg
        self._credentials: Optional[CredentialsConfig] = None
        self._call_timestamps: collections.deque = collections.deque()
        self._load_client()

    @classmethod
    def from_credentials(
        cls,
        access_key: str,
        secret_key: str,
        role_arn: str = "",
        cluster_name: str = _DEFAULT_CLUSTER_NAME,
        cluster_endpoint: str = _DEFAULT_CLUSTER_ENDPOINT,
        region: str = _DEFAULT_REGION,
        ca_data: str = "",
        cfg: Optional[K8sConfig] = None,
    ) -> "K8sClient":
        """Create a K8sClient using AWS credentials instead of kubeconfig.

        Args:
            access_key: AWS access key ID
            secret_key: AWS secret access key
            role_arn: IAM role ARN to assume (optional, uses credentials directly if empty)
            cluster_name: EKS cluster name
            cluster_endpoint: EKS API server endpoint URL
            region: AWS region
            ca_data: Base64-encoded cluster CA certificate (optional, disables TLS verify if empty)
            cfg: K8sConfig for namespace/timeout settings
        """
        instance = cls.__new__(cls)
        instance.config = cfg or K8sConfig()
        instance._credentials = CredentialsConfig(
            access_key=access_key,
            secret_key=secret_key,
            role_arn=role_arn,
            cluster_name=cluster_name,
            cluster_endpoint=cluster_endpoint,
            region=region,
            ca_data=ca_data,
        )
        instance._load_client_from_credentials()
        return instance

    def _get_eks_token(self, creds_config: CredentialsConfig) -> str:
        """Generate an EKS bearer token using AWS credentials.

        Uses the same mechanism as `aws eks get-token`: a presigned
        GetCallerIdentity URL encoded as a K8s bearer token.
        """
        import boto3
        from botocore.signers import RequestSigner

        # If role_arn provided, assume it first
        if creds_config.role_arn:
            sts = boto3.client(
                "sts",
                aws_access_key_id=creds_config.access_key,
                aws_secret_access_key=creds_config.secret_key,
                region_name=creds_config.region,
            )
            assumed = sts.assume_role(
                RoleArn=creds_config.role_arn,
                RoleSessionName="blast-api",
                DurationSeconds=3600,
            )
            session = boto3.Session(
                aws_access_key_id=assumed["Credentials"]["AccessKeyId"],
                aws_secret_access_key=assumed["Credentials"]["SecretAccessKey"],
                aws_session_token=assumed["Credentials"]["SessionToken"],
                region_name=creds_config.region,
            )
        else:
            session = boto3.Session(
                aws_access_key_id=creds_config.access_key,
                aws_secret_access_key=creds_config.secret_key,
                region_name=creds_config.region,
            )

        sts_client = session.client("sts")
        service_id = sts_client.meta.service_model.service_id

        signer = RequestSigner(
            service_id,
            creds_config.region,
            "sts",
            "v4",
            session.get_credentials(),
            session.events,
        )

        url = signer.generate_presigned_url(
            {
                "method": "GET",
                "url": f"https://sts.{creds_config.region}.amazonaws.com/"
                       f"?Action=GetCallerIdentity&Version=2011-06-15",
                "body": {},
                "headers": {"x-k8s-aws-id": creds_config.cluster_name},
            },
            region_name=creds_config.region,
            expires_in=60,
            operation_name="",
        )

        return "k8s-aws-v1." + base64.urlsafe_b64encode(url.encode()).rstrip(b"=").decode()

    def _load_client_from_credentials(self):
        """Load K8s client using AWS credentials (no kubeconfig file needed)."""
        console.print("[K8s] Loading from credentials...", end=" ")
        start = time.time()

        token = self._get_eks_token(self._credentials)

        configuration = client.Configuration()
        configuration.host = self._credentials.cluster_endpoint
        configuration.api_key = {"BearerToken": token}
        configuration.api_key_prefix = {"BearerToken": "Bearer"}

        if self._credentials.ca_data:
            import tempfile
            ca_bytes = base64.b64decode(self._credentials.ca_data)
            ca_file = tempfile.NamedTemporaryFile(delete=False, suffix=".crt")
            ca_file.write(ca_bytes)
            ca_file.close()
            configuration.ssl_ca_cert = ca_file.name
        else:
            configuration.verify_ssl = False

        self.api_client = client.ApiClient(configuration)
        self.custom_api = client.CustomObjectsApi(self.api_client)
        self.core_api = client.CoreV1Api(self.api_client)
        console.print(f"({time.time() - start:.1f}s)")

    def _load_client(self):
        """Load kubeconfig and create API clients."""
        console.print("[K8s] Loading kubeconfig...", end=" ")
        start = time.time()
        config.load_kube_config()
        console.print(f"({time.time() - start:.1f}s)")

        self.api_client = client.ApiClient()
        self.custom_api = client.CustomObjectsApi(self.api_client)
        self.core_api = client.CoreV1Api(self.api_client)

    def _reload_client(self):
        """Reload client to get a fresh token."""
        if self._credentials:
            self._load_client_from_credentials()
        else:
            config.load_kube_config()
            self.api_client = client.ApiClient()
            self.custom_api = client.CustomObjectsApi(self.api_client)
            self.core_api = client.CoreV1Api(self.api_client)

    def _get_token(self) -> Optional[str]:
        """Get the current bearer token from api_client configuration."""
        cfg = self.api_client.configuration
        token = cfg.api_key.get("BearerToken") or cfg.api_key.get("authorization")
        if token and token.startswith("Bearer "):
            token = token[7:]
        return token

    def _check_rate_limit(self):
        """Enforce rate limit for credentials-based clients.

        Only applied to user-initiated operations (create/cancel/query),
        not internal polling (_wait_for_status).
        """
        if not self._credentials:
            return
        now = time.time()
        while self._call_timestamps and self._call_timestamps[0] < now - self._RATE_LIMIT_WINDOW:
            self._call_timestamps.popleft()
        if len(self._call_timestamps) >= self._RATE_LIMIT_MAX_CALLS:
            wait = self._call_timestamps[0] + self._RATE_LIMIT_WINDOW - now
            raise RuntimeError(
                f"Rate limit exceeded: {self._RATE_LIMIT_MAX_CALLS} calls per {self._RATE_LIMIT_WINDOW}s. "
                f"Retry in {wait:.0f}s."
            )
        self._call_timestamps.append(now)

    def _call_with_retry(self, fn):
        """Call fn, retry once with fresh token on 401/403, this mainly due to auth token expiring."""
        try:
            return fn()
        except client.ApiException as e:
            if e.status in (401, 403):
                self._reload_client()
                return fn()
            raise

    def _apply_crd(self, kind: str, plural: str, name: str, spec: dict) -> dict:
        """Apply a CRD and return the created object."""
        self._check_rate_limit()
        body = {
            "apiVersion": f"{self.CRD_GROUP}/{self.CRD_VERSION}",
            "kind": kind,
            "metadata": {"name": name},
            "spec": spec,
        }

        return self._call_with_retry(
            lambda: self.custom_api.create_namespaced_custom_object(
                group=self.CRD_GROUP,
                version=self.CRD_VERSION,
                namespace=self.config.namespace,
                plural=plural,
                body=body,
            )
        )

    def _get_crd(self, plural: str, name: str) -> dict:
        """Get a CRD by name."""
        return self._call_with_retry(
            lambda: self.custom_api.get_namespaced_custom_object(
                group=self.CRD_GROUP,
                version=self.CRD_VERSION,
                namespace=self.config.namespace,
                plural=plural,
                name=name,
            )
        )

    def _wait_for_status(
        self,
        plural: str,
        name: str,
        phases: list[str],
        timeout: Optional[int] = None,
    ) -> dict:
        """Wait for CRD to reach one of the specified phases."""
        timeout = timeout or self.config.timeout
        start = time.time()

        while time.time() - start < timeout:
            try:
                obj = self._get_crd(plural, name)
                status = obj.get("status", {})
                phase = status.get("phase")

                if phase in phases:
                    return obj
            except client.ApiException:
                pass

            time.sleep(0.5)

        raise TimeoutError(f"Timeout waiting for {plural}/{name} to reach {phases}")

    def _wait_for_status_with_tasks(
        self,
        plural: str,
        name: str,
        phases: list[str],
        timeout: Optional[int] = None,
    ) -> dict:
        """Wait for CRD to reach phase AND have tasks populated."""
        timeout = timeout or self.config.timeout
        start = time.time()

        while time.time() - start < timeout:
            try:
                obj = self._get_crd(plural, name)
                status = obj.get("status", {})
                phase = status.get("phase")
                tasks = status.get("tasks", [])

                # Need both correct phase AND tasks populated
                if phase in phases and tasks:
                    return obj
                # If failed, return immediately
                if phase == "Failed":
                    return obj
            except client.ApiException:
                pass

            time.sleep(0.3)

        raise TimeoutError(
            f"Timeout waiting for {plural}/{name} to reach {phases} with tasks"
        )

    # =========================================================================
    # RemoteExecutionRun Operations
    # =========================================================================

    def create_run(
        self,
        name: str,
        steps: list[dict],
        need_signed_url: bool = True,
        run_name: Optional[str] = None,
    ) -> dict:
        """Create a run via RemoteExecutionRun CRD (action=create).

        Matches execution_helper.py expected interface:
        - Returns run_id, tasks, signed_url (if requested), artifacts_path
        """
        # Generate run_id locally for idempotency
        run_id = uuid.uuid4().hex[:18]
        crd_name = f"run-{run_id}"
        run_name = run_name or name

        steps_spec = []
        for step in steps:
            step_spec = {"name": step.get("name")}
            for key in [
                "image",
                "task_type",
                "script",
                "script_name",
                "env_vars",
            ]:
                if step.get(key):
                    step_spec[key] = step[key]
            steps_spec.append(step_spec)

        spec = {
            "action": "create",
            "name": run_name,
            "steps": steps_spec,
            "need_signed_url": need_signed_url,
            "run_id": run_id,  # Pass run_id for idempotency
        }

        self._apply_crd("RemoteExecutionRun", "remoteexecutionruns", crd_name, spec)

        # Wait for status AND tasks to be populated
        obj = self._wait_for_status_with_tasks(
            "remoteexecutionruns", crd_name, ["Preparing", "Failed"]
        )

        status = obj.get("status", {})
        if status.get("phase") == "Failed":
            raise RuntimeError(f"Create run failed: {status.get('message')}")

        # Build response matching execution_helper.py expectations
        tasks = []
        for t in status.get("tasks", []):
            tasks.append(
                {
                    "task_id": t.get("task_id"),
                    "step_index": t.get("step_index"),
                    "step_name": t.get("name"),
                    "task_type": t.get("task_type", "cpu"),
                    "script_name": t.get("script_name"),
                }
            )

        return {
            "run_id": status.get("run_id"),
            "tasks": tasks,
            "artifacts_path": status.get("artifacts_path", ""),
            "signed_url": status.get("signed_url"),
            "crd_name": crd_name,  # Return CRD name for reference
        }

    def execute_run(
        self,
        run_id: str,
        artifacts_path: str = "",
        tasks: Optional[list[dict]] = None,
        patch_info: Optional[dict] = None,
        first_task_env: Optional[dict] = None,
    ) -> dict:
        """Execute a run via RemoteExecutionRun CRD (action=execute).

        Creates a new CRD with action=execute.
        """
        crd_name = f"exec-{run_id}"
        tasks_spec = tasks if tasks else []

        spec: dict = {
            "action": "execute",
            "run_id": run_id,
            "artifacts_path": artifacts_path,
            "tasks": tasks_spec,
        }

        if patch_info:
            spec["patch_info"] = patch_info
        if first_task_env:
            spec["first_task_env"] = first_task_env

        self._apply_crd("RemoteExecutionRun", "remoteexecutionruns", crd_name, spec)

        # Wait for status
        obj = self._wait_for_status(
            "remoteexecutionruns",
            crd_name,
            ["Running", "Failed"],
            timeout=60,
        )

        status = obj.get("status", {})
        if status.get("phase") == "Failed":
            raise RuntimeError(f"Execute run failed: {status.get('message')}")

        return {
            "run_id": run_id,
            "phase": status.get("phase"),
            "message": status.get("message"),
        }

    def cancel_run(self, run_id: str) -> dict:
        """Cancel a run via RemoteExecutionRun CRD."""
        crd_name = f"cancel-{uuid.uuid4().hex[:8]}"

        spec = {
            "action": "cancel",
            "run_id": run_id,
        }

        self._apply_crd("RemoteExecutionRun", "remoteexecutionruns", crd_name, spec)

        return {"run_id": run_id, "status": "cancelled"}

    # =========================================================================
    # RunQuery Operations
    # =========================================================================

    def query_task_status(
        self, task_id: str, *, include_downloads: bool = False, tail_lines: int = 0
    ) -> Optional[dict]:
        """Query task status via RunQuery CRD."""
        crd_name = f"query-{uuid.uuid4().hex[:8]}"

        spec = {
            "query_type": "task_status",
            "task_id": task_id,
            "ttlSecondsAfterFinished": 60,
        }
        if include_downloads:
            spec["include_downloads"] = True
        if tail_lines > 0:
            spec["tail_lines"] = tail_lines

        self._apply_crd("RunQuery", "runqueries", crd_name, spec)

        # Wait for status
        obj = self._wait_for_status("runqueries", crd_name, ["Completed", "Failed"])

        status = obj.get("status", {})
        if status.get("phase") == "Failed":
            raise RuntimeError(f"Query failed: {status.get('message')}")

        items = status.get("items", [])
        return items[0] if items else None

    def get_task_status(self, task_id: str) -> Optional[dict]:
        """Get task status (converts to format expected by execution_helper)."""
        result = self.query_task_status(task_id)
        if not result:
            return None

        # Convert CRD response format to execution_helper expected format
        return {
            "id": result.get("task_id") or result.get("id"),
            "name": result.get("name"),
            "current_status": result.get("current_status") or result.get("status"),
            "run_id": result.get("run_id"),
        }

    def query_run_status(
        self, run_id: str, *, include_downloads: bool = False
    ) -> Optional[dict]:
        """Query run status via RunQuery CRD."""
        crd_name = f"query-{uuid.uuid4().hex[:8]}"

        spec = {
            "query_type": "run_status",
            "run_id": run_id,
            "ttlSecondsAfterFinished": 60,
        }
        if include_downloads:
            spec["include_downloads"] = True

        self._apply_crd("RunQuery", "runqueries", crd_name, spec)

        # Wait for status
        obj = self._wait_for_status("runqueries", crd_name, ["Completed", "Failed"])

        status = obj.get("status", {})
        if status.get("phase") == "Failed":
            raise RuntimeError(f"Query failed: {status.get('message')}")

        items = status.get("items", [])
        return items[0] if items else None

    def list_tasks(self, limit: int = 20, status_filter: Optional[str] = None) -> list:
        """List tasks via RunQuery CRD."""
        crd_name = f"query-{uuid.uuid4().hex[:8]}"

        spec = {
            "query_type": "list",
            "limit": limit,
            "ttlSecondsAfterFinished": 60,
        }
        if status_filter:
            spec["statusFilter"] = status_filter

        self._apply_crd("RunQuery", "runqueries", crd_name, spec)

        # Wait for status
        obj = self._wait_for_status("runqueries", crd_name, ["Completed", "Failed"])

        status = obj.get("status", {})
        if status.get("phase") == "Failed":
            raise RuntimeError(f"Query failed: {status.get('message')}")

        return status.get("items", [])

    # =========================================================================
    # Logs via API Extension
    # =========================================================================

    def get_task_logs(
        self,
        task_id: str,
        follow: bool = False,
        tail_lines: Optional[int] = None,
    ) -> str:
        """Get logs for a task (non-streaming, for completed tasks).

        Args:
            task_id: Task ID to get logs for
            follow: Should be False for completed tasks
            tail_lines: Number of lines to return from end

        Returns:
            Log content as string
        """
        import requests
        import urllib3

        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

        path = (
            f"/apis/logs.remote-execution.io/v1/namespaces/"
            f"{self.config.job_namespace}/tasks/{task_id}/log"
        )

        params = {"follow": "false", "timestamps": "true"}
        if tail_lines:
            params["tail_lines"] = str(tail_lines)

        token = self._get_token()
        host = self.api_client.configuration.host
        url = host + path

        headers = {"Authorization": f"Bearer {token}"}
        ca_cert = self.api_client.configuration.ssl_ca_cert

        resp = requests.get(
            url,
            params=params,
            headers=headers,
            verify=ca_cert if ca_cert else False,
            timeout=30,
        )

        if resp.status_code == 404:
            raise RuntimeError(f"No pod found for task {task_id}")
        resp.raise_for_status()

        return resp.text

    def stream_task_logs(
        self,
        task_id: str,
        follow: bool = False,
        tail_lines: Optional[int] = None,
        wait_ready: bool = True,
        since_time: Optional[str] = None,
        max_retries: int = 5,
    ) -> Generator[tuple[str, str], None, None]:
        """Stream logs via API Extension with auto-reconnect.
        Yields:
            (timestamp_str, line_content) tuples
        """
        path = (
            f"/apis/logs.remote-execution.io/v1/namespaces/"
            f"{self.config.job_namespace}/tasks/{task_id}/log"
        )

        retry_count = 0
        current_since_time = since_time
        last_cursor = None

        while retry_count < max_retries:
            params = self._build_stream_params(
                follow,
                tail_lines,
                wait_ready,
                current_since_time,
                retry_count,
            )
            try:
                for ts, content in self._stream_response(path, params):
                    if ts:
                        last_cursor = ts
                    yield (ts, content)
                break  # Stream ended normally
            except Exception as e:
                if self._is_retryable(e) and follow:
                    retry_count += 1
                    self._reload_client()
                    yield (
                        "",
                        f"[Reconnecting ({retry_count}/{max_retries})...]",
                    )
                    time.sleep(1)
                    if last_cursor:
                        current_since_time = last_cursor
                else:
                    raise
        else:
            raise ConnectionError(f"Log stream failed after {max_retries} retries")

    def _build_stream_params(
        self,
        follow,
        tail_lines,
        wait_ready,
        since_time,
        retry_count,
    ) -> dict:
        """Build query params for log streaming request."""
        params = {"include_cursor": "true"}
        if follow:
            params["follow"] = "true"
        if tail_lines and retry_count == 0:
            params["tailLines"] = str(tail_lines)
        if wait_ready:
            params["wait_ready"] = "true"
        if since_time:
            params["since_time"] = since_time
        return params

    def _stream_response(
        self,
        path: str,
        params: dict,
    ) -> Generator[tuple[str, str], None, None]:
        """Make HTTP request and yield parsed (timestamp, line) tuples."""
        import requests
        import urllib3

        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

        token = self._get_token()
        if token:
            host = self.api_client.configuration.host
            ca_cert = self.api_client.configuration.ssl_ca_cert

            resp = requests.get(
                host + path,
                headers={"Authorization": f"Bearer {token}"},
                params=params,
                stream=True,
                verify=ca_cert if ca_cert else False,
                timeout=(10, 300),
            )

            if resp.status_code != 200:
                raise Exception(
                    f"API Extension returned {resp.status_code}: {resp.text[:200]}"
                )

            yield from self._parse_text_stream(
                resp.iter_content(
                    chunk_size=1024,
                    decode_unicode=True,
                )
            )
        else:
            response, status, _ = self.api_client.call_api(
                path,
                "GET",
                query_params=list(params.items()),
                _preload_content=False,
            )
            yield from self._parse_byte_stream(response.stream())

    def _parse_text_stream(self, chunks) -> Generator[tuple[str, str], None, None]:
        """Parse text chunks into (timestamp, line) tuples."""
        buffer = ""
        for chunk in chunks:
            if not chunk:
                continue
            buffer += chunk
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                if line:
                    yield self._parse_cursor_line(line)
        if buffer:
            yield self._parse_cursor_line(buffer)

    def _parse_byte_stream(self, chunks) -> Generator[tuple[str, str], None, None]:
        """Parse byte chunks into (timestamp, line) tuples."""
        buffer = b""
        for chunk in chunks:
            if not chunk:
                continue
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if line:
                    yield self._parse_cursor_line(
                        line.decode("utf-8", errors="replace")
                    )
        if buffer:
            yield self._parse_cursor_line(buffer.decode("utf-8", errors="replace"))

    def _parse_cursor_line(self, line: str) -> tuple[str, str]:
        """Parse [cursor:TIMESTAMP] prefix from a log line."""
        if line.startswith("[cursor:"):
            try:
                bracket_end = line.index("]")
                return (line[8:bracket_end], line[bracket_end + 2 :])
            except (ValueError, IndexError):
                pass
        return ("", line)

    @staticmethod
    def _is_retryable(e: Exception) -> bool:
        """Check if an exception is retryable (connection drop or auth)."""
        msg = str(e)
        return any(
            s in msg
            for s in (
                "Response ended prematurely",
                "ConnectionError",
                "ChunkedEncodingError",
                "401",
                "403",
            )
        )

    # =========================================================================
    # Utility
    # =========================================================================

    def get_run_tasks(self, run_id: str) -> list:
        """Get tasks for a run (for logs command)."""
        run_status = self.query_run_status(run_id)
        if not run_status:
            return []

        return [
            {
                "task_id": t.get("task_id"),
                "step_name": t.get("name"),
                "step_order": t.get("stepIndex", 0),
            }
            for t in run_status.get("tasks", [])
        ]
