#!/usr/bin/env python3
"""
File Report Generator

This script generates file reports by comparing test data between commit SHAs.
It fetches test data, calculates diffs, and groups results by owner labels from
test_owner_labels.json. It then uploads the results to S3 to be used by HUD.

General format:
commits_metadata.json.gz: list of commits with push dates
data_<sha>.json.gz: test data for a specific sha
status_changes_<sha1>_<sha2>.json.gz: diffs between two shas

When this script is run, it can add new SHAs (either specified directly or
auto-selected based on dates) to the available information, or remove a specific
SHA.

Usage:
    python file_report_generator.py --add-dates <date1> <date2>
    python file_report_generator.py --add-shas <sha1> <sha2>
    python file_report_generator.py --remove-sha <sha>
"""

import argparse
import concurrent.futures
import gzip
import io
import json
import logging
import re
import time
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, cast, Dict, List, Optional


try:
    import boto3  # type: ignore[import]
except ImportError:
    # for unit tests without boto3 installed
    boto3 = None  # type: ignore[assignment]

from torchci.clickhouse import query_clickhouse
from torchci.test_insights.ec2_pricing import get_price_for_label


logger = logging.getLogger(__name__)
handler = logging.StreamHandler()
formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
logger.setLevel(logging.DEBUG)
handler.setLevel(logging.DEBUG)
handler.setFormatter(formatter)
logger.addHandler(handler)


def get_temp_dir() -> Path:
    """Create a temporary directory for processing files"""
    temp_dir = Path("/tmp/file_report_generator")
    temp_dir.mkdir(parents=True, exist_ok=True)
    return temp_dir


