import json
from typing import Optional, Dict, Any, List
import rockset  # type: ignore[import]
import datetime
import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

FAILED_TESTS_QUERY = """
SELECT
    DISTINCT j.head_sha,
FROM
    commons.failed_tests_run t
    join workflow_job j on t.job_id = j.id
    left outer join commons.merge_bases mb on j.head_sha = mb.sha
where
    t._event_time > CURRENT_TIMESTAMP() - DAYS(15)
    and mb.merge_base is null
"""


def query_rockset(
    query: str, params: Optional[Dict[str, Any]] = None
) -> List[Dict[str, Any]]:
    res: List[Dict[str, Any]] = rockset.RocksetClient(
        host="api.rs2.usw2.rockset.com", api_key=os.environ["ROCKSET_API_KEY"]
    ).sql(query, params=params)
    return res


def get_failed_tests():
    current_time = datetime.datetime.now()
    failed_tests = query_rockset(
        FAILED_TESTS_QUERY,
        {
            "stopTime": current_time.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "startTime": (current_time - datetime.timedelta(days=5)).strftime(
                "%Y-%m-%dT%H:%M:%S.000Z"
            ),
        },
    )
    return failed_tests.results


def upload_to_rockset(
    collection: str, docs: List[Any], workspace: str = "commons"
) -> None:
    client = rockset.RocksetClient(
        host="api.usw2a1.rockset.com", api_key=os.environ["ROCKSET_API_KEY"]
    )
    client.Documents.add_documents(
        collection=collection,
        data=docs,
        workspace=workspace,
    )


def run_command(command):
    cwd = REPO_ROOT / ".." / "pytorch"
    return subprocess.check_output(
        command.split(" "),
        cwd=cwd,
    ).decode("utf-8").strip()


def get_merge_bases(failed_tests):
    merge_bases = {}
    for i in range(0, len(failed_tests), 100):
        all_shas = " ".join(test['head_sha'] for test in failed_tests[i:i + 100])
        run_command(
            f"git -c protocol.version=2 fetch --no-tags --prune --quiet --no-recurse-submodules origin {all_shas}"
        )
        print(f"{i}/{len(failed_tests)}")

    for test in failed_tests:
        sha = test["head_sha"]
        if sha in merge_bases:
            continue
        try:
            merge_base = run_command(f"git merge-base main {sha}")
            if merge_base == sha:
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
        docs.append({
            "sha": sha,
            **info
        })
    upload_to_rockset(
        collection="merge_bases",
        docs=docs,
        workspace="commons"
    )
    return docs


if __name__ == "__main__":
    failed_tests = get_failed_tests()
    merge_bases = get_merge_bases(failed_tests)
    print(json.dumps(merge_bases, indent=2))
