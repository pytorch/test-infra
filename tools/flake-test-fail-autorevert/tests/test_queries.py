from typing import Any, Dict, List, Tuple

from flake_test_fail_autorevert.queries import (
    fetch_advisor_verdicts,
    fetch_flaky_for_day,
    fetch_regressions,
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
