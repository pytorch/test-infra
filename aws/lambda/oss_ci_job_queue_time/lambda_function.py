#!/usr/bin/env python
import argparse
from collections import defaultdict
import json
import logging
import os
import threading
import yaml
import clickhouse_connect

# Local imports
from typing import Any, Optional, Dict, Set, Iterable, List
from github import Github, Auth
from dateutil.parser import parse
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed


logging.basicConfig(
    level=logging.INFO,
)
logger = logging.getLogger()
logger.setLevel("INFO")

ENVS = {
    "GITHUB_ACCESS_TOKEN": os.getenv("GITHUB_ACCESS_TOKEN", ""),
    "CLICKHOUSE_ENDPOINT": os.getenv("CLICKHOUSE_ENDPOINT", ""),
    "CLICKHOUSE_PASSWORD": os.getenv("CLICKHOUSE_PASSWORD", ""),
    "CLICKHOUSE_USERNAME": os.getenv("CLICKHOUSE_USERNAME", ""),
}


def get_clickhouse_client(
    host: str, user: str, password: str
) -> clickhouse_connect.driver.client.Client:
    # for local testing only, disable SSL verification
    # return clickhouse_connect.get_client(host=host, user=user, password=password, secure=True, verify=False)

    return clickhouse_connect.get_client(
        host=host, user=user, password=password, secure=True
    )


def get_clickhouse_client_environment() -> clickhouse_connect.driver.client.Client:
    for name, env_val in ENVS.items():
        if not env_val:
            raise ValueError(f"Missing environment variable {name}")
    return get_clickhouse_client(
        host=ENVS["CLICKHOUSE_ENDPOINT"],
        user=ENVS["CLICKHOUSE_USERNAME"],
        password=ENVS["CLICKHOUSE_PASSWORD"],
    )


def is_unix_timestamp(value: str) -> bool:
    """Check if the string is a valid Unix timestamp."""
    if value.isdigit():  # Ensure it's numeric
        try:
            timestamp = int(value)
            # Check if it's within a reasonable range (1970 to 2100)
            datetime.fromtimestamp(timestamp)
            return True
        except (ValueError, OSError):
            return False
    return False


def to_timestap_str(time: datetime) -> str:
    return str(int(time.timestamp()))


def write_to_file(data: Any, filename="", path=""):
    """
    Writes data to a specified file. If no path is provided, writes to the current directory.

    :param data: The content to write to the file.
    :param filename: The name of the file (default: 'output.txt').
    :param path: The directory where the file should be saved (default: current directory).
    """

    if not filename:
        filename = "output_snapshot.json"
    if not path:
        path = "."

    # Ensure the path exists
    os.makedirs(path, exist_ok=True)

    # Construct full file path
    file_path = os.path.join(path, filename)

    # Write data to file
    with open(file_path, "w", encoding="utf-8") as file:
        file.write(data)
    logger.info(f"File written to: {os.path.abspath(file_path)}")


# TODO(elainewy): Move this into seperate files
#  ---------  Github Config File Methods Start----
class LazyFileHistory:
    """
    Reads the content of a file from a GitHub repository on the version that it was closest to a specific time and date provided. It then caches the commits and file contents avoiding unnecessary requests to the GitHub API.
    All public methods are thread-safe.
    """

    def __init__(self, repo: Any, path: str) -> None:
        self.repo = repo
        self.path = path
        self._commits_cache = []
        self._content_cache = {}
        self._fetched_all_commits = False
        self._lock = threading.RLock()

    def get_version_close_to_timestamp(
        self, timestamp: str | datetime
    ) -> Optional[str]:
        try:
            with self._lock:
                if not isinstance(timestamp, datetime):
                    if is_unix_timestamp(timestamp):
                        timestamp = datetime.fromtimestamp(int(timestamp), timezone.utc)
                    else:
                        timestamp = parse(timestamp)
                logger.info(
                    f" [LazyFileHistory] Try fetch cached content for {self.repo} : {self.path} at {timestamp.isoformat()}"
                )
                commit = self._find_closest_before_or_equal_in_cache(timestamp)
                if commit:
                    return self._fetch_content_for_commit(commit)

                if not self._fetched_all_commits:
                    logger.info(
                        f" [LazyFileHistory] Nothing found in cache, fetching all commit includes {self.repo}/{self.path} close/equal to {timestamp.isoformat()}"
                    )
                    commit = self._fetch_until_timestamp(timestamp)
                    if commit:
                        return self._fetch_content_for_commit(commit)
                logger.info(
                    f" [LazyFileHistory] No config file found in cache and in commits for {self.repo}/{self.path}."
                )
                return None
        except Exception as e:
            logger.warning(
                f" [LazyFileHistory] Error fetching content for {self.repo} : {self.path} at {timestamp}: {e}"
            )
            return None

    def _fetch_until_timestamp(self, timestamp: datetime) -> Optional[str]:
        # call github api, with path parameter
        # Only commits containing this file path will be returned.
        all_commits = self.repo.get_commits(path=self.path)

        known_shas = {c.sha for c in self._commits_cache}

        newly_fetched = []

        for commit in all_commits:
            if commit.sha in known_shas:
                break
            newly_fetched.append(commit)

            if commit.commit.author.date.replace(tzinfo=timezone.utc) <= timestamp:
                break

        logger.info(f" [LazyFileHistory] Fetched new commits {len(newly_fetched)}")
        if len(newly_fetched) > 0:
            newly_fetched.sort(
                key=lambda c: c.commit.author.date.replace(tzinfo=timezone.utc)
            )
            logger.info(
                f" [LazyFileHistory] Fetched new commits with latest: {newly_fetched[-1].commit.author.date}, oldest:{newly_fetched[-1].commit.author.date}"
            )

        self._commits_cache.extend(newly_fetched)
        self._commits_cache.sort(
            key=lambda c: c.commit.author.date.replace(tzinfo=timezone.utc)
        )

        if not newly_fetched:
            self._fetched_all_commits = True

        return self._find_closest_before_or_equal_in_cache(timestamp)

    def _find_closest_before_or_equal_in_cache(
        self, timestamp: datetime
    ) -> Optional[str]:
        commits_before_equal = [
            c
            for c in self._commits_cache
            if c.commit.author.date.replace(tzinfo=timezone.utc) <= timestamp
        ]
        commits_before_equal.sort(
            key=lambda c: c.commit.author.date.replace(tzinfo=timezone.utc)
        )
        return commits_before_equal[-1] if commits_before_equal else None

    def _fetch_content_for_commit(self, commit: Any) -> str:
        if commit.sha not in self._content_cache:
            logger.info(
                f"Fetching content for {self.repo} : {self.path} at {commit.commit.author.date} - {commit.sha}"
            )
            # We can retrieve the file content at a specific commit
            file_content = self.repo.get_contents(
                self.path, ref=commit.sha
            ).decoded_content.decode()
            self._content_cache[commit.sha] = file_content
        return self._content_cache[commit.sha]


