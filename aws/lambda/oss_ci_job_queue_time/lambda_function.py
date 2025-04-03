#!/usr/bin/env python
import argparse
import io
import json
import logging
from math import e
import os
import gzip
import re
import threading
import yaml
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3  # type: ignore[import]
import clickhouse_connect
from datetime import date, datetime, timezone, timedelta

# Local imports
from functools import lru_cache
from logging import info, warning
from typing import Any, Optional, Dict, Set, Iterable, List, Tuple
from github import Github, Auth
from dateutil.parser import parse

unix_timestamp_0 = datetime(1970, 1, 1, tzinfo=timezone.utc)

ENVS = {
    "GITHUB_ACCESS_TOKEN": os.getenv("GITHUB_ACCESS_TOKEN", ""),
    "CLICKHOUSE_ENDPOINT": os.getenv("CLICKHOUSE_ENDPOINT", ""),
    "CLICKHOUSE_PASSWORD": os.getenv("CLICKHOUSE_PASSWORD", ""),
    "CLICKHOUSE_USERNAME": os.getenv("CLICKHOUSE_USERNAME,"),
}

logging.basicConfig(level=logging.INFO)
_bucket_name = "ossci-raw-job-status"


@lru_cache()
def get_clickhouse_client(host: str, user: str, password: str) -> Any:
    # for local testing only, disable SSL verification
    return clickhouse_connect.get_client(
        host=host, user=user, password=password, secure=True, verify=False
    )

    return clickhouse_connect.get_client(
        host=host, user=user, password=password, secure=True
    )


@lru_cache()
def get_aws_s3_resource() -> Any:
    return boto3.resource("s3")


def get_clickhouse_client_environment() -> Any:
    info(f"Getting environment variables {ENVS}")
    for name, env_val in ENVS.items():
        if not env_val:
            raise ValueError(f"Missing environment variable {name}")

    return get_clickhouse_client(
        host=ENVS["CLICKHOUSE_ENDPOINT"],
        user=ENVS["CLICKHOUSE_USERNAME"],
        password=ENVS["CLICKHOUSE_PASSWORD"],
    )


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
    info(f"File written to: {os.path.abspath(file_path)}")


def upload_to_s3_txt(
    s3_client: Any,
    bucket_name: str,
    key: str,
    records: list[dict[str, Any]],
) -> None:
    info(f"Writing {len(records)} documents to S3 {bucket_name}/{key}")
    body = io.StringIO()
    for record in records:
        json.dump(record, body)
        body.write("\n")

    s3_client.Object(
        f"{bucket_name}",
        f"{key}",
    ).put(
        Body=gzip.compress(body.getvalue().encode()),
        ContentEncoding="gzip",
        ContentType="text/plain",
    )
    info(f"Done! Finish writing document to S3 {bucket_name}/{key} ")


