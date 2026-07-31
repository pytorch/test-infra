import argparse
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Tuple

import flake_test_fail_autorevert.__main__ as m
from flake_test_fail_autorevert.premerge import PremergeContext


TS = datetime(2026, 6, 18, 16, 43, 39, tzinfo=timezone.utc)


class _StubReg:
    by_commit: Dict[str, Any] = {}
    single_workflow: Dict[Any, Any] = {}


def test_context_resolved_once_per_commit_via_collect(monkeypatch) -> None:
    # FIX C: N signals on one commit must resolve head/ts/jobs ONCE, not N times.
    resolves: List[str] = []

    def fake_resolve(client, commit_sha, repo="pytorch/pytorch"):
        resolves.append(commit_sha)
        return PremergeContext("h", TS, TS, [1], False, None)

    classifies: List[Tuple[str, str]] = []

    def fake_classify(client, context, file, name):
        classifies.append((file, name))
        return "RUN_FAILED"

    sha = "Z" * 40
    rows = [
        {
            "commit_sha": sha,
            "category": "regression",
            "workflow": "trunk",
            "signal_key": f"test_{i}.py::t",
        }
        for i in range(4)
    ]

    monkeypatch.setattr(m, "get_clickhouse_client", lambda: object())
    monkeypatch.setattr(m, "fetch_regressions", lambda *a, **k: _StubReg())
    monkeypatch.setattr(m, "fetch_flaky_for_day", lambda *a, **k: set())
    monkeypatch.setattr(m, "fetch_commit_times", lambda *a, **k: {})
    monkeypatch.setattr(m, "fetch_advisor_verdicts", lambda *a, **k: {})
    monkeypatch.setattr(m, "fetch_commit_messages", lambda *a, **k: {sha: "Title (#1)"})
    monkeypatch.setattr(m, "build_rows", lambda *a, **k: rows)
    monkeypatch.setattr(m, "iter_time_chunks", lambda *a, **k: iter(()))
    monkeypatch.setattr(m, "resolve_premerge_context", fake_resolve)
    monkeypatch.setattr(m, "classify_with_context", fake_classify)

    args = argparse.Namespace(
        start=date(2026, 7, 1),
        end=date(2026, 7, 1),
        repo="pytorch/pytorch",
        output=None,
    )
    result = m.collect(args)

    assert resolves == [sha]  # resolved exactly once for all 4 signals
    assert len(classifies) == 4  # classified per signal
    assert all(r["premerge_status"] == "RUN_FAILED" for r in result)


def test_flaky_only_commit_gets_empty_premerge_status(monkeypatch) -> None:
    # A flaky-category row (not trunk/pull regression) never gets a premerge lookup and
    # keeps premerge_status "" — the collect loop must not resolve context for it.
    resolves: List[str] = []

    def fake_resolve(client, commit_sha, repo="pytorch/pytorch"):
        resolves.append(commit_sha)
        return PremergeContext(None, None, None, [], False, "ERROR")

    sha = "Y" * 40
    rows = [
        {
            "commit_sha": sha,
            "category": "flaky",
            "workflow": "trunk",
            "signal_key": "test_x.py::t",
        }
    ]

    monkeypatch.setattr(m, "get_clickhouse_client", lambda: object())
    monkeypatch.setattr(m, "fetch_regressions", lambda *a, **k: _StubReg())
    monkeypatch.setattr(m, "fetch_flaky_for_day", lambda *a, **k: set())
    monkeypatch.setattr(m, "fetch_commit_times", lambda *a, **k: {})
    monkeypatch.setattr(m, "fetch_advisor_verdicts", lambda *a, **k: {})
    monkeypatch.setattr(m, "fetch_commit_messages", lambda *a, **k: {})
    monkeypatch.setattr(m, "build_rows", lambda *a, **k: rows)
    monkeypatch.setattr(m, "iter_time_chunks", lambda *a, **k: iter(()))
    monkeypatch.setattr(m, "resolve_premerge_context", fake_resolve)

    args = argparse.Namespace(
        start=date(2026, 7, 1),
        end=date(2026, 7, 1),
        repo="pytorch/pytorch",
        output=None,
    )
    result = m.collect(args)

    assert resolves == []  # no premerge resolution for flaky rows
    assert result[0]["premerge_status"] == ""
