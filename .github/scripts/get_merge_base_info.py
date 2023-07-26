from typing import Optional, Dict, Any, List
import rockset  # type: ignore[import]
import datetime
import os
import subprocess

FAILED_TESTS_QUERY = """
SELECT
    distinct t.invoking_file,
    t.name,
    t.classname,
    t.file,
    j.head_sha,
    j.name as job_name
FROM
    commons.failed_tests_run t
    join workflow_job j on t.job_id = j.id
where
    t._event_time >= PARSE_TIMESTAMP_ISO8601(:startTime)
    and t._event_time < PARSE_TIMESTAMP_ISO8601(:stopTime)
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
            "startTime": (current_time - datetime.timedelta(days=2)).strftime(
                "%Y-%m-%dT%H:%M:%S.000Z"
            ),
        },
    )
    print(failed_tests)
    return failed_tests.results


def get_merge_bases(failed_tests):
    merge_bases = {}

    for test in failed_tests:
        sha = test["head_sha"]
        if sha in merge_bases:
            continue
        try:
            merge_base = (
                subprocess.check_output(
                    f"git merge-base main {sha}".split(" "),
                    cwd="/Users/csl/zzzzzzzz/pytorch",
                )
                .decode("utf-8")
                .strip()
            )
            if merge_base == sha:
                merge_base = (
                    subprocess.check_output(
                        f"git rev-parse {sha}^".split(" "),
                        cwd="pytorch",
                    )
                    .decode("utf-8")
                    .strip()
                )
            changed_files = (
                subprocess.check_output(
                    f"git diff {sha} {merge_base} --name-only".split(" "),
                    cwd="pytorch",
                )
                .decode("utf-8")
                .strip()
            )
            merge_bases[sha] = {
                "merge_base": merge_base,
                "changed_files": changed_files.splitlines(),
            }
        except KeyboardInterrupt:
            break
        except Exception:
            print(f"{sha} failed??")
    return merge_bases


if __name__ == "__main__":
    failed_tests = get_failed_tests()
    merge_bases = get_merge_bases(failed_tests)
    print(merge_bases)
