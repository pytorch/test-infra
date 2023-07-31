from typing import Dict, Any, List
import datetime
import subprocess
from pathlib import Path
import sys

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
print(sys.path)
from .utils import query_rockset, upload_to_rockset

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


def get_failed_test_shas() -> List[Dict[str, Any]]:
    current_time = datetime.datetime.now()
    rockset_date_format = "%Y-%m-%dT%H:%M:%S.000Z"
    failed_tests = query_rockset(
        FAILED_TEST_SHAS_QUERY,
        {
            "stopTime": current_time.strftime(rockset_date_format),
            "startTime": (current_time - datetime.timedelta(days=5)).strftime(
                rockset_date_format
            ),
        },
    )
    return failed_tests.results


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


def upload_merge_base_info(shas: List[Dict[str, Any]]) -> None:
    merge_bases = {}
    all_shas = " ".join(test["head_sha"] for test in shas[i : i + 100])
    run_command(
        f"git -c protocol.version=2 fetch --no-tags --prune --quiet --no-recurse-submodules origin {all_shas}"
    )

    for test in shas:
        sha = test["head_sha"]
        try:
            merge_base = run_command(f"git merge-base main {sha}")
            if merge_base == sha:
                # The commit was probably already on main, so take the previous
                # commit as the merge base
                merge_base = run_command(f"git rev-parse {sha}^")
            changed_files = run_command(f"git diff {sha} {merge_base} --name-only")
            merge_bases[sha] = {
                "merge_base": merge_base,
                "changed_files": changed_files.splitlines(),
            }
        except KeyboardInterrupt:
            break
        except Exception as e:
            print(e)

    docs = []
    for sha, info in merge_bases.items():
        docs.append({"sha": sha, **info})
    upload_to_rockset(collection="merge_bases", docs=docs, workspace="commons")
    return docs


if __name__ == "__main__":
    failed_test_shas = get_failed_test_shas()
    interval = 100
    print(f"There are {len(failed_test_shas)}, uploading in batches of {interval}")
    for i in range(0, len(failed_test_shas), interval):
        upload_merge_base_info(failed_test_shas[i : i + interval])
        print(f"{i} to {i + interval} done")
