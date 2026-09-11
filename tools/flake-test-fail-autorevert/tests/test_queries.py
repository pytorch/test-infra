from typing import Any, Dict, List, Tuple

from flake_test_fail_autorevert.queries import (
    fetch_advisor_verdicts,
    fetch_failing_configs,
    fetch_flaky_for_day,
    fetch_pull_runs,
    fetch_regressions,
    parse_build_env_test_config,
)


REPO = "pytorch/pytorch"


class _Result:
    def __init__(self, rows: List[Tuple[Any, ...]]) -> None:
        self.result_rows = rows


class FakeClient:
    def __init__(self, rows: List[Tuple[Any, ...]]) -> None:
        self._rows = rows
        self.calls: List[Dict[str, Any]] = []

    def query(self, query: str, parameters: Dict[str, Any]) -> _Result:
        self.calls.append(parameters)
        return _Result(self._rows)


def _dt(day: int):
    from datetime import datetime

    return datetime(2026, 7, day)


def test_fetch_regressions_single_workflow_sole():
    sha = "a" * 40
    client = FakeClient([(sha, "f.py::t", ["trunk"])])
    reg = fetch_regressions(client, REPO, _dt(1), _dt(3))
    assert reg.by_commit == {sha: {"f.py::t"}}
    assert reg.single_workflow == {(sha, "f.py::t"): "trunk"}


def test_fetch_regressions_distinct_sole_workflows_attributed_per_signal():
    sha = "b" * 40
    client = FakeClient(
        [
            (sha, "A.py::t", ["trunk"]),
            (sha, "B.py::t", ["pull"]),
        ]
    )
    reg = fetch_regressions(client, REPO, _dt(1), _dt(3))
    assert reg.by_commit == {sha: {"A.py::t", "B.py::t"}}
    assert reg.single_workflow == {
        (sha, "A.py::t"): "trunk",
        (sha, "B.py::t"): "pull",
    }


def test_fetch_regressions_single_signal_two_workflows_is_none():
    sha = "b" * 40
    client = FakeClient([(sha, "f.py::t", ["pull", "trunk"])])
    reg = fetch_regressions(client, REPO, _dt(1), _dt(3))
    assert reg.by_commit == {sha: {"f.py::t"}}
    assert reg.single_workflow == {(sha, "f.py::t"): None}


def test_fetch_regressions_per_signal_workflow_is_order_independent():
    sha = "c" * 40
    rows = [
        (sha, "a.py::t", ["trunk"]),
        (sha, "z.py::t", ["pull"]),
    ]
    forward = fetch_regressions(FakeClient(rows), REPO, _dt(1), _dt(3))
    backward = fetch_regressions(FakeClient(list(reversed(rows))), REPO, _dt(1), _dt(3))
    expected = {(sha, "a.py::t"): "trunk", (sha, "z.py::t"): "pull"}
    assert forward.single_workflow == expected
    assert backward.single_workflow == expected


def test_fetch_regressions_filters_non_test_signals():
    sha = "d" * 40
    client = FakeClient(
        [
            (sha, "linux-jammy / test [test]", ["pull"]),
            (sha, "f.py::t", ["pull"]),
        ]
    )
    reg = fetch_regressions(client, REPO, _dt(1), _dt(3))
    assert reg.by_commit == {sha: {"f.py::t"}}
    assert reg.single_workflow == {(sha, "f.py::t"): "pull"}


def test_fetch_advisor_verdicts_unpacks_workflow_and_confidence():
    sha = "e" * 40
    client = FakeClient([(sha, "f.py::t", ("related", 0.987, "inductor"))])
    verdicts = fetch_advisor_verdicts(client, REPO, [sha])
    assert verdicts == {(sha, "f.py::t"): ("related", 0.987, "inductor")}


def test_fetch_advisor_verdicts_empty_workflow_becomes_none():
    sha = "f" * 40
    client = FakeClient([(sha, "f.py::t", ("not_related", 0.5, ""))])
    verdicts = fetch_advisor_verdicts(client, REPO, [sha])
    assert verdicts[(sha, "f.py::t")] == ("not_related", 0.5, None)


