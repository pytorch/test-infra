"""
Run via `python tools/torchci/td/get_reverts_caused_by_td.py`.  Highly recommend
piping the output to a file.

Determines which reverts were caused by bad TD exclusions for reverts in the
past year.  It expects the folder setup to have test-infra and pytorch in the
same folder, and will use whatever branch is currently checked out on pytorch.
"""

import argparse
import re
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Optional

import requests
from torchci.clickhouse import query_clickhouse
from torchci.utils import run_command


@dataclass
class JobFailure:
    torchci_classification_line: str
    job_name: str
    run_id: int
    failed_test: Optional[str] = None


@dataclass
class CommitInfo:
    id: str
    merge_commit_sha: str
    merge_commit_sha_prev: str
    revert_commit_sha: str
    revert_commit_sha_prev: str
    timestamp_of_revert: int = 0
    timestamp_of_merge: int = 0
    pr_num: int = 0
    last_pr_sha: Optional[str] = None
    run_ids: list[int] = field(default_factory=list)


class IndentPrinter:
    def __init__(self, indent_str="  "):
        self.level = 0
        self.indent_str = indent_str

    def print(self, *args, **kwargs):
        indent = self.indent_str * self.level
        print(indent + " ".join(map(str, args)), **kwargs)

    def indent(self):
        self.level += 1

    def dedent(self):
        self.level = max(self.level - 1, 0)

    def __enter__(self):
        self.indent()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.dedent()


p = IndentPrinter()

# Match against things like Reverted https://github.com/pytorch/pytorch/pull/155998 on behalf of https://github.com/malfet due to
REVERT_REGEX = r"(?s)This reverts commit (.*)\..*Reverted https:\/\/github.com\/pytorch\/pytorch\/pull\/(\d+) on behalf of"
# Matches stuff like FAILED [2.1965s] inductor/test_analysis.py::TestAnalysisCUDA::test_augment_trace_against_flop_counter_maxat0_cuda_float16 - IndexError: list index out of range
FAILED_TEST_REGEX = r"FAILED \[.*\] (.*)\.py::.*"
# Matches stuff like The following tests failed consistently: ['test/inductor/test_distributed_patterns.py::DistributedPatternTests::test_nn_param_return3']
CONSISTENTLY_FAILED_TEST_REGEX = (
    r"The following tests failed consistently: \['test/(.*).py::.*'\]"
)

JOB_NAME_REGEX = r"(.*) / test \(([^,]*), .*\)"

COMMIT_INFO_QUERY = """
select
    last_commit_sha,
    merge_commit_sha
from
    default .merges
where
    merge_commit_sha in {shas: Array(String) }
"""

TORCHCI_CLASSIFICATION_QUERY = """
select
    name as job_name,
    run_id as run_id,
    torchci_classification.line as line,
    head_sha
from
    default.workflow_job
where
    head_sha in {shas: Array(String)}
    and conclusion = 'failure'
    and workflow_name in ('pull', 'trunk', 'periodic', 'slow')
"""

WORKFLOW_ID_QUERY = """
select
    id,
    head_sha,
    toUnixTimestamp(created_at) as created_at
from
    default .workflow_run
where
    head_sha in {shas: Array(String) }
    and name in ('pull', 'trunk', 'periodic', 'slow')
"""


GHSTACK_PR_COMMIT_QUERY = """
with head_branches as (
    select
        head.ref as head_branch,
        number
    from
        default .pull_request
    where
        number in {pr_numbers: Array(Int64)}
)
select
    distinct toUnixTimestamp(w.created_at) as timestamp,
    w.head_sha as head_sha,
    h.number as pr_number
from
    default .workflow_run w
    join head_branches h on w.head_branch = h.head_branch
where
    w.head_branch in (
        select
            head_branch
        from
            head_branches
    )
    and w.name = 'pull'
"""

