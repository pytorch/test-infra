#!/usr/bin/env python3
"""
File Report Generator

This script generates comprehensive file reports by comparing test data between
two commit SHAs. It fetches all test data, calculates diffs for all files, and
groups results by owner labels from test_owner_labels.json.

Usage:
    python file_report_generator.py --sha1 abc123 --sha2 def456
"""

import argparse
import concurrent.futures
import gzip
import json
import multiprocessing
import os
import re
import time
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional

from torchci.clickhouse import query_clickhouse


def get_temp_dir() -> Path:
    """Create a temporary directory for processing files"""
    temp_dir = Path("/tmp/file_report_generator")
    temp_dir.mkdir(parents=True, exist_ok=True)
    (temp_dir / "intermediate_ind").mkdir(parents=True, exist_ok=True)
    (temp_dir / "intermediate_status_changes").mkdir(parents=True, exist_ok=True)
    return temp_dir


class FileReportGenerator:
    """Generator for file reports based on owner labels"""

    # S3 URL for EC2 pricing data
    EC2_PRICING_URL = (
        "https://ossci-metrics.s3.us-east-1.amazonaws.com/ec2_pricing.json.gz"
    )

    def __init__(
        self, reports_dir: str, test_owners_file: str = "test_owner_labels.json"
    ):
        """Initialize the generator with the test owners file path"""
        self.test_owners_file = test_owners_file
        self.base_dir = Path(
            __file__
        ).parent.parent.parent.parent  # Navigate to repo root
        self.test_owners_path = self.base_dir / test_owners_file
        self.reports_dir = Path(reports_dir)
        if not self.reports_dir.exists():
            self.reports_dir.mkdir(parents=True)

    @lru_cache
    def load_runner_costs(self) -> Dict[str, float]:
        """Load runner costs from the S3 endpoint"""
        print("Fetching EC2 pricing data from S3...")
        with urllib.request.urlopen(self.EC2_PRICING_URL) as response:
            compressed_data = response.read()

        decompressed_data = gzip.decompress(compressed_data)
        pricing_data = {}
        for line in decompressed_data.decode("utf-8").splitlines():
            if line.strip():
                line_json = json.loads(line)
                pricing_data[line_json[0]] = float(line_json[2])
        return pricing_data

    @lru_cache
    def load_test_owners(self) -> List[Dict[str, Any]]:
        """Load the test owner labels JSON file from S3"""
        S3_URL = "https://ossci-metrics.s3.us-east-1.amazonaws.com/test_owner_labels/test_owner_labels.json.gz"
        print(f"Fetching test owner labels from S3: {S3_URL}")
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
        runner_costs = self.load_runner_costs()
        if runner_label.startswith("lf."):
            runner_label = runner_label[3:]
        return runner_costs.get(runner_label, 0.0)

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
                print(f"Has entries with no job name for {head_sha}")
                continue

            lens.append((head_sha, len(test_data)))
            del test_data

            if len(lens) > 1:
                lens.sort(key=lambda x: x[1], reverse=True)
                if abs(lens[0][1] - lens[1][1]) * 2 / (lens[0][1] + lens[1][1]) < 0.1:
                    return lens[0][0]
        return None

    def find_suitable_shas(self, start_date: str, stop_date: str) -> list[str]:
        """
        Auto-select suitable SHAs from PyTorch main branch for a given date window.
        Usage:
        - Provide a date range (start and end) to select SHAs within that window.
        - Returns 1 sha per day
        Criteria:
        - SHA is from main branch
        - Workflow jobs are successful (green)
        - S3 test data is available
        - All test entries have job names
        """

        print("Searching for suitable SHAs from PyTorch main branch...")

        params = {
            "start_date": start_date + " 00:00:00",
            "stop_date": stop_date + " 23:59:59",
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
        HAVING count(*) >= 4
        ORDER BY
            min(w.head_commit.'timestamp') DESC
        """
        print(f"Querying ClickHouse for successful workflow runs...")
        candidates = query_clickhouse(query, params)

        print(f"Found {len(candidates)} candidate workflow runs")

        # Test each candidate SHA
        group_by_day = {}
        for candidate in candidates:
            day = datetime.fromtimestamp(candidate["push_date"], timezone.utc).strftime(
                "%Y-%m-%d"
            )
            if day not in group_by_day:
                group_by_day[day] = []
            group_by_day[day].append(candidate)

        with multiprocessing.get_context("spawn").Pool(processes=2) as pool:
            results = pool.map(self._get_first_suitable_sha, group_by_day.values())

        return [sha for sha in results if sha is not None]

    @lru_cache
    def _get_workflow_jobs_for_sha(self, sha: str) -> List[Dict[str, Any]]:
        """Get workflow runs for a specific SHA using ClickHouse."""
        query = """
        SELECT DISTINCT
            j.id as job_id,
            j.name as job_name,
            j.labels as job_labels,
            j.run_id as workflow_id,
            j.run_attempt,
            j.workflow_name as workflow_name
        FROM default.workflow_job j
        WHERE j.head_sha = {sha: String}
            AND j.workflow_name in ('pull', 'trunk', 'inductor', 'slow')
        """

        params = {"sha": sha}

        print(f"Querying ClickHouse for workflow runs with SHA: {sha}")
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
            if label in self.load_runner_costs():
                return label

        return "unknown"

    def _fetch_from_s3(self, bucket: str, key: str) -> str:
        """
        Fetch a file from s3 and return its contents as a string. Also saves the
        contents to a local cache.
        """
        try:
            file_loc = get_temp_dir() / f"cache_{bucket}_{key.replace('/', '_')}"
            if file_loc.exists():
                print(f"Using cached download for {file_loc}")
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
            print(f"Failed to fetch from s3://{bucket}/{key}: {e}")
            return ""

    def _fetch_invoking_file_summary_from_s3(
        self, workflow_run_id: int, workflow_run_attempt: int
    ) -> list[dict[str, Any]]:
        """
        Use local cache for a specific workflow run.
        """
        bucket = "ossci-raw-job-status"
        key = f"additional_info/invoking_file_summary/{workflow_run_id}/{workflow_run_attempt}"

        def reformat(data):
            data_as_list = []
            for build, entries in data.items():
                for config, entries in entries.items():
                    for test_file, entry in entries.items():
                        entry["file_name"] = test_file
                        entry["run_id"] = workflow_run_id
                        entry["run_attempt"] = workflow_run_attempt
                        # TODO remove this later
                        entry["short_job_name"] = f"{build} / test ({config})"
                        data_as_list.append(entry)
            return data_as_list

        start_time = time.time()
        text_data = self._fetch_from_s3(bucket, key)
        test_data = json.loads(text_data)

        print(
            f"Fetched {len(test_data)} test entries from {key}, took {time.time() - start_time:.2f} seconds"
        )
        return reformat(test_data)

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
            entry["_job_info"] = job_name_to_job[entry["short_job_name"]]

        return all_test_data

    def get_label_for_file(self, file_name: str) -> List[str]:
        for row in self.load_test_owners():
            if row["file"] == file_name:
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

        print(
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

    def get_status_changes(
        self, sha1: str, sha2: str, sha2_push_date: str
    ) -> list[dict[str, Any]]:
        """
        Compare test data between two pre-fetched datasets.
        Returns a dictionary with file_name as keys and job diffs as values.
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
                        "job_name": key[0],
                        "file_name": key[1],
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
            counts[(entry["job_name"], entry["file_name"], entry["status"])].append(
                entry
            )
        to_write = []
        for key, entries in counts.items():
            to_write.extend(entries[:10])

        with open(self.reports_dir / f"status_changes_{sha1}_{sha2}.json", "a") as f:
            for entry in to_write:
                json.dump(entry, f)
                f.write("\n")

        return status_changes

    def get_data_for_sha(self, sha: str) -> Dict[str, Any]:
        push_date = self.get_push_date_for_sha(sha)
        invoking_file_test_data = self._get_invoking_file_test_data_for_sha(sha)
        data = {
            "sha": sha,
            "push_date": push_date,
            "invoking_file_test_data": invoking_file_test_data,
        }
        with open(self.reports_dir / f"data.json", "a") as f:
            json.dump(data, f)
            f.write("\n")
        return data

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


def main():
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

    parser.add_argument("--start-date", help="Start date for filtering (YYYY-MM-DD)")
    parser.add_argument("--stop-date", help="Stop date for filtering (YYYY-MM-DD)")
    parser.add_argument(
        "--shas", nargs="+", help="List of commit SHAs to compare in sequence"
    )
    parser.add_argument("--output", help="Output folder to write results to")
    parser.add_argument(
        "--test-pricing",
        action="store_true",
        help="Test fetching pricing data from S3 and exit",
    )
    parser.add_argument(
        "--list-runners",
        action="store_true",
        help="List all available runners and their costs, then exit",
    )
    parser.add_argument(
        "--test-owners-file",
        default="test_owner_labels.json",
        help="Path to the test owners file",
    )

    args = parser.parse_args()

    # Generate default output filename if not provided
    if not args.output:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        reports_dir = os.path.join(os.getcwd(), f"file_reports_{timestamp}")
        if not os.path.exists(reports_dir):
            os.makedirs(reports_dir)
        args.output = str(reports_dir)

    generator = FileReportGenerator(args.output, args.test_owners_file)

    if args.test_pricing:
        print("Testing pricing data fetch...")
        runner_costs = generator.load_runner_costs()
        print(f"Successfully loaded {len(runner_costs)} runner costs")
        return

    if args.list_runners:
        print("Available runners and costs:")
        runner_costs = generator.load_runner_costs()
        for runner, cost in sorted(runner_costs.items()):
            print(f"  {runner:<50} ${cost:>8.4f}/hour")
        return

    if (args.start_date and not args.stop_date) or (
        not args.start_date and args.stop_date
    ):
        parser.error(
            "Must provide both --start-date and --stop-date for auto-selection"
        )
    if args.shas and (args.start_date or args.stop_date):
        parser.error("Cannot mix --shas with --start-date/--stop-date parameters")
    if args.shas and len(args.shas) < 2:
        parser.error(
            "Either provide --shas with at least 2 SHAs, or --start-date and --stop-date for auto-selection"
        )

    # Handle the start-date/stop-date parameters
    if args.start_date:
        args.shas = generator.find_suitable_shas(args.start_date, args.stop_date)

    print(f"Using SHAs: {args.shas}")

    # Load data to get dates/ordering
    shas_with_push_date = []
    for sha in args.shas:
        data = generator.get_data_for_sha(sha)
        shas_with_push_date.append({"sha": sha, "push_date": data["push_date"]})
        del data

    shas_with_push_date = sorted(shas_with_push_date, key=lambda x: x["push_date"])

    print("Calculating diffs for all files and grouping by labels...")
    for i in range(1, len(shas_with_push_date)):
        generator.get_status_changes(
            shas_with_push_date[i - 1]["sha"],
            shas_with_push_date[i]["sha"],
            shas_with_push_date[i]["push_date"],
        )


if __name__ == "__main__":
    main()
