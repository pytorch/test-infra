import json
import os
from concurrent.futures import as_completed, ThreadPoolExecutor
from datetime import datetime, timezone
from tempfile import TemporaryDirectory
from typing import List

from git import Repo  # type: ignore[import]


BRANCH = "generated-stats"
FILE = "stats/disabled-tests-condensed.json"


def get_info(commit: str, day: str, timestamp: int) -> List[dict]:
    repo = Repo(os.getcwd())
    commit_info = repo.commit(commit)
    blob = commit_info.tree / FILE
    json_data = json.loads(blob.data_stream.read())
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
        repo = Repo.clone_from(
            "https://github.com/pytorch/test-infra.git", tmpdir, branch=BRANCH
        )
        commits = list(repo.iter_commits(f"origin/{BRANCH}", paths=FILE))

        last_commit_per_day = {}
        for commit in commits:
            dt = datetime.fromtimestamp(commit.committed_date, tz=timezone.utc)
            day = dt.date().isoformat()
            if (
                day not in last_commit_per_day
                or commit.committed_date > last_commit_per_day[day][1]
            ):
                last_commit_per_day[day] = (commit.hexsha, commit.committed_date)

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