SHAS_WITH_JOBS_ON_MAIN_QUERY = """
select
    distinct head_sha
from
    default .workflow_run
where
    head_branch = 'main'
    and name = 'pull'
"""


def get_git_log() -> list[tuple[str, int, str]]:
    """Fetches commit sha and message for all commits"""
    return [
        line.split(" ", 2)
        for line in run_command(["git", "log", "--pretty=%H %ct %s"]).splitlines()
    ]


def get_full_commit_message(sha: str) -> str:
    """Fetches the full commit message for a given SHA"""
    return run_command(["git", "log", "-1", "--pretty=%B", sha]).strip()


@lru_cache
def get_td_exclusions(run_ids: tuple[int]) -> dict:
    """Fetches the TD exclusions for some run ids."""
    exclusions = defaultdict(lambda: defaultdict(list))
    for run_id in run_ids:
        for i in range(3):
            response = requests.get(
                f"https://ossci-raw-job-status.s3.amazonaws.com/additional_info/td_exclusions/{run_id}/{i + 1}"
            )
            if response.status_code == 200:
                for build_env, test_configs in response.json().items():
                    for test_config, tests in test_configs.items():
                        exclusions[build_env][test_config].extend(tests)
    return dict(exclusions)


@lru_cache
def get_failures_additional_test_info(
    run_id: int,
) -> list[dict[str, Any]]:
    """Fetches additional test info for failures in the given run_id."""

    query = """
with job as (
    select
        distinct id,
        regexp_replace(
            name,
            '(\\([^,]+, )(?:[0-9]+, )*(?:lf\\.)?([^)]+\\))',
            '\\1\\2'
        ) AS name,
        workflow_name,
        labels
    from
        default .workflow_job
    where
        run_id in {workflowIds: Array(Int64) }
)
SELECT
    replaceAll(invoking_file, '.', '/') as invoking_file,
    all_test_runs.name as name,
    classname,
    multiIf(
        countIf(
            failure_count = 0
            AND error_count = 0
            AND skipped_count = 0
            AND rerun_count = 0
        ) = count(*),
        'success',
        sum(skipped_count) > 0,
        'skipped',
        countIf(
            failure_count = 0
            AND error_count = 0
        ) > 0,
        'flaky',
        'failure'
    ) AS status,
    job.name AS job_name,
    job.workflow_name as workflow_name
FROM
    tests.all_test_runs
    JOIN job ON job.id = all_test_runs.job_id
WHERE
    job_id IN (
        SELECT
            id
        FROM
            job
    )
GROUP BY
    invoking_file,
    name,
    classname,
    job.name,
    job.workflow_name
having
    status = 'failure'
    """
    return query_clickhouse(
        query,
        {"workflowIds": [run_id]},
    )


def get_test_file(torchci_classification_line: str) -> Optional[str]:
    """Extracts the test file from the torchci classification line."""
    match = re.search(FAILED_TEST_REGEX, torchci_classification_line)
    if match:
        return match.group(1)
    match = re.search(CONSISTENTLY_FAILED_TEST_REGEX, torchci_classification_line)
    if match:
        return match.group(1)
    return None