def explode_runner_variants(
    runner_configs: Dict[str, Dict[str, Any]]
) -> Dict[str, Dict[str, Any]]:
    runner_types_list = [i for i in runner_configs["runner_types"].items()]

    for runner, runner_config in runner_types_list:
        if "variants" in runner_config:
            for variant, variant_config in runner_config["variants"].items():
                if runner.startswith("lf."):
                    runner_without_lf = runner[3:]
                    variant_name = f"lf.{variant}.{runner_without_lf}"
                else:
                    variant_name = f"{variant}.{runner}"
                runner_configs["runner_types"][variant_name] = {
                    **runner_config,
                    **variant_config,
                }
    return runner_configs


def update_tags(
    runner_labels: Dict[str, Set[str]], machine_types: Iterable[str]
) -> None:
    """
    iterate through machine types from jobs, and update potential tags that it belongs to
    """
    for machine_type in machine_types:
        if not machine_type:
            continue
        runner_labels["all"].add(machine_type)
        if machine_type not in runner_labels["dynamic"]:
            if "ubuntu" in machine_type.lower():
                runner_labels["linux"].add(machine_type)
                runner_labels["github"].add(machine_type)
            else:
                runner_labels["other"].add(machine_type)


def create_runner_labels(
    runner_configs: Dict[str, Dict[str, Any]],
    lf_runner_configs: Dict[str, Dict[str, Any]],
) -> Dict[str, Set[str]]:
    """
    Create the runner_labels, that are groups of runners with some common characteristics that we might find relevant
    to view them in a group instead of individually.
    """
    runner_labels_dict = {
        "github": set(),  # provided by github
        "pet": set(),  # managed as pet instances
        "dynamic": set(),  # managed as auto-scaling instances
        "ephemeral": set(),  # auto-scaling instances that are ephemeral
        "nonephemeral": set(),  # auto-scaling instances that are not ephemeral
        "linux": set(),  # linux instances
        "linux-meta": set(),  # linux instances provided by meta
        "linux-lf": set(),  # linux instances provided by Linux Foundation
        "macos": set(),  # macos instances
        "macos-meta": set(),  # macos instances provided by meta
        "windows": set(),  # windows instances
        "windows-meta": set(),  # windows instances provided by meta
        "windows-lf": set(),  # windows instances provided by Linux Foundation
        "all": set(),  # all instances
        "lf": set(),  # instances managed by Linux Foundation
        "meta": set(),  # instances managed by meta
        "multi-tenant": set(),  # instances that are multi-tenant
        "other": set(),  # other instances
    }

    github_mac_runners = (
        "macos-12",
        "macos-12-xl",
        "macos-13-large",
        "macos-13-xl",
        "macos-13-xlarge",
        "macos-14-arm64",
        "macos-14-xlarge",
    )
    runner_labels_dict["github"].update(github_mac_runners)
    runner_labels_dict["macos"].update(github_mac_runners)

    meta_pet_mac_runners = (
        "macos-m1-12",
        "macos-m1-13",
        "macos-m1-14",
        "macos-m1-stable",
        "macos-m2-14",
        "macos-m2-15",
        "macos-m2-max",
    )
    runner_labels_dict["meta"].update(meta_pet_mac_runners)
    runner_labels_dict["macos"].update(meta_pet_mac_runners)
    runner_labels_dict["pet"].update(meta_pet_mac_runners)

    meta_pet_nvidia = (
        "linux.aws.a100",
        "linux.aws.h100",
    )
    runner_labels_dict["meta"].update(meta_pet_nvidia)
    runner_labels_dict["linux"].update(meta_pet_nvidia)
    runner_labels_dict["linux-meta"].update(meta_pet_nvidia)
    runner_labels_dict["pet"].update(meta_pet_nvidia)
    runner_labels_dict["multi-tenant"].update(meta_pet_nvidia)

    all_runners_configs = (
        runner_configs["runner_types"] | lf_runner_configs["runner_types"]
    )

    if len(all_runners_configs.keys()) == 0:
        raise ValueError(
            " [method: create_runner_labels] No runner labels found in the github config files, something is wrong, please investigate."
        )

    for runner, runner_config in all_runners_configs.items():
        runner_labels_dict["dynamic"].add(runner)

        if "is_ephemeral" in runner_config and runner_config["is_ephemeral"]:
            runner_labels_dict["ephemeral"].add(runner)
        else:
            runner_labels_dict["nonephemeral"].add(runner)

        if runner_config["os"].lower() == "linux":
            runner_labels_dict["linux"].add(runner)
        elif runner_config["os"].lower() == "windows":
            runner_labels_dict["windows"].add(runner)

    for runner, runner_config in runner_configs["runner_types"].items():
        runner_labels_dict["meta"].add(runner)

        if runner_config["os"].lower() == "linux":
            runner_labels_dict["linux-meta"].add(runner)
        elif runner_config["os"].lower() == "windows":
            runner_labels_dict["windows-meta"].add(runner)

    for runner, runner_config in lf_runner_configs["runner_types"].items():
        runner_labels_dict["lf"].add(runner)

        if runner_config["os"].lower() == "linux":
            runner_labels_dict["linux-lf"].add(runner)
        elif runner_config["os"].lower() == "windows":
            runner_labels_dict["windows-lf"].add(runner)
    return runner_labels_dict


