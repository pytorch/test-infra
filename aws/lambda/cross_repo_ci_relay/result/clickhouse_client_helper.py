import logging
import threading
from urllib.parse import urlparse

import clickhouse_connect

logger = logging.getLogger(__name__)

_OOT_CI_RESULTS_DDL = """
CREATE TABLE IF NOT EXISTS oot_ci_results (
    recorded_at   DateTime DEFAULT now(),
    device        String,
    upstream_repo String,
    commit_sha    String,
    workflow_name String,
    conclusion    String,
    status        String,
    run_url       String
) ENGINE = MergeTree()
ORDER BY (upstream_repo, commit_sha, device)
""".strip()


class CHCliFactory:
    """Class-level ClickHouse client cache. Call setup_client() once at cold start."""

    _lock = threading.Lock()
    _table_ensured = False
    _client = None

    @classmethod
    def setup_client(
        cls,
        url: str,
        username: str,
        password: str,
        database: str = "default",
    ) -> None:
        parsed = urlparse(url)
        cls._host = parsed.hostname or "localhost"
        cls._port = parsed.port or 8123
        cls._secure = parsed.scheme in ("https", "clickhouses")
        cls._username = username
        cls._password = password
        cls._database = database
        cls._client = None
        cls._table_ensured = False
        logger.debug(
            "CHCliFactory configured host=%s port=%s database=%s",
            cls._host, cls._port, cls._database,
        )

    @classmethod
    def _get_client(cls) -> clickhouse_connect.driver.Client:
        if cls._client is None:
            for attr in ("_host", "_port", "_username", "_password", "_database"):
                if not hasattr(cls, attr):
                    raise RuntimeError(
                        "ClickHouse client not configured. Call CHCliFactory.setup_client() first."
                    )
            cls._client = clickhouse_connect.get_client(
                host=cls._host,
                port=cls._port,
                username=cls._username,
                password=cls._password,
                database=cls._database,
                secure=cls._secure,
            )
            logger.debug("ClickHouse client created host=%s", cls._host)
        return cls._client

    @classmethod
    def ensure_table(cls) -> None:
        """Create oot_ci_results if it does not exist (idempotent, runs once per process)."""
        if cls._table_ensured:
            return
        with cls._lock:
            if cls._table_ensured:
                return
            cls._get_client().command(_OOT_CI_RESULTS_DDL)
            cls._table_ensured = True
            logger.info("ClickHouse table oot_ci_results ensured")

    @classmethod
    def write_ci_result(
        cls,
        *,
        device: str,
        upstream_repo: str,
        commit_sha: str,
        workflow_name: str,
        status: str,
        conclusion: str,
        run_url: str,
    ) -> None:
        cls._get_client().insert(
            "oot_ci_results",
            [[device, upstream_repo, commit_sha, workflow_name, conclusion, status, run_url]],
            column_names=["device", "upstream_repo", "commit_sha", "workflow_name",
                          "conclusion", "status", "run_url"],
        )

    @staticmethod
    def _sql_string(value: str) -> str:
        escaped = value.replace("\\", "\\\\").replace("'", "\\'")
        return f"'{escaped}'"

    @classmethod
    def update_ci_result_by_run_url(
        cls,
        *,
        run_url: str,
        status: str,
        conclusion: str,
    ) -> None:
        query = (
            "ALTER TABLE oot_ci_results "
            f"UPDATE status = {cls._sql_string(status)}, "
            f"conclusion = {cls._sql_string(conclusion)} "
            f"WHERE run_url = {cls._sql_string(run_url)}"
        )
        cls._get_client().command(query)
        logger.info("ClickHouse row update requested run_url=%s status=%s", run_url, status)