def test_fetch_advisor_verdicts_none_confidence_preserved():
    sha = "0" * 40
    client = FakeClient([(sha, "f.py::t", ("related", None, "trunk"))])
    verdicts = fetch_advisor_verdicts(client, REPO, [sha])
    assert verdicts[(sha, "f.py::t")] == ("related", None, "trunk")


def test_fetch_flaky_for_day_emits_workflow_signal_commit_and_filters():
    client = FakeClient(
        [
            ("trunk", "f.py::t", "a" * 40),
            ("pull", "job [test]", "b" * 40),
        ]
    )
    found = fetch_flaky_for_day(client, REPO, _dt(1), _dt(2))
    assert found == {("trunk", "f.py::t", "a" * 40)}


def test_fetch_pull_runs_returns_id_attempt_pairs_and_binds_head():
    client = FakeClient([(100, 1), (200, 2)])
    runs = fetch_pull_runs(client, "h" * 40)
    assert runs == [(100, 1), (200, 2)]
    assert client.calls == [{"head_sha": "h" * 40}]


# --- parse_build_env_test_config ---


def test_parse_build_env_test_config_full_job_name():
    assert parse_build_env_test_config(
        "linux-jammy-py3.10-gcc11 / test (distributed, 1, 8, mt-l-x86iamx-8-64)"
    ) == ("linux-jammy-py3.10-gcc11", "distributed")


def test_parse_build_env_test_config_single_shard_no_comma():
    assert parse_build_env_test_config("env-x / test (default)") == ("env-x", "default")


def test_parse_build_env_test_config_non_test_job_is_none():
    assert parse_build_env_test_config("linux-jammy-py3.10-gcc11 / build") is None
    assert parse_build_env_test_config("garbage") is None


# --- fetch_failing_configs (two scripted queries) ---


class RoutedClient:
    """Serves MAIN_JOBS_SQL and MAIN_FAILING_TESTS_SQL distinct rows, keyed by table name."""

    def __init__(
        self, jobs: List[Tuple[Any, ...]], failing: List[Tuple[Any, ...]]
    ) -> None:
        self._jobs = jobs
        self._failing = failing
        self.calls: List[str] = []

    def query(self, query: str, parameters: Dict[str, Any] = None) -> _Result:  # type: ignore[assignment]
        self.calls.append(query)
        if "default.workflow_job" in query:
            return _Result(self._jobs)
        return _Result(self._failing)


def test_fetch_failing_configs_maps_job_ids_to_configs():
    jobs = [
        (10, "linux-jammy-py3.10-gcc11 / test (default, 1, 3, r)"),
        (11, "linux-jammy-cuda13.0-py3.10-gcc11 / test (distributed, 1, 2, r)"),
        (12, "linux-jammy-py3.10-gcc11 / build"),  # unparseable -> dropped
    ]
    failing = [
        (10, "test_a.py", "TestX::t1"),
        (11, "test_a.py", "TestX::t1"),
        (11, "test_b.py", "TestY::t2"),
        (999, "test_c.py", "z"),  # job_id absent from the map -> ignored
    ]
    client = RoutedClient(jobs, failing)
    fc = fetch_failing_configs(client, "M" * 40, _dt(1), _dt(2), _dt(1))
    assert fc == {
        ("test_a.py", "TestX::t1"): {
            ("linux-jammy-py3.10-gcc11", "default"),
            ("linux-jammy-cuda13.0-py3.10-gcc11", "distributed"),
        },
        ("test_b.py", "TestY::t2"): {
            ("linux-jammy-cuda13.0-py3.10-gcc11", "distributed")
        },
    }


def test_fetch_failing_configs_skips_second_query_when_no_parseable_jobs():
    client = RoutedClient([(1, "env / build")], [(1, "f.py", "n")])
    fc = fetch_failing_configs(client, "M" * 40, _dt(1), _dt(2), _dt(1))
    assert fc == {}
    # With no parseable test jobs, the failing-tests query must NOT run.
    assert all("tests.all_test_runs" not in q for q in client.calls)