def get_runner_config(
    retriever: LazyFileHistory, start_time: str | datetime
) -> Dict[str, Dict[str, Any]]:
    contents = retriever.get_version_close_to_timestamp(start_time)
    if contents:
        return explode_runner_variants(yaml.safe_load(contents))
    return {"runner_types": {}}


def get_config_retrievers(github_access_token: str) -> Dict[str, LazyFileHistory]:
    auth = Auth.Token(github_access_token)
    test_infra_repo = Github(auth=auth).get_repo("pytorch/test-infra")
    pytorch_repo = Github(auth=auth).get_repo("pytorch/pytorch")

    meta_runner_config_retriever = LazyFileHistory(
        test_infra_repo, ".github/scale-config.yml"
    )
    lf_runner_config_retriever = LazyFileHistory(
        test_infra_repo, ".github/lf-scale-config.yml"
    )
    old_lf_lf_runner_config_retriever = LazyFileHistory(
        pytorch_repo, ".github/lf-scale-config.yml"
    )

    return {
        "meta": meta_runner_config_retriever,
        "lf": lf_runner_config_retriever,
        "old_lf": old_lf_lf_runner_config_retriever,
    }


#  ---------  Github Config File Methods END----


class QueueTimeProcessor:
    """
    QueueTimeProcessor: generating histogram data for a time range [start_time, end_time]. It performs the following tasks:
        1. Retrieve snapshot of queuend jobs from the source table within the single time range.
        2. Generate histogram data group by job name.
        3. Assign runner labels to each histogram data based on machine type.

    To run the main method:
       processor = QueueTimeProcessor().process()
    """

    def __init__(
        self,
        is_dry_run: bool = False,
        local_output: bool = False,
        output_snapshot_file_name: str = "job_queue_times_snapshot",
        output_snapshot_file_path: str = "",
    ) -> None:
        self.is_dry_run = is_dry_run
        self.is_dry_run = is_dry_run
        self.output_snapshot_file_name = output_snapshot_file_name
        self.output_snapshot_file_path = output_snapshot_file_path
        self.local_output = local_output and is_dry_run

    def process(
        self,
        start_time: datetime,
        end_time: datetime,
        meta_runner_config_retriever,
        lf_runner_config_retriever,
        old_lf_lf_runner_config_retriever,
        cc: Optional[clickhouse_connect.driver.client.Client] = None,
        args: Optional[argparse.Namespace] = None,
        repo: str = "pytorch/pytorch",
    ) -> Dict[str, Any]:
        # ensure each thread has its own clickhouse client. clickhouse client is not thread-safe.
        if cc is None:
            tlocal = threading.local()
            if not hasattr(tlocal, "cc") or tlocal.cc is None:
                if args:
                    tlocal.cc = get_clickhouse_client(
                        args.clickhouse_endpoint,
                        args.clickhouse_username,
                        args.clickhouse_password,
                    )
                else:
                    tlocal.cc = get_clickhouse_client_environment()
            cc = tlocal.cc

        # fetches queued jobs at given time interval from db
        queued_jobs = self._fetch_snapshot_from_db(cc, start_time, end_time, repo)

        if len(queued_jobs) == 0:
            logger.info(
                f" [QueueTimeProcessor][Snapshot {to_timestap_str(end_time)}] No jobs in queue in time range: [{start_time},{end_time}]"
            )

        # add runner labels to each job based on machine type
        self._add_runner_labels(
            queued_jobs,
            start_time,
            meta_runner_config_retriever,
            lf_runner_config_retriever,
            old_lf_lf_runner_config_retriever,
        )

        if len(queued_jobs) == 0:
            logger.info(
                f" [QueueTimeProcessor][Snapshot {to_timestap_str(end_time)}] No queued jobs, skipping generating histogram records.."
            )

        records = QueuedJobHistogramGenerator().generate_histogram_records(
            queued_jobs,
            datetime.now(timezone.utc),
            "half-hour-mark-queue-time-histogram",
            end_time,
        )

        if len(records) == 0:
            logger.info(
                f" [QueueTimeProcessor][Snapshot {to_timestap_str(end_time)}] No histogram records, skipping writing.."
            )

        if self.is_dry_run:
            logger.info(
                f" [Dry Run Mode][Snapshot {to_timestap_str(end_time)}] Writing results to terminal/local file ..."
            )
            self._output_record(queued_jobs, end_time, type="queued_jobs")
            self._output_record(records, end_time, type="records")
            logger.info(
                f" [Dry Run Mode][Snapshot {to_timestap_str(end_time)}] Done. Write results to terminal/local file ."
            )
        else:
            self._write_to_db_table(cc, records)

        return {
            "start_time": to_timestap_str(start_time),
            "end_time": to_timestap_str(end_time),
            "jobs_count": len(queued_jobs),
            "records_count": len(records),
        }

    def _write_to_db_table(
        self, cc: clickhouse_connect.driver.client.Client, records: List[Dict[str, Any]]
    ):
        # TODO(elainewy): Change to misc.oss_ci_queue_time_histogram after testing is completed
        db_name = "fortesting"
        db_table_name = "oss_ci_queue_time_histogram"
        logger.info(f" Insert data to db table: {db_name}.{db_table_name}")
        if len(records) == 0:
            logger.info(f" No histogram records, skipping writing..")
            return
        columns = list(records[0].keys())
        data = [list(record.values()) for record in records]
        cc.insert(
            table=db_table_name,
            data=data,
            column_names=columns,
            database=db_name,
        )
        logger.info(f" done. Insert {len(data)} to db table: {db_name}.{db_table_name}")

    def _output_record(
        self,
        data: List[Dict[str, Any]],
        time: datetime,
        indent: Optional[int] = None,
        threshold: int = 10,
        limit: int = 2,
        type: str = "queued_job",
    ) -> None:
        """
        print the snapshot to local file or terminal for local test only
        """

        time_str = time.strftime("%Y-%m-%d_%H-%M-%S")
        file_name_with_time = f"{self.output_snapshot_file_name}_{type}_{time_str}.txt"
        if self.local_output:
            logger.info(
                f"[Dry Run Mode][Snapshot {to_timestap_str(time)}]: found {len(data)} records, outputing to file: {file_name_with_time}   "
            )
            write_to_file(
                json.dumps(data),
                file_name_with_time,
                self.output_snapshot_file_path,
            )
            return

        # otherwise, print to terminal
        if len(data) > threshold:
            logger.info(
                f" [Dry Run Mode][Snapshot {to_timestap_str(time)}]found {len(data)} records, print first {limit} in terminal. for full result, use local-output option"
            )
            logger.info(json.dumps(data[:limit], indent=indent))
        else:
            logger.info(
                f" [Dry Run Mode][Snapshot {to_timestap_str(time)}] Found {len(data)} records, print in terminal"
            )
            logger.info(json.dumps(data, indent=indent))

    def _fetch_snapshot_from_db(
        self,
        cc: clickhouse_connect.driver.client.Client,
        start_time: datetime,  # must be UTC
        end_time: datetime,  # must be UTC
        repo: str = "pytorch/pytorch",
    ) -> List[Dict[str, Any]]:
        """
        fetches queued jobs at given time range (start_time, end_time) from source table workflow_job:

            1. fetches jobs that are currently in queue but not being picked up by workers
            2. fetches jobs that were in queue but were picked up by workers later of given end_time
            3. fetches jobs that were in-queue but completed WITHIN given time range [start_time, end_time]
        """
        # clickhouse does not accept iso format, using timestamp instead
        start_timestamp = to_timestap_str(start_time)
        end_timestamp = to_timestap_str(end_time)

        logger.info(
            f" [Snapshot:{end_timestamp}] Logging interval info: [start_time: {start_time.isoformat()}({start_timestamp}), end_time: {end_time.isoformat()} ({end_timestamp})]"
        )

        logger.info(
            f" [Snapshot:{end_timestamp}] Start to fetch queued jobs in default.workflow_run ...."
        )

        # in given snapshot time, fetches jobs that were in queue but not being picked up by workers
        logger.info(
            f" [Snapshot:{end_timestamp}] Start to fetch jobs with `queued` status in default.workflow_run ...."
        )
        queued_query = self.get_query_statement_for_queueing_jobs(end_timestamp, repo)
        queued_jobs = self._query_in_queue_jobs(
            cc, queued_query["query"], queued_query["parameters"], ["queued"]
        )

        # in given snapshot end_timestamp, fetches jobs that were in queue but were picked up by workers later of given snapshot time
        # this happens when the snapshot time is not in latest timestamp
        logger.info(
            f" [Snapshot:{end_timestamp}] Start to fetch jobs with `completed` status but was in `queue` in default.workflow_run ...."
        )
        picked_query = self.get_query_statement_for_picked_up_job(end_timestamp, repo)
        picked_jobs = self._query_in_queue_jobs(
            cc, picked_query["query"], picked_query["parameters"], ["queued"]
        )

        # in given time range (start_timestamp, end_timestamp), fetches jobs that were in-queue but completed WITHIN given time range
        logger.info(
            f" [Snapshot:{end_timestamp}] Start to fetch jobs was in queueu and `completed` in [star_time, end_time] ...."
        )
        completed_within_interval_sql = self.get_query_statement_for_completed_jobs(
            start_timestamp, end_timestamp, repo
        )
        job_completed_within_interval = self._query_in_queue_jobs(
            cc,
            completed_within_interval_sql["query"],
            completed_within_interval_sql["parameters"],
            ["completed"],
        )

        logger.info(
            f" [Snapshot:{end_timestamp}].done. Time Range[`{start_time.isoformat()}` to `{end_time.isoformat()}`] Found {len(queued_jobs)} jobs still has queued status, and {len(picked_jobs)} jobs was has queue status but picked up by runners later, and  {len(job_completed_within_interval)} jobs completed within given time range"
        )
        result = queued_jobs + picked_jobs + job_completed_within_interval

        return result

    def _add_runner_labels(
        self,
        jobs: List[Dict[str, Any]],
        start_time: datetime,
        meta_runner_config_retriever,
        lf_runner_config_retriever,
        old_lf_lf_runner_config_retriever,
    ) -> None:
        # create dictionary of tags with set of targeting machine types
        lf_runner_config = get_runner_config(lf_runner_config_retriever, start_time)
        if not lf_runner_config or not lf_runner_config["runner_types"]:
            lf_runner_config = get_runner_config(
                old_lf_lf_runner_config_retriever, start_time
            )
        runner_labels = create_runner_labels(
            get_runner_config(meta_runner_config_retriever, start_time),
            lf_runner_config,
        )
        update_tags(runner_labels, set([job["machine_type"] for job in jobs]))

        # for debugging
        #  serialized_data = {k: list(v) for k, v in runner_labels.items()}
        # logger.info(f"list runner_labels\n {json.dumps(serialized_data, indent=4)}")

        # iterates throught jobs, and update tags for each job
        for job in jobs:
            job_labels = []
            for tag in runner_labels:
                if job["machine_type"] in runner_labels[tag]:
                    job_labels.append(tag)
            job["runner_labels"] = job_labels

    def _query_in_queue_jobs(
        self,
        cc: clickhouse_connect.driver.client.Client,
        queryStr: str,
        parameters: Any,
        tags: List[str] = [],
    ) -> list[dict[str, Any]]:
        """
        post query process to remove duplicated jobs
        this is bc clickhouse client returns duplicated jobs for some reason
        """
        seen = set()
        db_resp = self._query(cc, queryStr, parameters)
        result = []
        for record in db_resp:
            if record["html_url"] in seen:
                continue
            seen.add(record["html_url"])

            record["tags"] = tags
            result.append(record)
        return result

    def _query(
        self, cc: clickhouse_connect.driver.client.Client, query, params={}
    ) -> list[dict[str, Any]]:
        reader = cc.query(query, params)
        # clickhouse returns a generator to return column names and rows
        # see https://clickhouse.com/docs/integrations/python#the-queryresult-object
        column_names = reader.column_names
        rows = reader.result_rows
        res = self._to_query_result_dict(rows, column_names)
        return res

    def _to_query_result_dict(
        self, rows: list[Any], column_names: list[str]
    ) -> list[dict[str, Any]]:
        li = []
        for row in rows:
            record = {}
            for idx, name in enumerate(column_names):
                record[name] = row[idx]
            li.append(record)
        return li

    def _get_query_template(self):
        _in_queue_job_select_statement = """
            SELECT
                DATE_DIFF(
                    'second',
                    job.created_at,
                    {end_timestamp:DateTime}
                ) AS queue_s,
                workflow.repository.'full_name' AS repo,
                workflow.name AS workflow_name,
                job.name AS job_name,
                job.html_url,
                toUnixTimestamp(job.created_at) AS queue_start_at,
                toUnixTimestamp(job.started_at) AS queue_stop_at,
                IF(
                    LENGTH(job.labels) = 0,
                    'N/A',
                    IF(
                        LENGTH(job.labels) > 1,
                        job.labels[2],
                        job.labels[1]
                    )
                ) AS machine_type,
                toUnixTimestamp({end_timestamp:DateTime}) AS time
            FROM
                default.workflow_job job FINAL
                JOIN default.workflow_run workflow FINAL ON workflow.id = job.run_id
            """
        return _in_queue_job_select_statement

    def get_query_statement_for_completed_jobs(
        self, start_timestamp: str, end_timestamp: str, repo: str = "pytorch/pytorch"
    ):
        """
        this query is used to get jobs that were in queue within given time range, and completed
        """
        s11 = """
        WITH possible_queued_jobs AS (
            SELECT
                id,
                run_id,
            FROM default.workflow_job -- FINAL not needed since we just use this to filter a table that has already been FINALed
            WHERE
                started_at > ({start_timestamp:DateTime})
                AND started_at <= ({end_timestamp:DateTime})
                AND created_at < ({start_timestamp:DateTime}  - INTERVAL 20 SECOND)
                AND created_at > ({start_timestamp:DateTime} - INTERVAL 1 WEEK)
        )
        """

        s12 = """
        WHERE
            job.id IN (SELECT id FROM possible_queued_jobs)
            AND workflow.id IN (SELECT run_id FROM possible_queued_jobs)
            AND workflow.repository.'full_name' = {repo:String}
            AND LENGTH(job.steps) != 0
            AND job.status = 'completed'
        ORDER BY
            queue_s DESC
        """

        query = s11 + self._get_query_template() + s12
        parameters = {
            "start_timestamp": start_timestamp,
            "end_timestamp": end_timestamp,
            "repo": repo,
        }
        return {
            "query": query,
            "parameters": parameters,
        }

    def get_query_statement_for_picked_up_job(
        self, time: str, repo: str = "pytorch/pytorch"
    ):
        """
        this query is used to get jobs that were in queue in given snapshot time, but were picked up by workers later
        """
        s1 = """
        WITH possible_queued_jobs AS (
            SELECT
                id,
                run_id,
                started_at,
                created_at
            FROM default.workflow_job -- FINAL not needed since we just use this to filter a table that has already been FINALed
            WHERE
                started_at > ({end_timestamp:DateTime})
                AND created_at < ({end_timestamp:DateTime} - INTERVAL 20 SECOND)
                AND created_at > ({end_timestamp:DateTime} - INTERVAL 1 WEEK)
        )"""

        s2 = """
        WHERE
            job.id IN (SELECT id FROM possible_queued_jobs)
            AND workflow.id IN (SELECT run_id FROM possible_queued_jobs)
            AND workflow.repository.'full_name' = {repo:String}
            AND job.status = 'completed'
            AND LENGTH(job.steps) != 0
        ORDER BY
            queue_s DESC
        """
        query = s1 + self._get_query_template() + s2
        parameters = {
            "end_timestamp": time,
            "repo": repo,
        }
        return {
            "query": query,
            "parameters": parameters,
        }

    def get_query_statement_for_queueing_jobs(
        self, time: str, repo: str = "pytorch/pytorch"
    ) -> Dict[str, Any]:
        """
        this query is used to get jobs that werre in queue in given snapshot time, and not being picked up by workers
        """
        s1 = """
        WITH possible_queued_jobs AS (
            SELECT
                id,
                run_id,
                started_at,
                created_at
            FROM default.workflow_job -- FINAL not needed since we just use this to filter a table that has already been FINALed
            WHERE
                status = 'queued'
                AND created_at < ({end_timestamp:DateTime} - INTERVAL 20 SECOND)
                AND created_at > ({end_timestamp:DateTime} - INTERVAL 1 WEEK)
        )
        """
        s2 = """
        WHERE
            job.id IN (SELECT id FROM possible_queued_jobs)
            AND workflow.id IN (SELECT run_id FROM possible_queued_jobs)
            AND workflow.repository.'full_name' = {repo:String}
            AND job.status = 'queued'
            AND LENGTH(job.steps) = 0
            AND workflow.status != 'completed'
        ORDER BY
            queue_s DESC
        """
        query = s1 + self._get_query_template() + s2
        parameters = {
            "end_timestamp": time,
            "repo": repo,
        }
        return {
            "query": query,
            "parameters": parameters,
        }


