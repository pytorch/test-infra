"""job_trace's ClickHouse parameters and command line, with ClickHouse mocked."""

import gzip
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_job_trace import MULTI_JOBS, MULTI_RUNS, TOY_JOBS, TOY_RUNS
from torchci.job_trace import query
from torchci.job_trace.__main__ import main
from torchci.job_trace.trace import build_trace


def as_json_each_row(rows):
    # JSONEachRow quotes 64-bit integers.
    return [
        {k: str(v) if k in ("job", "start_ms", "end_ms") else v for k, v in r.items()}
        for r in rows
    ]


class TestFetch(unittest.TestCase):
    def test_passes_job_ids_and_owner_as_parameters(self) -> None:
        calls = []

        def fake_query(sql, params):
            calls.append((sql, params))
            return as_json_each_row(TOY_JOBS if sql is query.JOBS_QUERY else TOY_RUNS)

        with patch.object(query, "query_clickhouse", fake_query):
            jobs, runs = query.fetch([1, 2], "inductor")
        self.assertEqual(
            [c[1] for c in calls],
            [{"job_ids": [1, 2]}, {"job_ids": [1, 2], "owner": "inductor"}],
        )
        self.assertIn("has(o.owners, {owner:String})", query.RUNS_QUERY)
        self.assertEqual((jobs, runs), (TOY_JOBS, TOY_RUNS))

    def test_no_owner_keeps_every_file(self) -> None:
        with patch.object(query, "query_clickhouse", return_value=[]) as fake:
            query.fetch([1])
        self.assertEqual(fake.call_args_list[1].args[1]["owner"], "")
        self.assertIn("{owner:String} = ''", query.RUNS_QUERY)


class TestMain(unittest.TestCase):
    def test_writes_gzipped_trace_for_several_jobs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch(
            "torchci.job_trace.__main__.fetch",
            return_value=(TOY_JOBS + MULTI_JOBS, TOY_RUNS + MULTI_RUNS),
        ) as fake_fetch:
            out = Path(tmp) / "trace.json.gz"
            main(["2", "1", "-o", str(out), "--owner", "core"])
            with gzip.open(out, "rt") as f:
                written = json.load(f)
        fake_fetch.assert_called_once_with([2, 1], "core")
        expected, _ = build_trace([2, 1], TOY_JOBS + MULTI_JOBS, TOY_RUNS + MULTI_RUNS)
        self.assertEqual(written, expected)

    def test_owner_shows_on_report_slices(self) -> None:
        trace, _ = build_trace([1], TOY_JOBS, TOY_RUNS)
        owners = {
            e["name"]: e["args"]["owners"]
            for e in trace["traceEvents"]
            if e.get("cat") == "report"
        }
        self.assertEqual(
            owners, {"test/test_a.py": "core", "test/test_b.py": "inductor"}
        )


if __name__ == "__main__":
    unittest.main()
