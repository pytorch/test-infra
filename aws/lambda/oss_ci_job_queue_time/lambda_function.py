#!/usr/bin/env python
import argparse
import io
import json
import logging
import os
import gzip
import threading
import dateutil.parser
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


logging.basicConfig(level=logging.INFO)

_bucket_name = "ossci-raw-job-status"
_in_queue_job_select_statement = """
SELECT
    DATE_DIFF(
        'second',
        job.created_at,
        {timestamp:DateTime}
    ) AS queue_s,
    workflow.repository.'full_name' AS repo,
    workflow.name AS workflow_name,
    job.name AS job_name,
    job.html_url,
    IF(
        LENGTH(job.labels) = 0,
        'N/A',
        IF(
            LENGTH(job.labels) > 1,
            job.labels[2],
            job.labels[1]
        )
    ) AS machine_type,
    toUnixTimestamp({timestamp:DateTime}) AS time
FROM
    default.workflow_job job FINAL
    JOIN default.workflow_run workflow FINAL ON workflow.id = job.run_id
"""


@lru_cache()
def get_clickhouse_client(host: str, user: str, password: str) -> Any:
    return clickhouse_connect.get_client(
        host=host, user=user, password=password, secure=True, verify=False
    )


@lru_cache()
def get_aws_s3_resource() -> Any:
    return boto3.resource("s3")


def get_clickhouse_client_environment() -> Any:
    for env in ["CLICKHOUSE_ENDPOINT", "CLICKHOUSE_USERNAME", "CLICKHOUSE_PASSWORD"]:
        if not os.getenv(env):
            raise ValueError(f"Missing environment variable {env}")

    return get_clickhouse_client(
        host=os.getenv("CLICKHOUSE_ENDPOINT"),
        user=os.getenv("CLICKHOUSE_USERNAME"),
        password=os.getenv("CLICKHOUSE_PASSWORD"),
    )


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

    def _fetch_content_for_commit(self, commit: any) -> str:
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
    tag_categories: Dict[str, Set[str]], machine_types: Iterable[str]
) -> None:
    """
    iterate through machine types from jobs, and update potential tags that it belongs to
    """
    for machine_type in machine_types:
        if not machine_type:
            continue
        tag_categories["all"].add(machine_type)

        if machine_type.startswith("linux.rocm.gpu"):
            tag_categories["linux"].add(machine_type)
            tag_categories["linux-amd"].add(machine_type)

        if machine_type not in tag_categories["dynamic"]:
            if "ubuntu" in machine_type.lower():
                tag_categories["linux"].add(machine_type)
                tag_categories["github"].add(machine_type)
            else:
                tag_categories["other"].add(machine_type)