class QueuedJobHistogramGenerator:
    def __init__(self) -> None:
        self.metadata_field_list = [
            "repo",
            "time",
            "workflow_name",
            "job_name",
            "machine_type",
            "runner_labels",
        ]
        self.metrics_field_list = [
            "histogram",
            "total_count",
            "max_queue_time",
            "avg_queue_time",
        ]
        self.secs_for_one_hour = 3600

    def generate_histogram_records(
        self,
        queued_jobs: List[Dict[str, Any]],
        created_time: datetime,
        type: str,
        snapshot_time: datetime,
    ) -> List[Dict[str, Any]]:
        logger.info(
            f" [QueuedJobHistogramGenerator][Snapshot{to_timestap_str(snapshot_time)}] start to generate histogram db records ......"
        )
        if len(queued_jobs) == 0:
            logger.info(
                f" [QueuedJobHistogramGenerator][Snapshot{to_timestap_str(snapshot_time)}] no records found, skipping histogram records generation......"
            )
            return []

        dicts = self._group_by_job_name(queued_jobs)
        job_queue_map = dicts["job_queue"]
        metadata_map = dicts["metadata"]

        logger.info(
            f" [QueuedJobHistogramGenerator][Snapshot{to_timestap_str(snapshot_time)}] generating {len(list(job_queue_map.keys()))}jobs ......"
        )
        records = []
        for job_name, job_queues in job_queue_map.items():
            metrics = self._get_metrics(job_queues)
            metadata = metadata_map[job_name]
            record = self._form_database_record_v1_0(
                created_time, snapshot_time, type, metadata, metrics
            )
            records.append(record)
        logger.info(
            f" [QueuedJobHistogramGenerator][Snapshot{to_timestap_str(snapshot_time)}] Done. generated {len(records)} histogram db records ......"
        )
        return records

    def _get_metrics(self, job_queues: List[Dict[str, Any]]) -> Dict[str, Any]:
        histogram = self._to_job_exponential_histgram(job_queues)
        qs_list = [job["queue_s"] for job in job_queues]
        max_queue_time = max(qs_list)
        total_queue_time = sum(qs_list)
        total_count = len(job_queues)
        avg_queue_time = total_queue_time // total_count

        return {
            "histogram": histogram,
            "total_count": total_count,
            "max_queue_time": max_queue_time,
            "avg_queue_time": avg_queue_time,
        }

    def _form_database_record_v1_0(
        self,
        created_time: datetime,
        snapshot_time: datetime,
        type: str,
        metadata: Dict[str, Any],
        metrics: Dict[str, Any],
    ):
        histogram_version = "1.0"
        return {
            "created_time": int(created_time.timestamp()),
            "histogram_version": histogram_version,
            "type": type,
            "repo": metadata["repo"],
            "time": metadata["time"],
            "workflow_name": metadata["workflow_name"],
            "job_name": metadata["job_name"],
            "machine_type": metadata["machine_type"],
            "histogram": metrics["histogram"],
            "total_count": metrics["total_count"],
            "max_queue_time": metrics["max_queue_time"],
            "avg_queue_time": metrics["avg_queue_time"],
            "runner_labels": metadata.get("runner_labels", []),
            "extra_info": {},
        }

    def _to_job_exponential_histgram(self, job_queue: List[Dict[str, Any]]):
        """
        generate exponential histogram, it contains queue time:
                - 1 min - 60 min:[60 buckets]  queue time location rule: [qt<=1min, 1min<qt<=2mins, .... 58<qt<=59mins, 59mins<qt<=60mins]
                - 1 hr - 24 hrs  [23 buckets]  queue time location rule: [1hr< qt<=2hrs, 2hrs< qt <=3hrs,..., 22hrs< qt <=23hrs, 23hrs< qt <=24hrs]
                - 1 day - 7days[7 buckets] queue time location rule:     [1day< qt <=2days, 2days< qt <=3days,..., 6days< qt <=7days, qt > 7days]
        """
        minutes_bucket = [0 for i in range(60)]
        hours_bucket = [0 for i in range(23)]
        days_bucket = [0 for i in range(7)]

        one_hour_divider = self.secs_for_one_hour
        one_day_divider = self.secs_for_one_hour * 24
        seven_days_divider = self.secs_for_one_hour * 24 * 7

        for qj in job_queue:
            qs = qj["queue_s"]
            if qs <= one_hour_divider:
                if qs == 0:
                    url = qj["html_url"]
                    logger.warning(
                        f"expect queue time at least 1 secs, but found 0 for queue_s {url}, please investigate"
                    )
                    continue
                bucket_index = (qs - 1) // 60
                minutes_bucket[bucket_index] += 1
            elif qs <= one_day_divider:
                bucket_index = (qs - one_hour_divider - 1) // self.secs_for_one_hour
                hours_bucket[bucket_index] += 1
            elif qs <= seven_days_divider:
                bucket_index = (qs - one_day_divider - 1) // (
                    self.secs_for_one_hour * 24
                )
                days_bucket[bucket_index] += 1
            else:
                bucket_index = 6
                days_bucket[bucket_index] += 1
        return minutes_bucket + hours_bucket + days_bucket

    def _group_by_job_name(self, queued_jobs: List[Dict[str, Any]]) -> Dict[str, Any]:
        job_queue_s = defaultdict(list)
        metadata = defaultdict(dict)
        for qj in queued_jobs:
            job_name = qj["job_name"]
            job_queue_s[qj["job_name"]].append(
                {
                    "html_url": qj["html_url"],
                    "queue_s": qj["queue_s"],
                }
            )
            if job_name not in metadata:
                metadata[job_name] = self._to_histogram_metadata(qj)
        return {"job_queue": job_queue_s, "metadata": metadata}

    def _to_histogram_metadata(self, qj: Dict[str, Any]):
        metadata = {}
        for field in self.metadata_field_list:
            if field not in qj:
                logger.warning(
                    f"required field `{field}` is missing in queued job data, please investigate"
                )
                continue
            metadata[field] = qj[field]
        return metadata


