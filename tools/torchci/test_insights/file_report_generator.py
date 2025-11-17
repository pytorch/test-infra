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
"""

import argparse
import gzip
import io
import json
import logging
import subprocess
import urllib.request
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List


try:
    import boto3  # type: ignore[import]
    from botocore.exceptions import ClientError  # type: ignore[import]
except ImportError:
    # for unit tests without boto3 installed
    boto3 = None  # type: ignore[assignment]

from torchci.clickhouse import query_clickhouse, query_clickhouse_saved


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
    def get_all_shas(self, start_date: str, stop_date: str) -> List[Dict[str, Any]]:
        """
        Get all shas and commit dates between two dates on pytorch/pytorch main
        branch.  Date is in epoch timestamp format.
        """
        repo_root = Path(__file__).resolve().parent.parent.parent.parent

        commits = subprocess.check_output(
            [
                "git",
                "log",
                "--since",
                start_date,
                "--until",
                stop_date,
                "--pretty=format:%H %ct",
                "origin/main",
            ],
            cwd=repo_root / ".." / "pytorch",
        ).decode("utf-8")
        return [
            {"sha": line.split(" ")[0], "push_date": line.split(" ")[1]}
            for line in commits.splitlines()
        ]

    def _get_status_counts_for_sha(self, sha: str) -> List[Dict[str, Any]]:
        """
        Get status counts for a specific SHA using ClickHouse.
        """
        # get workflow ids first

        workflow_ids = query_clickhouse(
            """
        select distinct id from default.workflow_run
        where head_sha = {sha: String}
        and head_branch = 'main'
        and name in ('pull', 'trunk', 'periodic', 'inductor', 'slow')
        """,
            {"sha": sha},
        )

        params = {
            "workflowIds": [int(row["id"]) for row in workflow_ids],
            "shas": [sha],
        }
        logger.debug(
            f"Querying ClickHouse for status counts with SHA: {sha} and workflow IDs: {params['workflowIds']}"
        )
        result = query_clickhouse_saved(
            "tests/test_status_counts_on_commits_by_file", params
        )
        return result

    def get_status_counts_for_sha(self, sha: str) -> List[Dict[str, Any]]:
        result = self._get_status_counts_for_sha(sha)
        for row in result:
            row["sha"] = sha
            row["frequency"] = self.get_frequency(row["workflow_name"])
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

    def check_if_s3_object_exists(self, sha):
        obj = self.get_s3_resource().Object(
            "ossci-raw-job-status",
            f"additional_info/weekly_file_report2/data_{sha}.json.gz",
        )
        try:
            obj.load()
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] == "404":
                return False
            else:
                raise

    def upload_for_sha(self, sha):
        counts = self.get_status_counts_for_sha(sha)
        if counts:
            logger.info(f"Adding SHA {sha}: {len(counts)} test count records")
            self.upload_to_s3(
                counts,
                "ossci-raw-job-status",
                f"additional_info/weekly_file_report2/data_{sha}.json.gz",
            )


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
        "--add-dates", nargs=2, help="Add shas between two dates (epoch timestamps)"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Dry run without writing files"
    )
    args = parser.parse_args()

    generator = FileReportGenerator(args.dry_run)

    # commit data = list of {sha, push_date}
    # test counts = list of {file, workflow_name, job_name, time, success, flaky, skipped, failure, labels (runner), sha}

    # The client needs to put together: cost, short_job_name, frequency on their
    # own if they want it.  They can use the commit data to see which shas exist
    # and choose which to compare

    # Construct and upload the commit metadata everytime since it's cheap
    now = datetime.now(timezone.utc)
    commit_data = generator.get_all_shas("2025-11-01", f"@{now.timestamp()}")
    generator.upload_to_s3(
        commit_data,
        "ossci-raw-job-status",
        "additional_info/weekly_file_report2/commits_metadata.json.gz",
    )

    shas_to_add = []

    if args.add_dates:
        start_date, stop_date = args.add_dates
        logger.info(f"Adding SHAs between dates: {start_date} to {stop_date}")
        for commit in commit_data:
            # if the commit is within the date range, add its SHA
            if start_date <= commit["push_date"] <= stop_date:
                shas_to_add.append(commit["sha"])

    if args.add_shas:
        shas = args.add_shas
        logger.info(f"Adding SHAs: {shas}")
        shas_to_add.extend(shas)

    for sha in shas_to_add:
        try:
            generator.upload_for_sha(sha)
        except Exception as e:
            logger.error(f"Failed to upload data for SHA {sha}: {e}")


if __name__ == "__main__":
    main()