class FileReportGenerator:
    """Generator for file reports based on owner labels"""

    # S3 URL for EC2 pricing data
    EC2_PRICING_URL = (
        "https://ossci-metrics.s3.us-east-1.amazonaws.com/ec2_pricing.json.gz"
    )

    def __init__(self, dry_run: bool = True):
        """Initialize the generator with the test owners file path"""
        self.dry_run = dry_run

    @lru_cache
    def load_test_owners(self) -> List[Dict[str, Any]]:
        """Load the test owner labels JSON file from S3"""
        S3_URL = "https://ossci-metrics.s3.us-east-1.amazonaws.com/test_owner_labels/test_owner_labels.json.gz"
        logger.debug(f"Fetching test owner labels from S3: {S3_URL}")
        with urllib.request.urlopen(S3_URL) as response:
            compressed_data = response.read()
        decompressed_data = gzip.decompress(compressed_data)
        test_owners = []
        for line in decompressed_data.decode("utf-8").splitlines():
            if line.strip():
                test_owners.append(json.loads(line))
        return test_owners

    def get_runner_cost(self, runner_label: str) -> float:
        """Get the cost per hour for a given runner"""
        if runner_label.startswith("lf."):
            runner_label = runner_label[3:]
        cost = get_price_for_label(runner_label)
        if cost is None:
            return 0.0
        return cost

    def _get_first_suitable_sha(self, shas: list[dict[str, Any]]) -> Optional[str]:
        """Get the first suitable SHA from a list of SHAs."""
        lens = []
        for sha in shas:
            head_sha = sha["head_sha"]
            test_data = self._get_invoking_file_test_data_for_sha(head_sha)

            has_no_job_name = False
            for entry in test_data:
                if "NoJobName" in entry.get("short_job_name", ""):
                    has_no_job_name = True
                    break
            if has_no_job_name:
                logger.debug(f"Has entries with no job name for {head_sha}")
                continue

            lens.append((head_sha, len(test_data)))
            del test_data

            if len(lens) > 1:
                lens.sort(key=lambda x: x[1], reverse=True)
                sha1, len1 = lens[0]
                _, len2 = lens[1]

                if abs(len1 - len2) * 2 / (len1 + len2) < 0.1:
                    logger.debug(f"Using SHA {sha1} with {len1} entries")
                    return sha1
        return None

    def find_suitable_sha(self, date: str) -> Optional[str]:
        """
        Auto-select suitable SHA from PyTorch main branch for a given date.
        Usage:
        - Provide a date to select a SHA from that day
        Criteria:
        - SHA is from main branch
        - Workflow jobs are successful (green)
        - S3 test data is available
        - All test entries have job names
        """

        logger.debug("Searching for suitable SHAs from PyTorch main branch...")

        params = {
            "start_date": date + " 00:00:00",
            "stop_date": date + " 23:59:59",
        }

        # Single query with conditional logic using CASE expressions
        query = """
        SELECT
            w.head_sha,
            toUnixTimestamp(w.head_commit.'timestamp') as push_date
        FROM default.workflow_run w
        WHERE w.head_branch = 'main'
            AND w.repository.full_name = 'pytorch/pytorch'
            AND w.name in ('pull', 'trunk', 'inductor', 'slow')
            AND w.conclusion = 'success'
            AND w.head_commit.'timestamp' >= {start_date: DateTime}
            AND w.head_commit.'timestamp' <= {stop_date: DateTime}
        GROUP BY
            w.head_sha, w.head_commit.'timestamp'
        HAVING count(distinct w.name) = 4
        ORDER BY
            min(w.head_commit.'timestamp') DESC
        """
        logger.debug(f"Querying ClickHouse for successful shas on {date}")
        candidates = query_clickhouse(query, params)

        logger.debug(f"Found {len(candidates)} candidate SHAs")

        return self._get_first_suitable_sha(candidates)

    @lru_cache
    def _get_workflow_jobs_for_sha(self, sha: str) -> List[Dict[str, Any]]:
        """Get workflow runs for a specific SHA using ClickHouse."""
        query = """
        with workflow_ids as (
            SELECT
                w.id,
            FROM
                default .workflow_run w
            WHERE
                w.head_branch = 'main'
                AND w.repository.full_name = 'pytorch/pytorch'
                AND w.name in ('pull', 'trunk', 'inductor', 'slow')
                AND w.conclusion = 'success'
                AND w.head_sha = {sha: String}
        )
        SELECT
            DISTINCT j.id as job_id,
            j.name as job_name,
            j.labels as job_labels,
            j.run_id as workflow_id,
            j.run_attempt,
            j.workflow_name as workflow_name,
            j.conclusion
        FROM
            default .workflow_job j
        WHERE
            j.run_id in (select id from workflow_ids)
        """

        params = {"sha": sha}

        logger.debug(f"Querying ClickHouse for workflow runs with SHA: {sha}")
        result = query_clickhouse(query, params)

        for row in result:
            row["short_job_name"] = (
                f"{row.get('workflow_name')} / {self._parse_job_name(row.get('job_name', ''))}"
            )
            row["runner_type"] = self._get_runner_label_from_job_info(row)
            row["cost"] = self.get_runner_cost(row.get("runner_type", 0))
            row["frequency"] = self.get_frequency(row.get("workflow_name", 0))

        return result

    @lru_cache
    def _get_frequency(self) -> List[Dict[str, Any]]:
        query = """
        select
            count(*) as count,
            name
        from
            workflow_run j
        where
            j.created_at > now() - interval 8 day
            and j.created_at < now() - interval 1 day
            and j.conclusion != 'cancelled'
        group by
            name
        """
        params = {}
        return query_clickhouse(query, params)

    def get_frequency(self, workflow_name: str) -> float:
        res = self._get_frequency()
        for row in res:
            if row["name"] == workflow_name:
                return int(row["count"])
        return 1

    def _parse_job_name(self, job_name: str) -> str:
        """
        Parse job name to remove shard information.
        Example: 'linux-jammy-py3.10-clang18-asan / test (default, 1, 6, linux.4xlarge)'
        becomes: 'linux-jammy-py3.10-clang18-asan / test (default)'
        """
        if not job_name:
            return "unknown"

        # Replace with just the first part in parentheses
        # First extract the part before the comma if it exists
        match = re.search(r"\(([^,]+),.*\)", job_name)
        if match:
            base_part = job_name[: job_name.find("(")]
            first_param = match.group(1)
            return f"{base_part}({first_param})"

        return job_name

    def _get_runner_label_from_job_info(self, job_info: Dict[str, Any]) -> str:
        """
        Extract runner label from job information.
        Tries multiple sources: runner_name, job_labels with 'self-hosted' patterns.
        """
        # Then try to find runner info in job_labels
        job_labels = job_info.get("job_labels", [])
        for label in job_labels:
            if label.startswith("lf."):
                label = label[3:]
            if get_price_for_label(label) is not None:
                return label

        return "unknown"

    def _get_local_cache_file_loc(self, bucket: str, key: str) -> Path:
        """Get the local cache file location for a given S3 bucket and key."""
        return get_temp_dir() / f"cache_{bucket}_{key.replace('/', '_')}"

    def _fetch_from_s3(self, bucket: str, key: str) -> str:
        """
        Fetch a file from s3 and return its contents as a string. Also saves the
        contents to a local cache.
        """
        try:
            file_loc = self._get_local_cache_file_loc(bucket, key)
            if file_loc.exists():
                logger.debug(f"Using cached download for {file_loc}")
                compressed_data = file_loc.read_bytes()
            else:
                url = f"https://{bucket}.s3.amazonaws.com/{key}"
                with urllib.request.urlopen(url) as response:
                    compressed_data = response.read()

                with open(file_loc, "wb") as f:
                    f.write(compressed_data)

            decompressed_data = gzip.decompress(compressed_data)
            text_data = decompressed_data.decode("utf-8")
            return text_data
        except Exception as e:
            logger.debug(f"Failed to fetch from s3://{bucket}/{key}: {e}")
            raise e

    def _fetch_invoking_file_summary_from_s3(
        self, workflow_run_id: int, workflow_run_attempt: int
    ) -> list[dict[str, Any]]:
        """
        Use local cache for a specific workflow run.
        """
        bucket = "ossci-raw-job-status"
        key = f"additional_info/invoking_file_summary/{workflow_run_id}/{workflow_run_attempt}"

        start_time = time.time()
        text_data = self._fetch_from_s3(bucket, key)
        test_data = json.loads(text_data)

        data_as_list = []
        for build, entries in test_data.items():
            for config, entries in entries.items():
                for _, entry in entries.items():
                    entry["run_id"] = workflow_run_id
                    entry["run_attempt"] = workflow_run_attempt
                    # TODO remove this later
                    entry["short_job_name"] = f"{build} / test ({config})"
                    data_as_list.append(entry)

        logger.debug(
            f"Fetched {len(data_as_list)} test entries from {key}, took {time.time() - start_time:.2f} seconds"
        )
        return data_as_list

    def _get_invoking_file_test_data_for_sha(self, sha: str) -> List[Dict[str, Any]]:
        """
        Fetch all test data for a given SHA once and cache it.
        Returns a flat list of test entries with job info embedded.
        """
        workflow_jobs = self._get_workflow_jobs_for_sha(sha)

        # Create job_info mapping from the returned job data
        job_info = {}
        workflow_runs = set()

        for job_data in workflow_jobs:
            job_id = str(job_data.get("job_id"))
            job_info[job_id] = {
                "job_name": job_data.get("job_name", ""),
                "short_job_name": job_data.get("short_job_name", ""),
                "job_labels": job_data.get("job_labels", []),
                "runner_type": job_data.get("runner_type", ""),
                "cost_per_hour": job_data.get("cost", 0.0),
                "workflow_name": job_data.get("workflow_name", ""),
                "frequency": job_data.get("frequency", 0),
            }
            workflow_runs.add((job_data["workflow_id"], job_data["run_attempt"]))

        all_test_data = []

        # Use threads instead of processes for IO-bound S3 fetching
        results = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            futures = [
                executor.submit(
                    self._fetch_invoking_file_summary_from_s3, run_id, run_attempt
                )
                for run_id, run_attempt in workflow_runs
            ]
            # Maintain order to match workflow_runs
            results = [f.result() for f in futures]

        for test_data in results:
            all_test_data.extend(test_data)

        # Create lookup table for workflow_id -> workflow_name to construct
        # short_job_name
        workflow_id_to_name = {
            job["workflow_id"]: job["workflow_name"] for job in workflow_jobs
        }
        # Map short job name to full job data to get cost per hour and runner
        # type. There will be duplicates but the only info we need is
        # cost/runner which should be the same
        job_name_to_job = {job["short_job_name"]: job for job in job_info.values()}

        # Embed workflow name and job info into each test entry
        for entry in all_test_data:
            run_id = entry.get("run_id")
            workflow_name = workflow_id_to_name.get(run_id)
            entry["short_job_name"] = (
                f"{workflow_name} / {entry.get('short_job_name', '')}"
            )
            _job_info = job_name_to_job[entry["short_job_name"]]
            entry["sha"] = sha
            entry["push_date"] = self.get_push_date_for_sha(sha)
            entry["labels"] = self.get_label_for_file(entry["file"])
            entry["cost"] = (
                _job_info.get("cost_per_hour", 0.0) / 3600.0 * entry.get("time", 0)
            )
            entry["frequency"] = _job_info["frequency"]

        return all_test_data

    def get_label_for_file(self, file: str) -> List[str]:
        for row in self.load_test_owners():
            if row["file"] == file:
                return row["owner_labels"]
        return []

    def _fetch_status_changes_from_s3(
        self, workflow_run_id: int, workflow_run_attempt: int
    ) -> list[dict[str, Any]]:
        """
        Use local cache for a specific workflow run.
        """
        bucket = "ossci-raw-job-status"
        key = f"additional_info/test_status/{workflow_run_id}/{workflow_run_attempt}"

        start_time = time.time()
        text_data = self._fetch_from_s3(bucket, key)

        test_data = []
        for line in text_data.splitlines():
            data = json.loads(line)
            data["run_id"] = workflow_run_id
            test_data.append(data)

        logger.debug(
            f"Fetched {len(test_data)} test entries from {key}, took {time.time() - start_time:.2f} seconds"
        )
        return test_data

    def _get_status_changes_for_sha(self, sha: str) -> List[Dict[str, Any]]:
        """ """
        workflow_jobs = self._get_workflow_jobs_for_sha(sha)
        workflow_runs = set()
        for job_data in workflow_jobs:
            workflow_runs.add((job_data["workflow_id"], job_data["run_attempt"]))

        all_test_data = []

        # Use threads instead of processes for IO-bound S3 fetching
        results = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            futures = [
                executor.submit(self._fetch_status_changes_from_s3, run_id, run_attempt)
                for run_id, run_attempt in workflow_runs
            ]
            # Maintain order to match workflow_runs
            results = [f.result() for f in futures]

        for test_data in results:
            all_test_data.extend(test_data)

        # Create lookup table for workflow_id -> workflow_name to construct
        # short_job_name
        workflow_id_to_name = {
            job["workflow_id"]: job["workflow_name"] for job in workflow_jobs
        }

        # Embed workflow name and job info into each test entry
        for entry in all_test_data:
            run_id = entry["run_id"]
            workflow_name = workflow_id_to_name.get(run_id)
            entry["short_job_name"] = (
                f"{workflow_name} / {entry.get('short_job_name', '')}"
            )

        return all_test_data

    def _check_status_change_already_exists(self, sha1: str, sha2: str) -> bool:
        """
        Check if status changes between two SHAs already exist in S3.
        """
        bucket = "ossci-raw-job-status"
        key = f"additional_info/weekly_file_report/status_changes_{sha1}_{sha2}.json.gz"
        url = f"https://{bucket}.s3.amazonaws.com/{key}"
        try:
            with urllib.request.urlopen(url) as response:
                if response.status == 200:
                    logger.debug(
                        f"Status changes for {sha1} to {sha2} already exist in S3."
                    )
                    return True
        except Exception:
            pass
        return False

    def get_status_changes(
        self, sha1: str, sha2: str, sha2_push_date: str
    ) -> list[dict[str, Any]]:
        """
        Compare test data between two pre-fetched datasets.
        Returns a dictionary with file as keys and job diffs as values.
        """

        tests1 = self._get_status_changes_for_sha(sha1)
        tests2 = self._get_status_changes_for_sha(sha2)

        # Group by key
        map1 = {(v["short_job_name"], v["file"], v["name"]): v for v in tests1}
        map2 = {(v["short_job_name"], v["file"], v["name"]): v for v in tests2}

        status_changes = []

        for key in map1.keys() | map2.keys():
            status = None

            if key in map1 and key not in map2:
                status = "removed"
            elif key not in map1 and key in map2:
                status = "added"
            else:
                skipped1 = map1[key]["status"] == "skipped"
                skipped2 = map2[key]["status"] == "skipped"
                if not skipped1 and skipped2:
                    status = "started_skipping"
                elif skipped1 and not skipped2:
                    status = "stopped_skipping"
            if status is not None:
                status_changes.append(
                    {
                        "short_job_name": key[0],
                        "file": key[1],
                        "test_name": key[2],
                        "status": status,
                        "labels": self.get_label_for_file(key[1]),
                        "sha": sha2,
                        "push_date": sha2_push_date,
                    }
                )

        # Too large so truncate for now - just keep first 10 of each type
        counts = defaultdict(list)
        for entry in status_changes:
            counts[(entry["short_job_name"], entry["file"], entry["status"])].append(
                entry
            )
        to_write = []
        for key, entries in counts.items():
            to_write.extend(entries[:10])
        logger.debug(
            f"Found {len(status_changes)} status changes between {sha1} and {sha2}, truncated to {len(to_write)} for upload"
        )

        self.upload_to_s3(
            to_write,
            "ossci-raw-job-status",
            f"additional_info/weekly_file_report/status_changes_{sha1}_{sha2}.json.gz",
        )

        return status_changes

    def get_data_for_sha(self, sha: str) -> Dict[str, Any]:
        push_date = self.get_push_date_for_sha(sha)
        invoking_file_test_data = self._get_invoking_file_test_data_for_sha(sha)
        data = {
            "sha": sha,
            "push_date": push_date,
        }
        self.upload_to_s3(
            invoking_file_test_data,
            "ossci-raw-job-status",
            f"additional_info/weekly_file_report/data_{sha}.json.gz",
        )
        return data

    @lru_cache
    def get_push_date_for_sha(self, sha: str) -> Optional[str]:
        """
        Get the push date for a given SHA from ClickHouse push table.
        Returns the date as an ISO string, or None if not found.
        """
        query = """
        SELECT toUnixTimestamp(min(p.head_commit.timestamp)) as pushed_at
        FROM default.push p
        WHERE p.after = {sha: String}
            AND p.ref = 'refs/heads/main'
            AND p.repository.full_name = 'pytorch/pytorch'
        """
        params = {"sha": sha}
        result = query_clickhouse(query, params)
        if result:
            return result[0]["pushed_at"]
        return None

    def fetch_existing_metadata(self) -> list[dict[str, Any]]:
        """Fetch existing metadata from the reports directory"""
        metadata_str = self._fetch_from_s3(
            "ossci-raw-job-status",
            "additional_info/weekly_file_report/commits_metadata.json.gz",
        )
        metadata = []
        for line in metadata_str.splitlines():
            metadata.append(json.loads(line))

        return metadata

    @lru_cache
    def get_s3_resource(self):
        s3 = boto3.resource("s3")
        return s3

    def upload_to_s3(
        self,
        contents: list[dict[str, Any]],
        bucket_name: str,
        key: str,
    ) -> None:
        body = io.StringIO()
        for doc in contents:
            json.dump(doc, body)
            body.write("\n")

        html_url = f"https://{bucket_name}.s3.amazonaws.com/{key}"

        if self.dry_run:
            local_file = get_temp_dir() / f"dry_run_{key.replace('/', '_')}.json"
            logger.info(
                f"Dry run: would upload data to s3: {html_url}, writing to local file {local_file} instead"
            )
            with open(local_file, "w") as f:
                f.write(body.getvalue())
            return

        compressed = gzip.compress(body.getvalue().encode())

        # Also write to local temp dir cache
        with open(self._get_local_cache_file_loc(bucket_name, key), "wb") as f:
            f.write(compressed)

        logger.info(f"Uploading data to s3: {html_url}")
        self.get_s3_resource().Object(bucket_name, key).put(
            Body=compressed,
            ContentEncoding="gzip",
            ContentType="application/json",
        )

    def remove_key_from_s3(self, bucket: str, key: str) -> None:
        """Remove a specific key from S3"""
        html_url = f"https://{bucket}.s3.amazonaws.com/{key}"
        if self.dry_run:
            logger.info(f"Dry run: would remove from s3: {html_url}")
            return
        logger.info(f"Removing from s3: {html_url}")
        self.get_s3_resource().Object(bucket, key).delete()


