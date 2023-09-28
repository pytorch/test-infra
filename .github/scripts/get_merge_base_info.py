import json
import subprocess
from pathlib import Path
from typing import List, Any
from multiprocessing import Pool
from datetime import datetime

from rockset_utils import query_rockset
import boto3

s3 = boto3.resource("s3")


REPO_ROOT = Path(__file__).resolve().parent.parent.parent

FAILED_TEST_SHAS_QUERY = """
SELECT
    DISTINCT j.head_sha,
FROM
    commons.failed_tests_run t
    join workflow_job j on t.job_id = j.id
"""


def run_command(command: str) -> str:
    cwd = REPO_ROOT / ".." / "pytorch"
    return (
        subprocess.check_output(
            command.split(" "),
            cwd=cwd,
        )
        .decode("utf-8")
        .strip()
    )


def upload_to_s3(bucket: str, key: str, body: str):
    s3.Object(bucket, key).put(Body=body, ContentType="application/json")


def pull_shas(shas: List[str]):
    all_shas = " ".join(shas)
    run_command(
        f"git -c protocol.version=2 fetch --no-tags --prune --quiet --no-recurse-submodules origin {all_shas}"
    )


def upload_merge_base_info(sha: str) -> None:
    try:
        merge_base = run_command(f"git merge-base main {sha}")
        if merge_base == sha:
            # The commit was probably already on main, so take the previous
            # commit as the merge base
            merge_base = run_command(f"git rev-parse {sha}^")
        changed_files = run_command(f"git diff {sha} {merge_base} --name-only")
        unix_timestamp = run_command(f"git show --no-patch --format=%ct {merge_base}")
        timestamp = datetime.utcfromtimestamp(int(unix_timestamp)).isoformat() + "Z"

        t = {
            "sha": sha,
            "merge_base": merge_base,
            "changed_files": changed_files.splitlines(),
            "merge_base_commit_date": timestamp,
        }
        upload_to_s3(
            "ossci-metrics", f"merge_bases/pytorch/{sha}", json.dumps(t, indent=2)
        )
    except Exception as e:
        return e


if __name__ == "__main__":
    failed_test_shas = [x["head_sha"] for x in query_rockset(FAILED_TEST_SHAS_QUERY)][
        :100
    ]
    interval = 100
    print(f"There are {len(failed_test_shas)}, uploading in batches of {interval}")
    for i in range(0, len(failed_test_shas), interval):
        pull_shas(failed_test_shas[i : i + interval])
    errors = []
    pool = Pool(20)
    for sha in failed_test_shas:
        errors.append(pool.apply_async(upload_merge_base_info, args=(sha,)))
    pool.close()
    pool.join()
    for i in errors:
        if i.get() is not None:
            print(i.get())
