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
from functools import lru_cache
import gzip
import json
import multiprocessing
import random
import re
import urllib.request
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any
from dataclasses import dataclass
from pathlib import Path
import os
from torchci.clickhouse import query_clickhouse
import concurrent.futures
import time

def get_temp_dir() -> Path:
    """Create a temporary directory for processing files"""
    temp_dir = Path("/tmp/file_report_generator")
    temp_dir.mkdir(parents=True, exist_ok=True)
    (temp_dir / "intermediate_ind").mkdir(parents=True, exist_ok=True)
    (temp_dir / "intermediate_status_changes").mkdir(parents=True, exist_ok=True)
    return temp_dir

@dataclass
class FileReportData:
    file: str
    owner_labels: List[str]
    timestamp: int
    errors: int = 0
    failures: int = 0
    skipped: int = 0
    successes: int = 0
    tests: int = 0
    time: float = 0.0
    cost: float = 0.0
    workflows: List[Dict[str, Any]] = None

    def __post_init__(self):
        if self.workflows is None:
            self.workflows = []


class FileReportGenerator:
    """Generator for file reports based on owner labels"""

    # S3 URL for EC2 pricing data
    EC2_PRICING_URL = "https://ossci-metrics.s3.us-east-1.amazonaws.com/ec2_pricing.json.gz"

    def __init__(self, reports_dir: str, test_owners_file: str = "test_owner_labels.json"):
        """Initialize the generator with the test owners file path"""
        self.test_owners_file = test_owners_file
        self.base_dir = Path(__file__).parent.parent.parent.parent  # Navigate to repo root
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
        for line in decompressed_data.decode('utf-8').splitlines():
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
        for line in decompressed_data.decode('utf-8').splitlines():
            if line.strip():
                test_owners.append(json.loads(line))
        return test_owners


    def get_runner_cost(self, runner_label: str) -> float:
        """Get the cost per hour for a given runner"""
        runner_costs = self.load_runner_costs()
        if runner_label.startswith("lf."):
            runner_label = runner_label[3:]
        return runner_costs.get(runner_label, 0.0)

    def _get_first_suitable_sha(self, shas: list[str]) -> Optional[str]:
        """Get the first suitable SHA from a list of SHAs."""
        lens = []
        for sha in shas:
            head_sha = sha['head_sha']
            test_data = self._get_all_test_data_for_sha(head_sha)

            has_no_job_name = False
            for entry in test_data:
                if not entry.get("job_id"):
                    has_no_job_name = True
                    break
            if has_no_job_name:
                print(f"Has entries with no job IDs for {head_sha}")
                continue

            lens.append((head_sha, len(test_data)))
            del test_data

            if len(lens) > 1:
                lens.sort(key=lambda x: x[1], reverse=True)
                if abs(lens[0][1] - lens[1][1]) * 2/ (lens[0][1] + lens[1][1]) < 0.1:
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
            "start_date": start_date + ' 00:00:00',
            "stop_date": stop_date + ' 23:59:59',
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
            day = datetime.fromtimestamp(candidate['push_date'], timezone.utc).strftime('%Y-%m-%d')
            if day not in group_by_day:
                group_by_day[day] = []
            group_by_day[day].append(candidate)

        with multiprocessing.get_context("spawn").Pool(processes=2) as pool:
            results = pool.map(self._get_first_suitable_sha, group_by_day.values())

        return [sha for sha in results if sha is not None]

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

        params = {'sha': sha}

        print(f"Querying ClickHouse for workflow runs with SHA: {sha}")
        result = query_clickhouse(query, params)

        for row in result:
            row["short_job_name"] = f"{row.get('workflow_name')} / {self._parse_job_name(row.get('job_name', ''))}"
            row["runner_type"] = self._get_runner_label_from_job_info(row)
            row["cost"] = self.get_runner_cost(row.get("runner_type", 0))
            row["frequency"] = self.get_frequency(row.get("workflow_name", 0))

        return result

    @lru_cache
    def _get_frequency(self) -> float:
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
        match = re.search(r'\(([^,]+),.*\)', job_name)
        if match:
            base_part = job_name[:job_name.find('(')]
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

    def _fetch_test_data_from_s3(self, workflow_run_id: int, workflow_run_attempt: int) -> Optional[list[dict[str, Any]]]:
        """
        Use local cache for a specific workflow run.
        """
        bucket = "ossci-raw-job-status"
        key = f"test_run/{workflow_run_id}/{workflow_run_attempt}"
        try:
            start_time = time.time()
            file_loc = get_temp_dir() / f"cache_{workflow_run_id}_{workflow_run_attempt}"
            if file_loc.exists():
                print(f"Using cached download for {file_loc}")
                compressed_data = file_loc.read_bytes()
            else:
                url = f"https://{bucket}.s3.amazonaws.com/{key}"
                with urllib.request.urlopen(url) as response:
                    compressed_data = response.read()

                with open(file_loc, 'wb') as f:
                    f.write(compressed_data)

            decompressed_data = gzip.decompress(compressed_data)
            text_data = decompressed_data.decode('utf-8')

            test_data = []
            for line in text_data.strip().split('\n'):
                if line.strip():
                    test_data.append(json.loads(line))

            print(f"Fetched {len(test_data)} test entries from {key}, took {time.time() - start_time:.2f} seconds")
            return test_data
        except Exception as e:
            print(f"Failed to fetch from {key}: {e}")
            return None

    def process_all_test_data(self, all_test_data):
        files = {}

        for entry in all_test_data:
            # Get file name (prefer 'file' over 'invoking_file')
            file_name = entry.get("file_name") or entry.get("invoking_file")
            if not file_name:
                continue

            job_id = str(entry.get("job_id", "unknown"))
            job_info = entry.get("_job_info", {})

            # Use pre-computed short job name if available, otherwise parse
            job_name = job_info.get("short_job_name")
            if not job_name:
                raw_job_name = job_info.get("job_name", f"unknown_job")
                job_name = self._parse_job_name(raw_job_name)

            test_name = f"{entry.get('classname', '')}::{entry.get('name', '')}"
            key = (file_name, job_name, test_name)

            if key not in files:
                files[key] = {
                    "test_name": test_name,
                    "job_name": job_name,
                    "file_name": file_name,
                    "count": 0,
                    "time": 0.0,
                    "cost": 0.0,
                    "errors": 0,
                    "failures": 0,
                    "skipped": 0,
                    "successes": 0,
                    "job_info": job_info,
                    "job_ids": set()  # Track which job IDs contribute to this job name
                }

            # Update test data
            files[key]["count"] += 1
            files[key]["job_ids"].add(job_id)

            # Handle time conversion safely
            time_value = entry.get("time", 0)
            if isinstance(time_value, (int, float)):
                files[key]["time"] += time_value
            elif isinstance(time_value, str):
                try:
                    files[key]["time"] += float(time_value)
                except (ValueError, TypeError):
                    # Skip invalid time values
                    pass

            # Determine test outcome
            if "failure" in entry:
                files[key]["failures"] += 1
            elif "error" in entry:
                files[key]["errors"] += 1
            elif "skipped" in entry:
                files[key]["skipped"] += 1
            else:
                files[key]["successes"] += 1

            # Calculate cost using pre-computed cost per hour if available
            cost_per_hour = job_info.get("cost_per_hour")
            if cost_per_hour is None:
                # Fallback to manual calculation if not pre-computed
                runner_label = self._get_runner_label_from_job_info(job_info)
                cost_per_hour = self.get_runner_cost(runner_label)

            try:
                time_float = float(time_value)
                files[key]["cost"] += time_float * cost_per_hour / 3600.0
            except (ValueError, TypeError):
                pass

        for val in files.values():
            val["job_ids"] = list(val["job_ids"])
        return list(files.values())

    def _get_all_test_data_for_sha(self, sha: str) -> List[Dict[str, Any]]:
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
            workflow_runs.add((job_data.get("workflow_id"), job_data.get("run_attempt", 1)))

        all_test_data = []

        # Use threads instead of processes for IO-bound S3 fetching
        results = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            futures = [
                executor.submit(self._fetch_test_data_from_s3, run_id, run_attempt)
                for run_id, run_attempt in workflow_runs
            ]
            # Maintain order to match workflow_runs
            results = [f.result() for f in futures]
        for test_data in results:
            if test_data:
                # Enrich each test entry with job info
                for entry in test_data:
                    job_id = str(entry.get("job_id", "unknown"))
                    entry["_job_info"] = job_info.get(job_id, {})
                all_test_data.extend(test_data)

        return all_test_data

    def group_by_job_file(self, tests, sha, push_date):
        job_file_map = {}
        for test in tests:
            job_name = test["job_name"]
            file_name = test["file_name"]
            key = (job_name, file_name)
            if key not in job_file_map:
                job_file_map[key] = {
                    "job_name": job_name,
                    "file_name": file_name,
                    "count": 0,
                    "time": 0.0,
                    "cost": 0.0,
                    # "tests": set(),
                    "errors": 0,
                    "failures": 0,
                    "skipped": 0,
                    "successes": 0,
                    "frequency": test["job_info"].get("frequency", 0),
                    # "job_info": [],
                    # "job_ids": set(),
                    # "duplicate_tests": [],  # Track tests with multiple entries
                    "labels": self.get_label_for_file(file_name),
                    "sha": sha,
                    "push_date": push_date
                }
            job_file_map[key]["count"] += 1
            job_file_map[key]["time"] += test["time"]
            job_file_map[key]["cost"] += test["cost"]
            job_file_map[key]["errors"] += test["errors"]
            job_file_map[key]["failures"] += test["failures"]
            job_file_map[key]["skipped"] += test["skipped"]
            job_file_map[key]["successes"] += test["successes"]

            # # Track tests with multiple entries
            # if test["count"] > 1:
            #     job_file_map[key]["duplicate_tests"].append({
            #         "test_name": test["test_name"],
            #         "count": test["count"]
            #     })

        # for val in job_file_map.values():
        #     val["tests"] = list(val["tests"])
        #     val["job_ids"] = list(val["job_ids"])

        return list(job_file_map.values())

    def get_label_for_file(self, file_name: str) -> List[str]:
        for row in self.load_test_owners():
            if row["file"] == f"{file_name.replace('.', '/')}.py":
                return row["owner_labels"]
        return []

    def get_status_changes(self, sha1: str, sha2: str, sha2_push_date: str) -> Dict[str, Any]:
        """
        Compare test data between two pre-fetched datasets.
        Returns a dictionary with file_name as keys and job diffs as values.
        """

        def save_to_final(data):
            if len(data) > 50:
                # Too much data... sampling
                shuffled = random.sample(data, len(data))
                data = shuffled[:50]
            with open(self.reports_dir / f"status_changes.json", 'a') as f:
                json.dump(data, f)
                f.write("\n")

        cache_key = get_temp_dir() / "intermediate_status_changes" / f"{sha1} {sha2}"
        if cache_key.exists():
            with open(cache_key) as f:
                data = json.load(f)
            save_to_final(data)
            return data

        tests1 = self.get_data_for_sha(sha1)["process_all_test_data"]
        tests2 = self.get_data_for_sha(sha2)["process_all_test_data"]

        # Group by key
        map1 = {(v["job_name"], v["file_name"], v["test_name"]): v for v in tests1}
        map2 = {(v["job_name"], v["file_name"], v["test_name"]): v for v in tests2}

        status_changes = []

        for key in map1.keys() | map2.keys():
            status = None

            if key in map1 and key not in map2:
                status = "removed"
            elif key not in map1 and key in map2:
                status = "added"
            else:
                skipped1 = map1[key].get("skipped", 0) > 0
                skipped2 = map2[key].get("skipped", 0) > 0
                if not skipped1 and skipped2:
                    status = "started_skipping"
                elif skipped1 and not skipped2:
                    status = "stopped_skipping"
            if status is not None:
                status_changes.append({
                    "job_name": key[0],
                    "file_name": key[1],
                    "test_name": key[2],
                    "status": status,
                    "labels": self.get_label_for_file(key[1]),
                    "sha": sha2,
                    "push_date": sha2_push_date
                })

        with open(get_temp_dir() / "intermediate_status_changes" / f"{sha1} {sha2}", 'w') as f:
            json.dump(status_changes, f)
        save_to_final(status_changes)

        return status_changes

    def get_data_for_sha(self, sha: str) -> Dict[str, Any]:
        def save_to_final(data):
            with open(self.reports_dir / f"data.json", 'a') as f:
                json.dump(data["group_by_job_file"], f)
                f.write("\n")

        json_path = get_temp_dir() / "intermediate_ind" / f"{sha}"
        if json_path.exists():
            with open(json_path, 'r') as f:
                data = json.load(f)
            save_to_final(data)
            return data

        push_date = self.get_push_date_for_sha(sha)
        _get_all_test_data_for_sha = self._get_all_test_data_for_sha(sha)
        process_all_test_data = self.process_all_test_data(_get_all_test_data_for_sha)
        group_by_job_file = self.group_by_job_file(process_all_test_data, sha, push_date)
        data = {
            "sha": sha,
            "push_date": push_date,
            # "_get_all_test_data_for_sha": _get_all_test_data_for_sha,
            "process_all_test_data": process_all_test_data,
            "group_by_job_file": group_by_job_file
        }
        with open(json_path, 'w') as f:
            json.dump(data, f, indent=2)
        save_to_final(data)
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
        """
    )

    parser.add_argument("--start-date", help="Start date for filtering (YYYY-MM-DD)")
    parser.add_argument("--stop-date", help="Stop date for filtering (YYYY-MM-DD)")
    parser.add_argument("--shas", nargs="+", help="List of commit SHAs to compare in sequence")
    parser.add_argument("--output", help="Output folder to write results to")
    parser.add_argument("--test-pricing", action="store_true", help="Test fetching pricing data from S3 and exit")
    parser.add_argument("--list-runners", action="store_true", help="List all available runners and their costs, then exit")
    parser.add_argument("--test-owners-file", default="test_owner_labels.json", help="Path to the test owners file")

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

    if (args.start_date and not args.stop_date) or (not args.start_date and args.stop_date):
        parser.error("Must provide both --start-date and --stop-date for auto-selection")
    if args.shas and (args.start_date or args.stop_date):
        parser.error("Cannot mix --shas with --start-date/--stop-date parameters")
    if args.shas and len(args.shas) < 2:
        parser.error("Either provide --shas with at least 2 SHAs, or --start-date and --stop-date for auto-selection")

    # Handle the start-date/stop-date parameters
    if args.start_date:
        args.shas = generator.find_suitable_shas(args.start_date, args.stop_date)

    print(f"Using SHAs: {args.shas}")

    # Load data to get dates/ordering
    shas_with_push_date = []
    for sha in args.shas:
        data = generator.get_data_for_sha(sha)
        shas_with_push_date.append({
            "sha": sha,
            "push_date": data["push_date"]
        })
        del data

    shas_with_push_date = sorted(shas_with_push_date, key=lambda x: x["push_date"])

    print("Calculating diffs for all files and grouping by labels...")
    for i in range(1, len(shas_with_push_date)):
        generator.get_status_changes(shas_with_push_date[i-1]["sha"], shas_with_push_date[i]["sha"], shas_with_push_date[i]["push_date"])


if __name__ == "__main__":
    main()