def main() -> None:
    """Main function to run the file report generator"""
    parser = argparse.ArgumentParser(
        description="Generate comprehensive file reports grouped by owner labels",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Generate report with two specific dates (auto-select SHAs for each date)
  python file_report_generator.py --day1 2025-08-15 --day2 2025-08-20
        """,
    )
    parser.add_argument(
        "--add-shas", nargs="+", help="List of commit SHAs to compare in sequence"
    )
    parser.add_argument(
        "--add-dates", nargs="+", help="List of commit SHAs to compare in sequence"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Dry run without writing files"
    )
    parser.add_argument("--remove-sha", help="Remove a specific SHA from the report")

    args = parser.parse_args()

    generator = FileReportGenerator(args.dry_run)

    existing_metadata = generator.fetch_existing_metadata()

    _existing_dates = set(
        datetime.fromtimestamp(entry["push_date"], timezone.utc).strftime("%Y-%m-%d")
        for entry in existing_metadata
    )
    _existing_shas = set(entry["sha"] for entry in existing_metadata)

    if args.remove_sha:
        for i, entry in enumerate(existing_metadata):
            if entry["sha"] == args.remove_sha:
                logger.info(f"Removing SHA {args.remove_sha} from existing metadata")
                generator.remove_key_from_s3(
                    "ossci-raw-job-status",
                    f"additional_info/weekly_file_report/data_{args.remove_sha}.json.gz",
                )
                if i > 0:
                    prev_sha = existing_metadata[i - 1]["sha"]
                    generator.remove_key_from_s3(
                        "ossci-raw-job-status",
                        f"additional_info/weekly_file_report/status_changes_{prev_sha}_{args.remove_sha}.json.gz",
                    )
                if i < len(existing_metadata) - 1:
                    next_sha = existing_metadata[i + 1]["sha"]
                    generator.remove_key_from_s3(
                        "ossci-raw-job-status",
                        f"additional_info/weekly_file_report/status_changes_{args.remove_sha}_{next_sha}.json.gz",
                    )
                existing_metadata.pop(i)
                break

    shas: list[str] = []
    for date in args.add_dates or []:
        if date in _existing_dates:
            logger.info(f"Date {date} already exists in metadata, skipping")
            continue
        sha = generator.find_suitable_sha(date)
        if sha is None:
            logger.info(f"No suitable SHA found for date {date}, skipping")
            continue
        logger.info(f"Found suitable SHA {sha} for date {date}")
        shas.append(sha)

    for sha in args.add_shas or []:
        shas.append(cast(str, sha))

    logger.info(f"Adding SHAs: {shas}")

    # Load data to get dates/ordering
    for sha in shas:
        sha_data = generator.get_data_for_sha(sha)
        if sha not in _existing_shas:
            existing_metadata.append(sha_data)

    existing_metadata = sorted(existing_metadata, key=lambda x: x["push_date"])

    logger.debug("Calculating diffs for all files and grouping by labels...")
    for i in range(1, len(existing_metadata)):
        if not generator._check_status_change_already_exists(
            existing_metadata[i - 1]["sha"],
            existing_metadata[i]["sha"],
        ):
            generator.get_status_changes(
                existing_metadata[i - 1]["sha"],
                existing_metadata[i]["sha"],
                existing_metadata[i]["push_date"],
            )

    generator.upload_to_s3(
        existing_metadata,
        "ossci-raw-job-status",
        "additional_info/weekly_file_report/commits_metadata.json.gz",
    )


if __name__ == "__main__":
    main()