def create_tag_categorires(
    runner_configs: Dict[str, Dict[str, Any]],
    lf_runner_configs: Dict[str, Dict[str, Any]],
) -> Dict[str, Set[str]]:
    """
    Create the tag_categorires, that are groups of runners with some common characteristics that we might find relevant
    to view them in a group instead of individually.
    """
    tag_dict = {
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
    tag_dict["github"].update(github_mac_runners)
    tag_dict["macos"].update(github_mac_runners)

    meta_pet_mac_runners = (
        "macos-m1-12",
        "macos-m1-13",
        "macos-m1-14",
        "macos-m1-stable",
        "macos-m2-14",
        "macos-m2-15",
        "macos-m2-max",
    )
    tag_dict["meta"].update(meta_pet_mac_runners)
    tag_dict["macos"].update(meta_pet_mac_runners)
    tag_dict["pet"].update(meta_pet_mac_runners)

    meta_pet_nvidia = (
        "linux.aws.a100",
        "linux.aws.h100",
    )
    tag_dict["meta"].update(meta_pet_nvidia)
    tag_dict["linux"].update(meta_pet_nvidia)
    tag_dict["linux-meta"].update(meta_pet_nvidia)
    tag_dict["pet"].update(meta_pet_nvidia)
    tag_dict["multi-tenant"].update(meta_pet_nvidia)

    all_runners_configs = (
        runner_configs["runner_types"] | lf_runner_configs["runner_types"]
    )

    for runner, runner_config in all_runners_configs.items():
        tag_dict["dynamic"].add(runner)

        if "is_ephemeral" in runner_config and runner_config["is_ephemeral"]:
            tag_dict["ephemeral"].add(runner)
        else:
            tag_dict["nonephemeral"].add(runner)

        if runner_config["os"].lower() == "linux":
            tag_dict["linux"].add(runner)
        elif runner_config["os"].lower() == "windows":
            tag_dict["windows"].add(runner)

    for runner, runner_config in runner_configs["runner_types"].items():
        tag_dict["meta"].add(runner)

        if runner_config["os"].lower() == "linux":
            tag_dict["linux-meta"].add(runner)
        elif runner_config["os"].lower() == "windows":
            tag_dict["windows-meta"].add(runner)

    for runner, runner_config in lf_runner_configs["runner_types"].items():
        tag_dict["lf"].add(runner)

        if runner_config["os"].lower() == "linux":
            tag_dict["linux-lf"].add(runner)
        elif runner_config["os"].lower() == "windows":
            tag_dict["windows-lf"].add(runner)
    return tag_dict


def get_runner_config(
    retriever: LazyFileHistory, start_time: str | datetime
) -> Dict[str, Dict[str, Any]]:
    contents = retriever.get_version_after_timestamp(start_time)
    if contents:
        return explode_runner_variants(yaml.safe_load(contents))
    return {"runner_types": {}}


def get_query_statement_for_picked_up_job(time: str, repo: str = "pytorch/pytorch"):
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
            started_at > ({timestamp:DateTime})
            AND created_at < ({timestamp:DateTime} - INTERVAL 5 MINUTE)
            AND created_at > ({timestamp:DateTime} - INTERVAL 1 WEEK)
    )"""

    s2 = """
    WHERE
        job.id IN (SELECT id FROM possible_queued_jobs)
        AND workflow.id IN (SELECT run_id FROM possible_queued_jobs)
        AND workflow.repository.'full_name' = {repo:String}
        AND job.status = 'completed'
        AND LENGTH(job.steps) != 0
        AND workflow.status = 'completed'
    ORDER BY
        queue_s DESC
    """
    query = s1 + _in_queue_job_select_statement + s2
    parameters = {
        "timestamp": time,
        "repo": repo,
    }
    return query, parameters


def get_query_statement_for_queueing_jobs(time: str, repo: str = "pytorch/pytorch"):
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
            AND created_at < ({timestamp:DateTime} - INTERVAL 5 MINUTE)
            AND created_at > ({timestamp:DateTime} - INTERVAL 1 WEEK)
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
        "timestamp": time,
        "repo": repo,
    }
    return query, parameters


def get_config_retrievers(github_access_token: str) -> Tuple[Any, Any, Any]:
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

    return (
        meta_runner_config_retriever,
        lf_runner_config_retriever,
        old_lf_lf_runner_config_retriever,
    )


class QueueTimeProcessor:
    """
    this class used to handle oss ci queue time data aggregations. Currently it fetches in-queue jobs from clickhouse at current time

    To run the main method:
       processor = QueueTimeProcessor(clickhouse_client,s3_client)
       processor.process()
    """

    def __init__(
        self, clickhouse_client: Any, s3_client: Any, is_dry_run: bool = False
    ) -> None:
        self.clickhouse_client = clickhouse_client
        self.s3_client = s3_client
        self.is_dry_run = is_dry_run

    def process(self) -> None:
        github_access_token = os.getenv("GITHUB_ACCESS_TOKEN", "")
        if not github_access_token:
            raise ValueError("Missing environment variable GITHUB_ACCESS_TOKEN")

        (
            meta_runner_config_retriever,
            lf_runner_config_retriever,
            old_lf_lf_runner_config_retriever,
        ) = get_config_retrievers(github_access_token)
        self.proceses_job_queue_times_historical(
            meta_runner_config_retriever,
            lf_runner_config_retriever,
            old_lf_lf_runner_config_retriever,
        )

    def snapshot_jobs_in_queue(
        self, timestamp: str = "", repo: str = "pytorch/pytorch"
    ) -> List[Dict[str, Any]]:
        # in given snapshot time, fetches jobs that were in queue but not being picked up by workers
        queued_query, queued_parameters = get_query_statement_for_queueing_jobs(
            timestamp, repo
        )
        jobs_in_queue = self.process_in_queue_jobs(queued_query, queued_parameters)

        # in queue in given snapshot time, fetches jobs that were in queue but were picked up by workers later of given snapshot time
        # this happens when the snapshot time is not latest timestamp
        picked_query, picked_params = get_query_statement_for_picked_up_job(
            timestamp, repo
        )
        jobs_pick = self.process_in_queue_jobs(picked_query, picked_params)

        datetime_str = datetime.fromtimestamp(int(timestamp)).strftime(
            "%Y-%m-%d %H:%M:%S"
        )

        info(
            f"[Snapshot time:{datetime_str}]. Found {len(jobs_in_queue)} jobs in queue, and {len(jobs_pick)} jobs was in queue but picked up by workers later"
        )
        result = jobs_in_queue + jobs_pick
        return result

    def proceses_job_queue_times_historical(
        self,
        meta_runner_config_retriever,
        lf_runner_config_retriever,
        old_lf_lf_runner_config_retriever,
        snapshot_time: str = "",
        repo: str = "pytorch/pytorch",
    ) -> None:
        # by default, we use current time as snapshot
        timestamp = str(int(datetime.now().timestamp()))
        if snapshot_time:
            timestamp = snapshot_time

        # fetch jobs in queue at given snapshot time
        snapshot = self.snapshot_jobs_in_queue(timestamp, repo)
        if len(snapshot) == 0:
            info(f"No jobs in queue at time: {timestamp}")
            return

        # create dictionary of tags with set of targeting machine types
        lf_runner_config = get_runner_config(lf_runner_config_retriever, timestamp)
        if not lf_runner_config or not lf_runner_config["runner_types"]:
            lf_runner_config = get_runner_config(
                old_lf_lf_runner_config_retriever, timestamp
            )
        tag_categories = create_tag_categorires(
            get_runner_config(meta_runner_config_retriever, timestamp), lf_runner_config
        )
        update_tags(tag_categories, set([job["machine_type"] for job in snapshot]))

        # iterate throught jobs, and update tags for each job
        for job in snapshot:
            job_tags = []
            for tag in tag_categories:
                if job["machine_type"] in tag_categories[tag]:
                    job_tags.append(tag)
            job_tags.append(job["machine_type"])
            job["tags"] = job_tags

        key = f"job_queue_times_historical/{repo}/{timestamp}.txt"
        if self.is_dry_run:
            info(f"[Dry Run Mode]: {len(snapshot)} records to S3 {_bucket_name}/{key}")
            info(json.dumps(snapshot))
            return

        print("Yang", snapshot)

        upload_to_s3_txt(self.s3_client, _bucket_name, key, snapshot)

    def process_in_queue_jobs(
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


def lambda_handler(event: Any, context: Any) -> None:
    """
    Main method to run in aws lambda environment
    """
    db_client = get_clickhouse_client_environment()
    s3_client = get_aws_s3_resource()

    QueueTimeProcessor(db_client, s3_client).process()

    return


def parse_args() -> argparse.Namespace:
    """
    Parse command line arguments, this is mainly used for local test environment.
    """
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--clickhouse-endpoint",
        default=os.getenv("CLICKHOUSE_ENDPOINT", ""),
        type=str,
        help="the clickhouse endpoint, the clickhouse_endpoint name is  https://{clickhouse_endpoint}:{port} for full url ",
    )
    parser.add_argument(
        "--clickhouse-username",
        type=str,
        default=os.getenv("CLICKHOUSE_USERNAME", ""),
        help="the clickhouse username",
    )
    parser.add_argument(
        "--clickhouse-password",
        type=str,
        default=os.getenv("CLICKHOUSE_PASSWORD", ""),
        help="the clickhouse password for the user name",
    )
    parser.add_argument(
        "--not-dry-run",
        action="store_true",
        help="when set, writing results to s3 from local environment. By default, we run in dry-run mode for local environment",
    )
    args, _ = parser.parse_known_args()
    return args


def main() -> None:
    """
    method to run in local test environment
    """

    arguments = parse_args()

    # update environment variables for input parameters
    os.environ["CLICKHOUSE_ENDPOINT"] = arguments.clickhouse_endpoint
    os.environ["CLICKHOUSE_USERNAME"] = arguments.clickhouse_username
    os.environ["CLICKHOUSE_PASSWORD"] = arguments.clickhouse_password

    db_client = get_clickhouse_client_environment()
    s3_client = get_aws_s3_resource()

    # always run in dry-run mode in local environment, unless it's disabled.
    is_dry_run = not arguments.not_dry_run

    QueueTimeProcessor(db_client, s3_client, is_dry_run=is_dry_run).process()


if __name__ == "__main__":
    main()