def get_commit_info(num_to_process: int) -> list[CommitInfo]:
    shas = get_git_log()

    commits_reverted: list[CommitInfo] = []
    sha_to_idx = {sha[0]: i for i, sha in enumerate(shas)}

    def process_sha(i: int) -> Optional[CommitInfo]:
        item = shas[i]
        sha, timestamp, message = item
        if not message.startswith('Revert "') or not message.endswith('"'):
            return None
        full_message = get_full_commit_message(sha)
        if (x := re.search(REVERT_REGEX, full_message)) is not None:
            reverted_sha = x.group(1)
            reverted_pr = x.group(2)
            if reverted_sha not in sha_to_idx:
                p.print(
                    f"Reverted commit {reverted_sha} not found in the log, skipping revert commit {sha}"
                )
                return None
            return CommitInfo(
                id=sha,
                merge_commit_sha=reverted_sha,
                merge_commit_sha_prev=shas[sha_to_idx[reverted_sha] + 1][0],
                revert_commit_sha=sha,
                revert_commit_sha_prev=shas[i + 1][0],
                timestamp_of_revert=int(timestamp),
                pr_num=int(reverted_pr),
                timestamp_of_merge=int(shas[sha_to_idx[reverted_sha]][1]),
            )
        return None

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(process_sha, range(num_to_process)))
    commits_reverted = [r for r in results if r is not None]

    # Retrieve the last commit on the PR aka the commit that got merged
    merged_commit_info = query_clickhouse(
        COMMIT_INFO_QUERY,
        {"shas": [x.merge_commit_sha for x in commits_reverted]},
    )
    for row in merged_commit_info:
        last_pr_sha = row["last_commit_sha"]
        merge_commit_sha = row["merge_commit_sha"]
        for commit in commits_reverted:
            if commit.merge_commit_sha == merge_commit_sha:
                commit.last_pr_sha = last_pr_sha

    # For ghstacked PRs, we might not have jobs on the revert or merge commits.
    # Instead, we will crawl up/down the git log until we find a commit that
    # does have jobs
    all_run_ids = query_clickhouse(SHAS_WITH_JOBS_ON_MAIN_QUERY, {})
    run_ids_present = set(row["head_sha"] for row in all_run_ids)
    for commit in commits_reverted:
        while commit.merge_commit_sha not in run_ids_present:
            commit.merge_commit_sha = shas[sha_to_idx[commit.merge_commit_sha] - 1][0]
        while commit.merge_commit_sha_prev not in run_ids_present:
            commit.merge_commit_sha_prev = shas[
                sha_to_idx[commit.merge_commit_sha_prev] + 1
            ][0]
        while commit.revert_commit_sha not in run_ids_present:
            commit.revert_commit_sha = shas[sha_to_idx[commit.revert_commit_sha] - 1][0]
        while commit.revert_commit_sha_prev not in run_ids_present:
            commit.revert_commit_sha_prev = shas[
                sha_to_idx[commit.revert_commit_sha_prev] + 1
            ][0]

    # For ghstacked PRs, we might not have info about which sha got merged
    # because it was merged as a stack, so we query to the most recent workflow
    # run before the merge
    ghstack_last_pr_commits = query_clickhouse(
        GHSTACK_PR_COMMIT_QUERY,
        {"pr_numbers": [x.pr_num for x in commits_reverted]},
    )
    bad = 0
    for commit in commits_reverted:
        alt_last_pr_sha = ("", 0)
        for row in ghstack_last_pr_commits:
            timestamp = int(row["timestamp"])
            if (
                int(row["pr_number"]) == commit.pr_num
                and alt_last_pr_sha[1] < timestamp < commit.timestamp_of_merge
            ):
                alt_last_pr_sha = (row["head_sha"], timestamp)
        if alt_last_pr_sha[0] != commit.last_pr_sha and commit.last_pr_sha is not None:
            p.print(
                f"commit={commit.id} "
                f"pr={commit.pr_num} "
                f"merge={commit.merge_commit_sha} "
                f"timestamp_of_merge={commit.timestamp_of_merge} "
                f"found last pr sha != alt, {commit.last_pr_sha} != {alt_last_pr_sha[0]}"
            )
            bad += 1
        if commit.last_pr_sha is None:
            commit.last_pr_sha = alt_last_pr_sha[0]
    p.print(
        f"Found {bad}, {bad / len(commits_reverted):<.2%} where last pr sha != alt last pr sha"
    )

    # Get the run_id for the jobs on the pr
    run_ids = query_clickhouse(
        WORKFLOW_ID_QUERY,
        {
            "shas": [
                x.last_pr_sha for x in commits_reverted if x.last_pr_sha is not None
            ]
        },
    )
    for row in run_ids:
        run_id = row["id"]
        head_sha = row["head_sha"]
        created_at = row["created_at"]
        for commit in commits_reverted:
            if (
                commit.last_pr_sha == head_sha
                and created_at < commit.timestamp_of_merge
            ):
                commit.run_ids.append(int(run_id))
    return commits_reverted