class WorkerPoolHandler:
    """
    WorkerPoolHandler runs workers in parallel to generate queue time histograms and writes the results to the target destination.
    It performs the following tasks:
     1. Uses a thread pool to generate histogram data for specified intervals.
     2. process the results for all intervals from the thread pool.
    """

    def __init__(
        self,
        retrievers: Dict[str, LazyFileHistory],
        queue_time_processor: QueueTimeProcessor,
        max_workers: int = 4,
    ):
        self.retrievers = retrievers
        self.queue_time_processor = queue_time_processor
        self.max_workers = max_workers

    def start(
        self,
        time_intervals: List[List[datetime]],
        args: Optional[argparse.Namespace] = None,
    ) -> None:
        logger.info(
            f" [WorkerPoolHandler] start to process queue time data with {len(time_intervals)} jobs and {self.max_workers} max num of workers..."
        )
        if len(time_intervals) == 0:
            logger.info(" no time intervals to process, exiting...")
            return
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = []
            for interval in time_intervals:
                future = executor.submit(
                    self.queue_time_processor.process,
                    interval[0],  # start_timestamp
                    interval[1],  # end_timestamp
                    self.retrievers["meta"],
                    self.retrievers["lf"],
                    self.retrievers["old_lf"],
                    cc=None,
                    args=args,
                )
                futures.append(future)
        results = []
        errors = []

        # handle results from parallel processing
        for future in as_completed(futures):
            try:
                result = future.result()  # This will raise an exception if one occurred
                results.append(result)
            except Exception as e:
                logger.warning(f"Error processing future: {e}")
                errors.append({"error": str(e)})
        logger.info(
            f" [WorkerPoolHandler] done. total works: {len(time_intervals)}, success: {len(results)}, failure:{len(errors)}"
        )

        if len(errors) > 0:
            logger.warning(
                f" [Failure][WorkerPoolHandler] Errors occurred while processing futures: {errors}, investigation is needed"
            )


