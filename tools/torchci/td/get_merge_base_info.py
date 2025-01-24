import gzip
import io
import json
import subprocess
from datetime import datetime
from pathlib import Path
from typing import List

import boto3  # type: ignore[import]
from torchci.clickhouse import query_clickhouse
from torchci.td.utils import list_past_year_shas, run_command


REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent

S3_RESOURCE = boto3.resource("s3")

FAILED_TEST_SHAS_QUERY = """
SELECT
    DISTINCT j.head_sha as head_sha
FROM
    default.failed_test_runs t
    join default.workflow_job j final on t.job_id = j.id
    left anti join default.merge_bases mb on j.head_sha = mb.sha
where
    t.time_inserted > CURRENT_TIMESTAMP() - interval 90 days
"""

NOT_IN_MERGE_BASES_TABLE = """
with shas as (
    select arrayJoin({shas: Array(String)}) as sha
)
select
    s.sha as head_sha
from
    shas s
    left anti join default.merge_bases mb on mb.sha = shas.sha
"""


def pull_shas(shas: List[str]) -> None:
    fetch_command = "git -c protocol.version=2 fetch --no-tags --prune --quiet --no-recurse-submodules origin"
    try:
        all_shas = " ".join(shas)
        run_command(f"{fetch_command} {all_shas}")
    except Exception as e:
        print(e)
        for sha in shas:
            try:
                run_command(f"{fetch_command} {sha}")
            except Exception as e:
                print(e)


def upload_merge_base_info(shas: List[str]) -> None:
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
            return


if __name__ == "__main__":
    failed_test_shas = [
        x["head_sha"] for x in query_clickhouse(FAILED_TEST_SHAS_QUERY, {})
    ]
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
            for x in query_clickhouse(
                NOT_IN_MERGE_BASES_TABLE,
                {"shas": main_branch_shas[i : i + interval]},
            )
        ]
        upload_merge_base_info(shas)
        print(f"{i} to {i + interval} done")