def get_job_failures(shas: list[str]) -> dict[str, list[JobFailure]]:
    """Fetches job failures for the given SHAs."""
    # Need to batch in case too many SHAs
    batch_size = 500
    failures_dict: dict[str, list[JobFailure]] = {}
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = []
        for i in range(0, len(shas), batch_size):
            futures.append(
                executor.submit(
                    query_clickhouse,
                    TORCHCI_CLASSIFICATION_QUERY,
                    {"shas": shas[i : i + batch_size]},
                )
            )

    for future in futures:
        job_failures = future.result()
        for row in job_failures:
            head_sha = row["head_sha"]
            job_name = row["job_name"]
            run_id = row["run_id"]
            line = row["line"]
            if head_sha not in failures_dict:
                failures_dict[head_sha] = []
            failures_dict[head_sha].append(
                JobFailure(
                    torchci_classification_line=line,
                    job_name=job_name,
                    run_id=int(run_id),
                    failed_test=get_test_file(line),
                )
            )
    del futures

    futures2 = []
    with ThreadPoolExecutor(max_workers=8) as executor:
        for sha, failures in failures_dict.items():
            run_ids = set(f.run_id for f in failures if f.run_id is not None)
            for run_id in run_ids:
                futures2.append((sha, executor.submit(get_failures_for_run_id, run_id)))
    for sha, future in futures2:
        additional_failures = future.result()
        failures_dict[sha].extend(additional_failures)
    return failures_dict


@lru_cache
def get_failures_for_run_id(run_id: int) -> list[JobFailure]:
    """Fetches the failures for the given run_id."""
    failures = get_failures_additional_test_info(run_id)

    job_failures = []

    for test in failures:
        workflow_name = test["workflow_name"]
        job_name = test["job_name"]
        test_file = test["invoking_file"]
        test_name = test["name"]
        test_class = test["classname"]
        job_failures.append(
            JobFailure(
                torchci_classification_line=f"{test_file}::{test_class}::{test_name}",
                job_name=f"{workflow_name} / {job_name}",
                run_id=run_id,
                failed_test=f"{test_file}",
            )
        )
    return job_failures


def check_failure_in_td_exclusion(f: JobFailure, run_ids: list[int]) -> bool:
    """True if the commit is bad (excluded in TD)"""
    x = re.search(JOB_NAME_REGEX, f.job_name)
    if x is None:
        p.print(
            f"Failed to parse job name {f.job_name} for failure {f.torchci_classification_line}"
        )
        return False

    td_exclusions = get_td_exclusions(tuple(run_ids))
    build_env = x.group(1)
    test_config = x.group(2)
    p.print(
        f"Build environment: {build_env}, Test config: {test_config}, len(td_exclusions): {len(td_exclusions)}"
    )
    if len(td_exclusions) == 0:
        p.print(f"No TD exclusions found for run {run_ids}")
        return False
    if build_env not in td_exclusions:
        p.print(
            f"Build environment {build_env} not found in TD exclusions for run {run_ids}"
        )
    elif test_config not in td_exclusions[build_env]:
        p.print(f"Test {test_config} not found in TD exclusions for run {run_ids}")
    elif f.failed_test in td_exclusions[build_env][test_config]:
        p.print(f"Test {f.failed_test} is excluded in TD for run {run_ids}")
        return True
    else:
        p.print(f"Test {f.failed_test} is not excluded in TD for run {run_ids}")
    return False


def check_on_commit(
    sha: str, job_name: str, test_file: str, failures: dict[str, list[JobFailure]]
) -> bool:
    """True if the test failed on the given commit."""
    for failure in failures.get(sha, []):
        if failure.failed_test == test_file:
            return True
    return False


