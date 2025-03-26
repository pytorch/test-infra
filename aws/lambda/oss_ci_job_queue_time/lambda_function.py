#!/usr/bin/env python
import argparse
import io
import json
import logging
import os
import gzip
import re
import threading
import yaml

import boto3  # type: ignore[import]
import clickhouse_connect
from datetime import datetime, time

# Local imports
from functools import lru_cache
from logging import info
from typing import Any, Optional, Dict, Set, Iterable, List, Tuple
from github import Github, Auth
from dateutil.parser import parse

ENVS = {
    "GITHUB_ACCESS_TOKEN": os.getenv("GITHUB_ACCESS_TOKEN", ""),
    "CLICKHOUSE_ENDPOINT": os.getenv("CLICKHOUSE_ENDPOINT", ""),
    "CLICKHOUSE_PASSWORD": os.getenv("CLICKHOUSE_PASSWORD", ""),
    "CLICKHOUSE_USERNAME": os.getenv("CLICKHOUSE_USERNAME,"),
}


logging.basicConfig(level=logging.INFO)
_bucket_name = "ossci-raw-job-status"
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
    print(f"File written to: {os.path.abspath(file_path)}")


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

    def is_unix_timestamp(self, value: str) -> bool:
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

    def get_version_after_timestamp(self, timestamp: str | datetime) -> Optional[str]:
        try:
            with self._lock:
                if not isinstance(timestamp, datetime):
                    if self.is_unix_timestamp(timestamp):
                        timestamp = datetime.fromtimestamp(
                            float(timestamp)
                        ).astimezone()
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
            print(
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
            print(
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

        if machine_type.startswith("linux.rocm.gpu"):
            runner_labels["linux"].add(machine_type)
            runner_labels["linux-amd"].add(machine_type)

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
        "linux-amd": set(),  # linux instances provided by amd. for instance linux.rocm.gpu.2
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


class QueueTimeProcessor:
    """
    this class used to handle oss ci queue time data aggregations. Currently it fetches in-queue jobs from clickhouse at current time

    To run the main method:
       processor = QueueTimeProcessor(clickhouse_client,s3_client)
       processor.process()
    """

    def __init__(
        self,
        clickhouse_client: Any,
        s3_client: Any,
        github_access_token: str = "",
        is_dry_run: bool = False,
        local_output: bool = False,
        output_snapshot_file_name: str = "job_queue_times_snapshot",
        output_snapshot_file_path: str = "",
    ) -> None:
        self.clickhouse_client = clickhouse_client
        self.s3_client = s3_client
        self.is_dry_run = is_dry_run
        self.local_output = local_output and is_dry_run

        self.output_snapshot_file_name = output_snapshot_file_name
        self.output_snapshot_file_path = output_snapshot_file_path

        if not github_access_token:
            raise ValueError("Missing environment variable GITHUB_ACCESS_TOKEN")
        self.github_access_token = github_access_token

    def process(self) -> None:
        # get runner config retrievers
        retrievers = get_config_retrievers(self.github_access_token)

        # use current time as snapshot time
        timestamp = str(int(datetime.now().timestamp()))
        timestamp = "1742946298"
        hour_before = str(int(timestamp) - 3600)

        # 1742900960,1742946560
        snapshot = self.get_queueing_jobs(
            retrievers["meta"],
            retrievers["lf"],
            retrievers["old_lf"],
            hour_before,
            timestamp,
            "pytorch/pytorch",
        )

        # if self.is_dry_run:
        # self.output_snapshot(snapshot, timestamp)
        # TODO(elainewy): add logics to generate histograms based on the snapshot results

    def output_snapshot(
        self,
        snapshot: List[Dict[str, Any]],
        timestamp: str,
    ) -> None:
        """
        print the snapshot to local file or terminal for local test only
        """
        info(
            f"[Dry Run Mode]: generated {len(snapshot)} records from get_jobs_in_queue_snapshot"
        )
        if self.local_output:
            write_to_file(
                json.dumps(snapshot),
                self.output_snapshot_file_name,
                self.output_snapshot_file_path,
            )
            return
        info(json.dumps(snapshot))

    def _fetch_snapshot_from_db(
        self,
        start_timestamp: str,
        end_timestamp: str = "",
        repo: str = "pytorch/pytorch",
    ) -> List[Dict[str, Any]]:
        # in given snapshot time, fetches jobs that were in queue but not being picked up by workers
        queued_query = self.get_query_statement_for_queueing_jobs(end_timestamp, repo)
        jobs_in_queue = self._query_in_queue_jobs(
            queued_query["query"], queued_query["parameters"]
        )

        # in given snapshot end_timestamp, fetches jobs that were in queue but were picked up by workers later of given snapshot time
        # this happens when the snapshot time is not in latest timestamp
        picked_query = self.get_query_statement_for_picked_up_job(end_timestamp, repo)
        jobs_pick = self._query_in_queue_jobs(
            picked_query["query"], picked_query["parameters"]
        )

        # in given time range (start_timestamp, end_timestamp), fetches jobs that were in-queue but completed WITHIN given time range
        completed_within_dates_sql = self.get_query_statement_for_completed_jobs(
            start_timestamp, end_timestamp, repo
        )
        job_completed_within_dates = self._query_in_queue_jobs(
            completed_within_dates_sql["query"],
            completed_within_dates_sql["parameters"],
        )

        dt = datetime.fromtimestamp(int(end_timestamp))
        datetime_str = dt.strftime("%Y-%m-%d %H:%M:%S")

        dt2 = datetime.fromtimestamp(int(start_timestamp))
        dt2_str = dt2.strftime("%Y-%m-%d %H:%M:%S")

        info(
            f"[Snapshot time:{datetime_str}]. Found {len(jobs_in_queue)} jobs still has queued status, and {len(jobs_pick)} jobs was has queue status but picked up by runners later"
        )
        result = jobs_in_queue + jobs_pick

        info(
            f"[Snapshot time:{datetime_str}]. Found in-queue {len(result)} jobs, completed within {dt2_str} to {datetime_str}  ({start_timestamp},{end_timestamp}) has {len(job_completed_within_dates)} jobs"
        )

        return result

    def get_queueing_jobs(
        self,
        meta_runner_config_retriever,
        lf_runner_config_retriever,
        old_lf_lf_runner_config_retriever,
        start_timestamp: str,
        end_timestamp: str,
        repo: str = "pytorch/pytorch",
    ) -> List[Dict[str, Any]]:
        """
        this method is used to fetch jobs that were in queue in given snapshot time
        """

        # fetches queued jobs at given snapshot time from db
        snapshot = self._fetch_snapshot_from_db(start_timestamp, end_timestamp, repo)
        if len(snapshot) == 0:
            info(f"No jobs in queue at time: {end_timestamp}")
            return []

        # create dictionary of tags with set of targeting machine types
        lf_runner_config = get_runner_config(lf_runner_config_retriever, end_timestamp)
        if not lf_runner_config or not lf_runner_config["runner_types"]:
            lf_runner_config = get_runner_config(
                old_lf_lf_runner_config_retriever, end_timestamp
            )
        runner_labels = create_runner_labels(
            get_runner_config(meta_runner_config_retriever, end_timestamp),
            lf_runner_config,
        )
        update_tags(runner_labels, set([job["machine_type"] for job in snapshot]))

        # iterates throught jobs, and update tags for each job
        for job in snapshot:
            job_labels = []
            for tag in runner_labels:
                if job["machine_type"] in runner_labels[tag]:
                    job_labels.append(tag)
            job["runner_labels"] = job_labels

        return snapshot

    def _query_in_queue_jobs(
        self, queryStr: str, parameters: Any
    ) -> list[dict[str, Any]]:
        """
        post query process to remove duplicated jobs
        this is bc clickhouse client returns duplicated jobs for some reason
        """
        seen = set()
        db_resp = self.query(queryStr, parameters)
        result = []
        for record in db_resp:
            if record["html_url"] in seen:
                continue
            seen.add(record["html_url"])
            result.append(record)
        return result

    def query(self, query, params={}) -> list[dict[str, Any]]:
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

        query = s11 + _in_queue_job_select_statement + s12
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
        query = s1 + _in_queue_job_select_statement + s2
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
        query = s1 + _in_queue_job_select_statement + s2
        parameters = {
            "end_timestamp": time,
            "repo": repo,
        }
        return {
            "query": query,
            "parameters": parameters,
        }


def lambda_handler(event: Any, context: Any) -> None:
    """
    Main method to run in aws lambda environment
    """
    db_client = get_clickhouse_client_environment()
    s3_client = get_aws_s3_resource()

    QueueTimeProcessor(
        db_client, s3_client, github_access_token=ENVS["GITHUB_ACCESS_TOKEN"]
    ).process()

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


def main() -> None:
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

    QueueTimeProcessor(
        db_client,
        s3_client,
        arguments.github_access_token,
        is_dry_run=is_dry_run,
        local_output=arguments.local_output,
        output_snapshot_file_name=arguments.output_file_name,
        output_snapshot_file_path=arguments.output_file_path,
    ).process()


if __name__ == "__main__":
    main()