# TODO(elainewy): Move this into seperate files
#  ---------  Github Config File Methods Start----
class LazyFileHistory:
    """
    Reads the content of a file from a GitHub repository on the version that it was on a specific time and date provided. It then caches the commits and file contents avoiding unnecessary requests to the GitHub API.
    All public methods are thread-safe.
    """

    def __init__(self, repo: Any, path: str) -> None:
        self.repo = repo
        self.path = path
        self._commits_cache = []
        self._content_cache = {}
        self._fetched_all_commits = False
        self._lock = threading.RLock()

    def get_version_after_timestamp(self, timestamp: str | datetime) -> Optional[str]:
        try:
            with self._lock:
                if not isinstance(timestamp, datetime):
                    if timestamp.isdigit():
                        timestamp = datetime.fromtimestamp(
                            int(timestamp), tz=timezone.utc
                        )
                    else:
                        timestamp = parse(timestamp)
                commit = self._find_earliest_after_in_cache(timestamp)
                if commit:
                    return self._fetch_content_for_commit(commit)

                if not self._fetched_all_commits:
                    commit = self._fetch_until_timestamp(timestamp)
                    if commit:
                        return self._fetch_content_for_commit(commit)
        except Exception as e:
            warning(
                f"Error fetching content for {self.repo} : {self.path} at {timestamp}: {e}"
            )

        return None

    def _find_earliest_after_in_cache(self, timestamp: datetime) -> Optional[str]:
        commits_after = [
            c for c in self._commits_cache if c.commit.author.date > timestamp
        ]

        if not commits_after:
            return None
        return commits_after[-1]

    def _fetch_until_timestamp(self, timestamp: datetime) -> Optional[str]:
        all_commits = self.repo.get_commits(path=self.path)
        known_shas = {c.sha for c in self._commits_cache}

        newly_fetched = []

        for commit in all_commits:
            if commit.sha in known_shas:
                break
            newly_fetched.append(commit)

            if commit.commit.author.date <= timestamp:
                break

        self._commits_cache.extend(newly_fetched)
        self._commits_cache.sort(key=lambda c: c.commit.author.date, reverse=True)

        if not newly_fetched:
            self._fetched_all_commits = True

        return self._find_earliest_after_in_cache(timestamp)

    def _fetch_content_for_commit(self, commit: Any) -> str:
        if commit.sha not in self._content_cache:
            info(
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
        warning(
            " No runners found in the github config files, something is wrong, please investigate."
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
    contents = retriever.get_version_after_timestamp(start_time)
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
    generating histogram data for queue times. It performs the following tasks:
        1. Retrieves jobs from the source table within a specified time range.
        2. Generates histogram data categorized by job name.
        3. Assigns runner labels to each histogram data based on machine type.

    To run the main method:
       processor = QueueTimeProcessor(clickhouse_client,s3_client).process()
    """

    def __init__(
        self,
        clickhouse_client: Any,
        s3_client: Any,
        is_dry_run: bool = False,
    ) -> None:
        self.clickhouse_client = clickhouse_client
        self.s3_client = s3_client
        self.is_dry_run = is_dry_run

    def process(
        self,
        start_time: datetime,
        end_time: datetime,
        meta_runner_config_retriever,
        lf_runner_config_retriever,
        old_lf_lf_runner_config_retriever,
        repo: str = "pytorch/pytorch",
    ) -> Dict[str, Any]:
        # fetches queued jobs at given time interval from db
        queued_jobs = self._fetch_snapshot_from_db(start_time, end_time, repo)

        if len(queued_jobs) == 0:
            info(f" No jobs in queue in time range: [{start_time},{end_time}]")

        # add runner labels to each job based on machine type
        self._add_runner_labels(
            queued_jobs,
            start_time,
            meta_runner_config_retriever,
            lf_runner_config_retriever,
            old_lf_lf_runner_config_retriever,
        )
        return {
            "start_time": int(start_time.timestamp()),
            "end_time": int(end_time.timestamp()),
            "queued_jobs": queued_jobs,
        }

    def _fetch_snapshot_from_db(
        self,
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
        start_timestamp = str(int(start_time.timestamp()))
        end_timestamp = str(int(end_time.timestamp()))

        info(
            f" [start_time: {start_time.isoformat()}({start_timestamp}), end_time: {end_time.isoformat()} ({end_timestamp})]: Start to fetch queued jobs in default.workflow_run ...."
        )

        # in given snapshot time, fetches jobs that were in queue but not being picked up by workers
        info(
            f" [Snapshot:{end_timestamp}]Start to fetch jobs with `queued` status in default.workflow_run ...."
        )
        queued_query = self.get_query_statement_for_queueing_jobs(end_timestamp, repo)
        queued_jobs = self._query_in_queue_jobs(
            queued_query["query"], queued_query["parameters"], ["queued"]
        )

        # in given snapshot end_timestamp, fetches jobs that were in queue but were picked up by workers later of given snapshot time
        # this happens when the snapshot time is not in latest timestamp
        info(
            f" [Snapshot:{end_timestamp}] start to fetch jobs with `completed` status but was in `queue` in default.workflow_run ...."
        )
        picked_query = self.get_query_statement_for_picked_up_job(end_timestamp, repo)
        picked_jobs = self._query_in_queue_jobs(
            picked_query["query"], picked_query["parameters"], ["queued"]
        )

        # in given time range (start_timestamp, end_timestamp), fetches jobs that were in-queue but completed WITHIN given time range
        info(
            f" [Snapshot:{end_timestamp}]start to fetch jobs was in queueu and `completed` in [star_time, end_time] ...."
        )
        completed_within_interval_sql = self.get_query_statement_for_completed_jobs(
            start_timestamp, end_timestamp, repo
        )
        job_completed_within_interval = self._query_in_queue_jobs(
            completed_within_interval_sql["query"],
            completed_within_interval_sql["parameters"],
            ["completed"],
        )

        info(
            f" [Snapshot:{end_timestamp}].done. Time Range[`{start_time.isoformat()}` to `{end_time.isoformat()}`] Found {len(queued_jobs)} jobs still has queued status, and {len(jobs_pick)} jobs was has queue status but picked up by runners later, and  {len(job_completed_within_interval)} jobs completed within given time range"
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
        # info(f"list runner_labels\n {json.dumps(serialized_data, indent=4)}")

        # iterates throught jobs, and update tags for each job
        for job in jobs:
            job_labels = []
            for tag in runner_labels:
                if job["machine_type"] in runner_labels[tag]:
                    job_labels.append(tag)
            job["runner_labels"] = job_labels

    def _query_in_queue_jobs(
        self, queryStr: str, parameters: Any, tags: List[str] = []
    ) -> list[dict[str, Any]]:
        """
        post query process to remove duplicated jobs
        this is bc clickhouse client returns duplicated jobs for some reason
        """
        seen = set()
        db_resp = self._query(queryStr, parameters)
        result = []
        for record in db_resp:
            if record["html_url"] in seen:
                continue
            seen.add(record["html_url"])

            record["tags"] = tags
            result.append(record)
        return result

    def _query(self, query, params={}) -> list[dict[str, Any]]:
        reader = self.clickhouse_client.query(query, params)
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


class WorkerPoolHandler:
    """
    WorkerPoolHandler runs workers in parallel to generate queue time histograms and writes the results to the target destination.
    It performs the following tasks:
     1. Uses a thread pool to generate histogram data for specified intervals.
     2. Collects the results for all intervals from the thread pool.
     3. Writes all valid results to the target destination (e.g., an S3 bucket).
    """

    def __init__(
        self,
        retrievers: Dict[str, LazyFileHistory],
        queue_time_processor: QueueTimeProcessor,
        max_workers: int = 4,
        is_dry_run: bool = False,
        local_output: bool = False,
        output_snapshot_file_name: str = "job_queue_times_snapshot",
        output_snapshot_file_path: str = "",
    ):
        self.retrievers = retrievers
        self.queue_time_processor = queue_time_processor
        self.max_workers = max_workers
        self.is_dry_run = is_dry_run

        self.output_snapshot_file_name = output_snapshot_file_name
        self.output_snapshot_file_path = output_snapshot_file_path
        self.local_output = local_output and is_dry_run

    def start(self, time_intervals: List[List[datetime]]) -> None:
        info(
            f" start to process queue time data with {len(time_intervals)} jobs and {self.max_workers} max num of workers..."
        )

        if len(time_intervals) == 0:
            info(" no time intervals to process, exiting...")
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
                warning(f"Error processing future: {e}")
                errors.append({"error": str(e)})
        info(
            f" done. total works: {len(time_intervals)}, success: {len(results)}, failure:{len(errors)}"
        )

        if len(errors) > 0:
            warning(
                f" [Failure] Errors occurred while processing futures: {errors}, investigation is needed"
            )

        # output results to local file or terminal for local test only
        if self.is_dry_run:
            info(f" writing results to terminal/local file ...")
            for snapshot in results:
                time = datetime.fromtimestamp(snapshot["end_time"])
                self.output_snapshot(snapshot["queued_jobs"], time)
            info(f" done. Write results to terminal/local file .")
            return

        # TODO(elainewy): writing result to s3
        info(f" writing results to s3 bucket...")

    def output_snapshot(
        self,
        snapshot: List[Dict[str, Any]],
        time: datetime,
    ) -> None:
        """
        print the snapshot to local file or terminal for local test only
        """

        time_str = time.strftime("%Y-%m-%d_%H-%M-%S")
        file_name_with_time = f"{self.output_snapshot_file_name}_{time_str}.txt"
        if self.local_output:
            info(
                f"[Dry Run Mode]: found {len(snapshot)} records, outputing to file: {file_name_with_time}   "
            )
            write_to_file(
                json.dumps(snapshot),
                file_name_with_time,
                self.output_snapshot_file_path,
            )
            return

        # otherwise, print to terminal
        if len(snapshot) > 10:
            info(
                f" [Dry Run Mode]:[{time.isoformat()}]found {len(snapshot)} records, print first 2 in terminal. for full result, use local-output option"
            )
            info(json.dumps(snapshot[:2], indent=4))
        else:
            info(f" [Dry Run Mode]: found {len(snapshot)} records, print in terminal")
            info(json.dumps(snapshot, indent=4))


class TimeIntervalGenerator:
    """
    TimeIntervalGenerator:
        calculates time intervals between the source table (workflow_job table) and the target table (histogram table).
        It reads the latest time from both tables, and find the previous half-hour timestamp. if time gap exists, generate intervals.
        currently the interval gap is 30 minutes. It is a necessary step since the data ingested into source table can be delayed
        for the time range we want to calculate, due to the nature of github data pipeline.
    Example:
       source table: 2023-10-01 10:12, target table: 2023-10-01 9:00 ->  2 intervals: [[2023-10-01 9:00,  2023-10-01 9:30], [2023-10-01 9:30,  2023-10-01 10:00]]
       source table: 2025-10-01 10:45, target table: 2023-10-01 10:00 -> 1 intervals: [[2023-10-01 10:00,  2023-10-01 10:30]]
       source table: 2025-10-01 10:45, target table: 2023-10-01 10:30 -> 0 intervals: [] empty, since things are in sync for 10:30 0'clock
    """

    def __init__(self):
        pass

    def generate(self, clickhouse_client: Any):
        info(" start to generate time intervals...")
        utc_now = datetime.now(timezone.utc)
        info(f" Current time (UTC) is{utc_now}")

        # get latest time from histogram table, and find the previous half-hour time stamp
        # Ex: 8:45am -> 8:30am, 11:15pm -> 11:00pm
        lastest_time_histogram = self.get_latest_queue_time_histogram_table(
            clickhouse_client
        )
        lastest_time_histogram_dt = self._to_date_time(
            lastest_time_histogram, timezone=timezone.utc
        )
        exist_target_dt = self._round_down_to_previous_half_hour(
            lastest_time_histogram_dt
        )
        info(
            f"  done parse lastest time from histogram table: {lastest_time_histogram} (UTC format:{lastest_time_histogram_dt}). Prevous half-hour time (UTC): {exist_target_dt}"
        )

        lastest_time_workflow_job = self.get_latest_time_workflow_job_table(
            clickhouse_client
        )

        # get latest time from workflow_job table, and find the previous half-hour time stamp
        lastest_time_workflow_job_dt = self._to_date_time(lastest_time_workflow_job)
        new_src_dt = self._round_down_to_previous_half_hour(
            lastest_time_workflow_job_dt
        )
        info(
            f"  done parse lastest time from workflow_job table: {lastest_time_workflow_job}, (UTC format:{lastest_time_workflow_job_dt}). Previous half-hour time (UTC): {new_src_dt}"
        )

        # generate intervals between exist_target_dt and new_src_dt
        intervals = self._generate_half_hour_intervals(exist_target_dt, new_src_dt)

        # TODO(elainewy): add logic to investigate if any interval already existed in db, skip.
        info(
            f"  done. {len(intervals)} intervals between [{exist_target_dt},{new_src_dt}]"
        )
        return intervals

    def _to_date_time(
        self, time: str | datetime | int | float, timezone=timezone.utc
    ) -> datetime:
        if isinstance(time, int):
            time = datetime.fromtimestamp(time, timezone.utc)
        elif isinstance(time, float):
            time = datetime.fromtimestamp(int(time), timezone.utc)
        elif isinstance(time, str):
            if time.isdigit():
                time = datetime.fromtimestamp(int(time), timezone.utc)
            else:
                time = parse(time)
        time = time.replace(tzinfo=timezone.utc)
        return time

    def _round_down_to_previous_half_hour(self, time: datetime) -> datetime:
        minutes = (time.minute // 30) * 30  # Round down to the nearest 30-minute mark
        return time.replace(minute=minutes, second=0, microsecond=0)

    def _generate_half_hour_intervals(
        self, start_time: datetime, end_time: datetime, maximum_intervals: int = 150
    ):
        if self._is_unix_epoch(end_time):
            raise Exception(
                f"end_time {end_time} is unixstamp 0, please check the input time"
            )

        if end_time <= start_time:
            info(
                f"skip. end_time `{end_time}` is earlier than or equal to start_time `{start_time}`"
            )
            return []

        if self._is_unix_epoch(start_time):
            # find closest :00 and :30 time from source table
            single_end_time = self._round_down_to_half_hour(end_time)
            # then find previous half-hour closest to the end_time
            single_start_time = self._round_down_to_half_hour(
                single_end_time - timedelta(minutes=1)
            )
            info(
                f"  [Initialization] start_time is unix timestamp 0. generating interval from workflow_job table: [{single_start_time.isoformat()}, {single_end_time.isoformat()}]"
            )
            return [[single_start_time, single_end_time]]

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

    def _round_down_to_half_hour(self, dt):
        # If minutes are less than 30, set them to 0; if greater or equal, set to 30
        if dt.hour == 0 and dt.minute == 0 and dt.second == 0:
            # Go back to 12:30 of the previous day
            return (dt - timedelta(days=1)).replace(
                hour=12, minute=30, second=0, microsecond=0
            )
        elif dt.minute < 30:
            # Round down to the start of the hour (00:00:00, 01:00:00, etc.)
            return dt.replace(minute=0, second=0, microsecond=0)
        else:
            # Round down to the half-hour (00:30:00, 01:30:00, etc.)
            return dt.replace(minute=30, second=0, microsecond=0)

    def get_latest_queue_time_histogram_table(
        self,
        cc: clickhouse_connect.driver.client.Client,
    ) -> str:
        query = """
        SELECT toUnixTimestamp(MAX(time)) as latest FROM fortesting.oss_ci_queue_time_histogram
        """
        info(" Getting last queue time from misc.oss_ci_queue_time_histogram....")
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

    def get_latest_time_workflow_job_table(self, clickhouse_client) -> str:
        info(" Getting last queue time from default.workflow_job...")
        query = """
        SELECT toUnixTimestamp(GREATEST(MAX(created_at), MAX(started_at))) AS latest from default.workflow_job
        """
        res = clickhouse_client.query(query, {})

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
    clickhouse_client: Any,
    s3_client: Any,
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
    if not github_access_token:
        raise ValueError("Missing environment variable GITHUB_ACCESS_TOKEN")

    # gets config retrievers, this is used to generate runner labels for histgram

    config_retrievers = get_config_retrievers(github_access_token)
    queue_time_processor = QueueTimeProcessor(
        clickhouse_client,
        s3_client,
        is_dry_run=is_dry_run,
    )

    # get time intervals.
    time_intervals = TimeIntervalGenerator().generate(clickhouse_client)

    # get jobs in queue from clickhouse for list of time intervals, in parallel
    handler = WorkerPoolHandler(
        config_retrievers,
        queue_time_processor,
        is_dry_run=is_dry_run,
        local_output=local_output,
        output_snapshot_file_name=output_snapshot_file_name,
        output_snapshot_file_path=output_snapshot_file_path,
    )
    handler.start(time_intervals)


def lambda_handler(event: Any, context: Any) -> None:
    """
    Main method to run in aws lambda environment
    """
    db_client = get_clickhouse_client_environment()
    s3_client = get_aws_s3_resource()
    main(db_client, s3_client)
    return


def parse_args() -> argparse.Namespace:
    """
    Parse command line arguments, this is mainly used for local test environment.
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
        help="when set, writing results to s3 from local environment. By default, we run in dry-run mode for local environment",
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

    arguments = parse_args()

    # update environment variables for input parameters

    db_client = get_clickhouse_client(
        host=arguments.clickhouse_endpoint,
        user=arguments.clickhouse_username,
        password=arguments.clickhouse_password,
    )
    s3_client = get_aws_s3_resource()

    # always run in dry-run mode in local environment, unless it's disabled.
    is_dry_run = not arguments.not_dry_run

    main(
        db_client,
        s3_client,
        arguments.github_access_token,
        is_dry_run=is_dry_run,
        local_output=arguments.local_output,
        output_snapshot_file_name=arguments.output_file_name,
        output_snapshot_file_path=arguments.output_file_path,
    )


if __name__ == "__main__":
    local_run()