def main() -> None:
    args = parse_args()
    commits_reverted = get_commit_info(args.num)

    all_shas = [
        v
        for x in commits_reverted
        for v in [
            x.revert_commit_sha,
            x.merge_commit_sha,
            x.merge_commit_sha_prev,
            x.last_pr_sha,
            # x.revert_commit_sha_prev,
        ]
        if v is not None
    ]

    job_failures = get_job_failures(all_shas)

    # See if the test was excluded in TD on the pr commit
    caused_by_bad_td: list[CommitInfo] = []
    unable_to_check = 0
    for i, s in enumerate(commits_reverted):
        p.print(f"Checking revert commit {s.id}")
        with p:
            p.print(f"Revert commit: {s.revert_commit_sha}")
            p.print(f"Revert commit prev: {s.revert_commit_sha_prev}")
            p.print(f"Merge commit: {s.merge_commit_sha}")
            p.print(f"Merge commit prev: {s.merge_commit_sha_prev}")
            p.print(f"Last PR sha: {s.last_pr_sha}")
            p.print(f"Run ID: {s.run_ids}")
            if len(s.run_ids) == 0:
                p.print(f"Run ID is None for commit {s.last_pr_sha}, skipping")
                unable_to_check += 1
                continue
            any_bad = False
            for f in job_failures.get(s.merge_commit_sha, []):
                with p:
                    p.print(
                        f"Failure: {f.job_name}, {f.torchci_classification_line}, {f.failed_test}"
                    )

                    if f.failed_test is None:
                        continue
                    with p:
                        if check_on_commit(
                            s.revert_commit_sha, f.job_name, f.failed_test, job_failures
                        ):
                            p.print(
                                f"Failure {f.failed_test} is present on the revert commit {s.revert_commit_sha}"
                            )
                            continue
                        if check_on_commit(
                            s.merge_commit_sha_prev,
                            f.job_name,
                            f.failed_test,
                            job_failures,
                        ):
                            p.print(
                                f"Failure {f.failed_test} is present on commit before the merge {s.merge_commit_sha_prev}"
                            )
                            continue

                        any_bad |= check_failure_in_td_exclusion(f, s.run_ids)
            if any_bad:
                caused_by_bad_td.append(s)
                p.print(
                    f"Commit {s.last_pr_sha} with run_id {s.run_ids} is caused by bad TD"
                )
        p.print(
            f"CAUSED BY BAD TD: {len(caused_by_bad_td)} / {i + 1} = {len(caused_by_bad_td) / (i + 1):.2%}"
        )
        p.print(
            f"Unable to check (lack run id) on PR: {unable_to_check} / {i + 1} = {unable_to_check / (i + 1):.2%}"
        )

    p.print(
        f"Total caused by bad TD: {len(caused_by_bad_td)} / {len(commits_reverted)} = {len(caused_by_bad_td) / len(commits_reverted):.2%}"
    )
    # Group by month, this is a massive oversimplification, but we'll take it
    month_groups = {}
    for commit in caused_by_bad_td:
        month = commit.timestamp_of_revert // (30 * 24 * 60 * 60)
        if month not in month_groups:
            month_groups[month] = (0, 0)
        month_groups[month] = (month_groups[month][0] + 1, month_groups[month][1])
    for commit in commits_reverted:
        month = commit.timestamp_of_merge // (30 * 24 * 60 * 60)
        if month not in month_groups:
            month_groups[month] = (0, 0)
        month_groups[month] = (month_groups[month][0], month_groups[month][1] + 1)

    for month, (bad_td_count, total_count) in sorted(month_groups.items()):
        p.print(
            f"Month {month}: {bad_td_count} bad TD / {total_count} total = {bad_td_count / total_count:.2%}"
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Get reverts caused by bad TD exclusions."
    )
    parser.add_argument(
        "--num", type=int, default=2000, help="Number of commits to examine"
    )
    return parser.parse_args()


if __name__ == "__main__":
    main()