class TimeIntervalGenerator:
    """
    TimeIntervalGenerator:
        calculates time intervals between the source table (workflow_job table) and the target table (histogram table).
        It retrieves the latest timestamps from both tables and determines the most recent half-hour mark.If a time gap
        exists, it generates the necessary intervals. Currently, the interval length is set to 30 minutes.
        This generator is essential because data ingestion into the source table can be delayed within the desired time range due
        to the nature of the GitHub data pipeline.

        Ex:
        source table: 2023-10-01 10:12, target table: 2023-10-01 9:00 ->  output 2 intervals: [[2023-10-01 9:00,  2023-10-01 9:30], [2023-10-01 9:30,  2023-10-01 10:00]]
        source table: 2025-10-01 10:45, target table: 2023-10-01 10:00 -> output 1 intervals: [[2023-10-01 10:00,  2023-10-01 10:30]]
        source table: 2025-10-01 10:45, target table: 2023-10-01 10:30 -> output 0 intervals: [] empty, since things are in sync at 10:30
    """

    def __init__(self):
        pass

    def generate(self, clickhouse_client: clickhouse_connect.driver.client.Client):
        logger.info(" [TimeIntervalGenerator] Start to generate time intervals...")
        utc_now = datetime.now(timezone.utc)
        logger.info(f" Current time (UTC) is {utc_now}")

        # get latest time from histogram table, and find the half-hour mark
        # Ex: 8:45am -> 8:30am, 11:15pm -> 11:00pm
        lastest_time_histogram = self.get_latest_queue_time_histogram_table(
            clickhouse_client
        )
        lastest_time_histogram_dt = self._to_date_time(
            lastest_time_histogram, timezone=timezone.utc
        )
        target_mark_datetime = self._to_half_hour_mark(lastest_time_histogram_dt)
        logger.info(
            f" Done. parse lastest time from histogram table: {lastest_time_histogram} (UTC:{lastest_time_histogram_dt}). Half-hour time (UTC): {target_mark_datetime}"
        )

        # get latest time from workflow_job table, and find the half-hour mark
        lastest_time_workflow_job = self.get_latest_time_workflow_job_table(
            clickhouse_client
        )
        lastest_time_workflow_job_dt = self._to_date_time(
            lastest_time_workflow_job, timezone=timezone.utc
        )
        src_mark_datetime = self._to_half_hour_mark(lastest_time_workflow_job_dt)
        logger.info(
            f" Done. parse lastest time from workflow_job table: {lastest_time_workflow_job} (UTC format:{lastest_time_workflow_job_dt}). Half-hour mark (UTC): {src_mark_datetime}"
        )

        intervals = self._generate_intervals(target_mark_datetime, src_mark_datetime)

        # TODO(elainewy): add logic to investigate if any interval already existed in db, skip.
        logger.info(
            f" [TimeIntervalGenerator] Done. generate {len(intervals)} intervals between [{target_mark_datetime},{src_mark_datetime}]"
        )
        return intervals

    def _to_date_time(
        self, time: str | datetime | int | float, timezone=timezone.utc
    ) -> datetime:
        """
        convert time item to datetime with specified timezone.
        accept:
           - unix timestamp (int | float | str)
           - datetime (datetime | str)
        """
        if isinstance(time, int):
            time = datetime.fromtimestamp(time, timezone)
        elif isinstance(time, float):
            time = datetime.fromtimestamp(int(time), timezone)
        elif isinstance(time, str):
            if is_unix_timestamp(time):
                time = datetime.fromtimestamp(int(time), timezone)
            else:
                time = parse(time)
        time = time.replace(tzinfo=timezone)
        return time

    def _to_half_hour_mark(self, time: datetime) -> datetime:
        """
        convert datetime to its previous half-hour mark. Either 00:00 or 30:00
        """
        minutes = (time.minute // 30) * 30
        return time.replace(minute=minutes, second=0, microsecond=0)

    def _generate_intervals(
        self, start_time: datetime, end_time: datetime, maximum_intervals: int = 150
    ):
        if self._is_unix_epoch(end_time):
            raise Exception(
                f"end_time {end_time} is unixstamp 0, please check the input time"
            )

        if end_time <= start_time:
            logger.info(
                f" skip generating intervals. end_time `{end_time}` is earlier than or equal to start_time `{start_time}`"
            )
            return []

        if self._is_unix_epoch(start_time):
            # find closest :00 and :30 time from source table
            # then find previous half-hour closest to the end_time
            generated_start_time = end_time - timedelta(minutes=30)
            logger.info(
                f"  [Initialization] start_time is unix timestamp 0. Generating interval from workflow_job table: [{generated_start_time}, {end_time}]"
            )
            return [[generated_start_time, end_time]]

        num_of_half_hours = int((end_time - start_time).total_seconds() / 1800)
        if num_of_half_hours > maximum_intervals:
            raise ValueError(
                f" the intervals with length {num_of_half_hours} is greater than maximum_intervals {maximum_intervals}, investigation is needed and run generator manually"
            )

        return [
            [
                start_time + timedelta(minutes=30 * i),
                start_time + timedelta(minutes=30 * (i + 1)),
            ]
            for i in range(num_of_half_hours)
        ]

    def _is_unix_epoch(self, dt: datetime):
        # Compare against Unix epoch (1970-01-01 00:00:00 UTC)
        return int(dt.timestamp()) == 0

    def get_latest_queue_time_histogram_table(
        self,
        cc: clickhouse_connect.driver.client.Client,
    ) -> str:
        query = """
        SELECT toUnixTimestamp(MAX(time)) as latest FROM fortesting.oss_ci_queue_time_histogram
        """
        logger.info(
            " Getting lastest timestamp from fortesting.oss_ci_queue_time_histogram...."
        )
        res = cc.query(query, {})

        if res.row_count != 1:
            raise ValueError(
                f" [get_latest_queue_time_histogram_table] Expected 1 row, got {res.row_count}"
            )
        if len(res.column_names) != 1:
            raise ValueError(
                f" [get_latest_queue_time_histogram_table] Expected 1 column, got {str(len(res.column_names))}"
            )
        return res.result_rows[0][0]

    def get_latest_time_workflow_job_table(
        self, cc: clickhouse_connect.driver.client.Client
    ) -> str:
        logger.info(" Getting lastest timestamp from default.workflow_job...")
        query = """
        SELECT toUnixTimestamp(GREATEST(MAX(created_at), MAX(started_at))) AS latest from default.workflow_job
        """
        res = cc.query(query, {})

        if res.row_count != 1:
            raise ValueError(
                f" [get_latest_time_workflow_job_table] Expected 1 row, got {res.row_count}"
            )
        if len(res.column_names) != 1:
            raise ValueError(
                f" [get_latest_time_workflow_job_table] Expected 1 column, got {str(len(res.column_names))}"
            )

        return res.result_rows[0][0]


def main(
    args: Optional[argparse.Namespace] = None,
    github_access_token: str = "",
    is_dry_run: bool = False,
    local_output: bool = False,
    output_snapshot_file_name: str = "job_queue_times_snapshot",
    output_snapshot_file_path: str = "",
):
    """
    Main method to run in both local environment and lambda handler.
       1. generate intervals[start_time,end_time] using latest timestamp from source table and target table
       2. call WorkerPoolHandler to geneterate and write histogram data for each interval in parallel
    """
    # gets config retrievers, this is used to generate runner labels for histgram
    if not github_access_token:
        raise ValueError("Missing environment variable GITHUB_ACCESS_TOKEN")
    config_retrievers = get_config_retrievers(github_access_token)

    # get time intervals.
    logger.info(f" [Main] generating time intervals ....")
    if args:
        cc = get_clickhouse_client(
            args.clickhouse_endpoint, args.clickhouse_username, args.clickhouse_password
        )
    else:
        cc = get_clickhouse_client_environment()
    time_intervals = TimeIntervalGenerator().generate(cc)

    if len(time_intervals) == 0:
        logger.info(" [Main] No time intervals to process, exiting...")
        return

    # get jobs in queue from clickhouse for list of time intervals, in parallel
    handler = WorkerPoolHandler(
        config_retrievers,
        QueueTimeProcessor(
            is_dry_run=is_dry_run,
            local_output=local_output,
            output_snapshot_file_name=output_snapshot_file_name,
            output_snapshot_file_path=output_snapshot_file_path,
        ),
    )
    handler.start(time_intervals, args)
    logger.info(f" [Main] Done. work completed.")


def lambda_handler(event: Any, context: Any) -> None:
    """
    Main method to run in aws lambda environment
    """
    main(
        None,
        github_access_token=ENVS["GITHUB_ACCESS_TOKEN"],
    )
    return


def parse_args() -> argparse.Namespace:
    """
    Parse command line args, this is mainly used for local test environment.
    """
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--clickhouse-endpoint",
        default=ENVS["CLICKHOUSE_ENDPOINT"],
        type=str,
        help="the clickhouse endpoint, the clickhouse_endpoint name is  https://{clickhouse_endpoint}:{port} for full url ",
    )
    parser.add_argument(
        "--clickhouse-username",
        type=str,
        default=ENVS["CLICKHOUSE_USERNAME"],
        help="the clickhouse username",
    )
    parser.add_argument(
        "--clickhouse-password",
        type=str,
        default=ENVS["CLICKHOUSE_PASSWORD"],
        help="the clickhouse password for the user name",
    )
    parser.add_argument(
        "--github-access-token",
        type=str,
        default=ENVS["GITHUB_ACCESS_TOKEN"],
        help="the github access token to access github api",
    )
    parser.add_argument(
        "--local-output",
        action="store_true",
        help="when set, generate json result in local environment. this is only used for local test environment when dry-run is enabled",
    )
    parser.add_argument(
        "--not-dry-run",
        action="store_true",
        help="when set, writing results to destination from local environment. By default, we run in dry-run mode for local environment",
    )
    parser.add_argument(
        "--output-file-name",
        type=str,
        default="job_queue_times_snapshot.json",
        help="the name of output file for local environment. this is only used for local test environment when local-output is enabled",
    )
    parser.add_argument(
        "--output-file-path",
        type=str,
        default="",
        help="the path of output file for local environment. this is only used for local test environment when local-output is enabled",
    )
    args, _ = parser.parse_known_args()
    return args


def local_run() -> None:
    """
    method to run in local test environment
    """

    args = parse_args()

    # update environment variables for input parameters

    # always run in dry-run mode in local environment, unless it's disabled.
    is_dry_run = not args.not_dry_run

    main(
        args,
        args.github_access_token,
        is_dry_run=is_dry_run,
        local_output=args.local_output,
        output_snapshot_file_name=args.output_file_name,
        output_snapshot_file_path=args.output_file_path,
    )


if __name__ == "__main__":
    local_run()
