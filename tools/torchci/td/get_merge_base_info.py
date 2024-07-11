import gzip
import io
import json
import subprocess
from datetime import datetime
from pathlib import Path
from typing import List

import boto3  # type: ignore
from torchci.rockset_utils import query_rockset
from torchci.td.utils import list_past_year_shas, run_command


REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent

S3_RESOURCE = boto3.resource("s3")

FAILED_TEST_SHAS_QUERY = """
SELECT
    DISTINCT j.head_sha,
FROM
    commons.failed_tests_run t
    join workflow_job j on t.job_id = j.id
    left outer join commons.merge_bases mb on j.head_sha = mb.sha
where
    mb.merge_base is null
"""

NOT_IN_MERGE_BASES_TABLE = """
select
    shas.sha as head_sha
from
    unnest(SPLIT(:shas, ',') as sha) as shas
    left outer join commons.merge_bases mb on mb.sha = shas.sha
where
    mb.sha is null
    or mb.repo is null
"""

DUP_MERGE_BASE_INFO = """
select
    ARRAY_AGG(m._id) as ids
from
    commons.merge_bases m
group by
    m.sha
having
    count(*) > 1
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


def pull_shas(shas: List[str]) -> None:
    all_shas = " ".join(shas)
    run_command(
        f"git -c protocol.version=2 fetch --no-tags --prune --quiet --no-recurse-submodules origin {all_shas}"
    )


def upload_merge_base_info(shas: List[str]) -> None:
    docs = []
    for sha in shas:
        try:
            merge_base = run_command(f"git merge-base origin/main {sha}")
            if merge_base == sha:
                # The commit was probably already on main, so take the previous
                # commit as the merge base
                merge_base = run_command(f"git rev-parse {sha}^")
            changed_files = run_command(f"git diff {sha} {merge_base} --name-only")
            unix_timestamp = run_command(
                f"git show --no-patch --format=%ct {merge_base}"
            )
            timestamp = datetime.utcfromtimestamp(int(unix_timestamp)).isoformat() + "Z"
            data = {
                "sha": sha,
                "merge_base": merge_base,
                "changed_files": changed_files.splitlines(),
                "merge_base_commit_date": timestamp,
                "repo": "pytorch/pytorch",
                "_id": f"pytorch-pytorch-{sha}",
            }
            body = io.StringIO()
            json.dump(data, body)
            S3_RESOURCE.Object(
                f"ossci-raw-job-status",
                f"merge_bases/pytorch/pytorch/{sha}.gzip",
            ).put(
                Body=gzip.compress(body.getvalue().encode()),
                ContentEncoding="gzip",
                ContentType="application/json",
            )
        except Exception as e:
            return e


if __name__ == "__main__":
    failed_test_shas = [x["head_sha"] for x in query_rockset(FAILED_TEST_SHAS_QUERY)]
    interval = 100
    print(
        f"There are {len(failed_test_shas)} shas, uploading in intervals of {interval}"
    )
    for i in range(0, len(failed_test_shas), interval):
        pull_shas(failed_test_shas[i : i + interval])
        upload_merge_base_info(failed_test_shas[i : i + interval])

    interval = 500
    main_branch_shas = list_past_year_shas()
    print(f"There are {len(main_branch_shas)} shas, uploading in batches of {interval}")
    for i in range(0, len(main_branch_shas), interval):
        shas = [
            x["head_sha"]
            for x in query_rockset(
                NOT_IN_MERGE_BASES_TABLE,
                {"shas": ",".join(main_branch_shas[i : i + interval])},
            )
        ]
        upload_merge_base_info(shas)
        print(f"{i} to {i + interval} done")
