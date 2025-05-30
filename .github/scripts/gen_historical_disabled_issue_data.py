import json
import os
import subprocess
from concurrent.futures import as_completed, ThreadPoolExecutor
from datetime import datetime, timezone
from tempfile import TemporaryDirectory
from typing import List


BRANCH = "generated-stats"
FILE = "stats/disabled-tests-condensed.json"


def get_info(commit: str, day: str, timestamp: int) -> List[dict]:
    contents = (
        subprocess.check_output(
            ["git", "show", f"{commit}:{FILE}"],
        )
        .decode("utf-8")
        .strip()
    )
    json_data = json.loads(contents)
    return format_info(json_data, day, timestamp)


def format_info(info: dict, day: str, timestamp: int) -> List[dict]:
    as_array = []
    for name, item in info.items():
        issue_number, _, platforms = item
        as_array.append(
            {
                "day": day,
                "timestamp": timestamp,
                "name": name,
                "issueNumber": issue_number,
                "platforms": platforms,
            }
        )
    return as_array


def gen_all_history():
    with TemporaryDirectory() as tmpdir:
        os.chdir(tmpdir)
        subprocess.check_call(
            [
                "git",
                "clone",
                "https://github.com/pytorch/test-infra.git",
                tmpdir,
                "--branch",
                BRANCH,
                "--single-branch",
            ]
        )

        commits = (
            subprocess.check_output(
                [
                    "git",
                    "log",
                    "--pretty=format:%H %ct",
                    f"origin/{BRANCH}",
                    "--",
                    FILE,
                ],
            )
            .decode("utf-8")
            .strip()
            .split("\n")
        )

        last_commit_per_day = {}
        for line in commits:
            if line:
                commit_hash, timestamp = line.split()
                timestamp = int(timestamp)
                dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)
                day = dt.date().isoformat()
                if (
                    day not in last_commit_per_day
                    or timestamp > last_commit_per_day[day][1]
                ):
                    last_commit_per_day[day] = (commit_hash, timestamp)

        # Use threads to fetch commit info concurrently
        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = []
            for day, (commit, timestamp) in last_commit_per_day.items():
                # Submit the task to the executor
                futures.append(executor.submit(get_info, commit, day, timestamp))

            # If tqdm is available, use it to show progress
            try:
                from tqdm import tqdm  # type: ignore[import]

                for _ in tqdm(as_completed(futures), total=len(futures)):
                    pass
            except ImportError:
                print("tqdm not available, running without progress bar")
                pass

        results = [f.result() for f in futures]
        results = [item for sublist in results for item in sublist]  # Flatten the list

        for result in results:
            print(json.dumps(result))


if __name__ == "__main__":
    # Prints to stdout, so you can redirect it to a file
    gen_all_history()
