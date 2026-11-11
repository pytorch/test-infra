import gzip
import json
import os
import re
import sys
import tempfile
from datetime import date, datetime
from pathlib import Path
from unittest import main, mock, skipUnless, TestCase

import numpy as np
from torchci.td.scorer import logs, rows, rows_sql, shards, store, trunk


TS = "2026-11-05T10:00:00.1234567Z "


def log_text(lines):
    return "\n".join(TS + line for line in lines)


LOG = log_text(
    [
        "Received 3 tests to prioritize",
        "  test_nn",
        "  test_ops",
        "  inductor/test_x",
        "base_commit: abc",
        "Changed files: ['torch/nn/a.py', 'test/test_nn.py']",
        "Results from PreviouslyFailedInPR",
        "",
        "Results from Filepath",
        "  test_nn (0.25)",
        "  test_nn, TestFoo (0.5)",
        "  test_ops, not TestBar (1e-05)",
        "  inductor/test_x (nan)",
        "Changed files: ['ignored.py']",
        "Error in LLM: boom",
        "Results from Profiling",
        "  test_ops (-0.1)",
        "Aggregated Heuristics",
        "  test_nn (0.75)",
        "  test_nn, TestFoo (0.8)",
        "  test_ops (0.0)",
        "Emitting metrics",
        "  test_late (9.0)",
    ]
)


class TestLogs(TestCase):
    def test_parse(self) -> None:
        parsed = logs.parse_td_log(LOG)
        assert parsed is not None
        self.assertEqual(
            parsed.scores,
            {
                "PreviouslyFailedInPR": {},
                "Filepath": {"test_nn": 0.5, "test_ops": 1e-05},
                "Profiling": {"test_ops": -0.1},
            },
        )
        self.assertEqual(
            parsed.heuristics, ("Filepath", "PreviouslyFailedInPR", "Profiling")
        )
        self.assertEqual(parsed.raised, ("LLM",))
        self.assertEqual(parsed.changed_files, ("torch/nn/a.py", "test/test_nn.py"))
        self.assertEqual(
            logs.active(parsed.heuristics, parsed.raised),
            {"Filepath", "PreviouslyFailedInPR", "Profiling"},
        )
        self.assertEqual(parsed.aggregated, {"test_nn": 0.8})

    def test_partial_or_bad(self) -> None:
        self.assertIsNone(logs.parse_td_log(log_text(["Changed files: ['a']"])))
        partial = ["Results from X", "  a (1)"]
        self.assertIsNone(logs.parse_td_log(log_text(partial)))
        self.assertIsNone(
            logs.parse_td_log(log_text(["Aggregated Heuristics", "Results from X"]))
        )
        bad = logs.parse_td_log(
            log_text(["Changed files: [1, 2]", *partial, "Aggregated Heuristics"])
        )
        assert bad is not None
        self.assertIsNone(bad.changed_files)
        self.assertEqual(bad.scores, {"X": {"a": 1.0}})

    def test_injected_lines(self) -> None:
        parsed = logs.parse_td_log(
            log_text(
                [
                    "Results from EditedByPR",
                    "  test_a (1.0)",
                    "Changed files: ['real.py']",
                    "Results from Filepath",
                    "  test_b (0.5)",
                    "model rejected: ",
                    "Results from EditedByPR",
                    "  test_nn (1.0)",
                    "Results from Bad-Name",
                    "  test_nn (1.0)",
                    "Error in ::bad: x",
                    "Aggregated Heuristics",
                    "  test_a (1.0)",
                    "Aggregated Heuristics",
                    "  test_z (5.0)",
                    "Results from MentionedInPR",
                    "  test_nn (1.0)",
                    "Error in Filepath: late",
                    "Changed files: ['late.py']",
                ]
            )
        )
        assert parsed is not None
        self.assertEqual(
            parsed.scores, {"EditedByPR": {"test_a": 1.0}, "Filepath": {"test_b": 0.5}}
        )
        self.assertEqual(parsed.raised, ())
        self.assertEqual(parsed.changed_files, ("real.py",))
        self.assertEqual(parsed.aggregated, {"test_a": 1.0})

    def test_http_get(self) -> None:
        def resp(code, body=b""):
            r = mock.Mock(status_code=code, content=body)
            r.raise_for_status = mock.Mock(
                side_effect=None if code < 400 else logs.requests.HTTPError(f"{code}")
            )
            return r

        session = mock.Mock()
        with mock.patch.object(logs, "_session", return_value=session), mock.patch(
            "torchci.td.scorer.logs.time.sleep"
        ):
            session.get.return_value = resp(404)
            self.assertIsNone(logs.http_get("u"))
            session.get.return_value = resp(200, gzip.compress(b"hi"))
            self.assertEqual(logs.http_get("u"), b"hi")
            session.get.side_effect = [resp(500), resp(200, b"plain")]
            self.assertEqual(logs.http_get("u"), b"plain")
            session.get.side_effect = [resp(500)] * logs.HTTP_RETRIES
            with self.assertRaises(logs.requests.RequestException):
                logs.http_get("u")
            session.get.reset_mock()
            session.get.side_effect = [resp(403), resp(200, b"never")]
            with self.assertRaises(logs.requests.HTTPError):
                logs.http_get("u")
            self.assertEqual(session.get.call_count, 1)

    def test_fetch_td_log_and_map(self) -> None:
        with mock.patch.object(logs, "http_get", side_effect=[None, LOG.encode()]):
            self.assertIsNone(logs.fetch_td_log(1))
            self.assertIsNotNone(logs.fetch_td_log(2))
        self.assertEqual(logs.map_threaded(lambda x: x * 2, [1, 2, 3], 2), [2, 4, 6])

    def test_fetch_td_log_found(self) -> None:
        session = mock.Mock()
        with mock.patch.object(logs, "_session", return_value=session):
            session.get.return_value = mock.Mock(status_code=404)
            self.assertEqual(logs.fetch_td_log_found(1), (None, False))
            rate_limited = b'{"message": "API rate limit exceeded"}'
            for body in (b"garbage", b"", rate_limited, gzip.compress(b"garbage")):
                session.get.return_value = mock.Mock(status_code=200, content=body)
                self.assertEqual(logs.fetch_td_log_found(1), (None, True))
            for body in (LOG.encode(), gzip.compress(LOG.encode())):
                session.get.return_value = mock.Mock(status_code=200, content=body)
                self.assertEqual(
                    logs.fetch_td_log_found(1), (logs.parse_td_log(LOG), True)
                )
            self.assertIn("/log/1", session.get.call_args.args[0])


def unit(**kw):
    base = dict(
        run_id=1,
        build_env="linux-a",
        test_config="default",
        ran=["a", "b", "c"],
        excluded=["d", "e"],
        failed=["a"],
        neither=["b"],
        main_broken=[],
    )
    base.update(kw)
    return shards.Unit(**base)


def run(**kw):
    base = dict(
        run_id=1,
        pr=100,
        head_sha="h" * 40,
        created_at="2026-11-05 10:00:00",
        heuristics=["Filepath", "LLM"],
        raised=["LLM"],
        scores={"Filepath": {"a": 0.25, "d": 0.123456789123}},
        changed_files=["x.py"],
        aggregated={"a": 0.25, "e": 0.75},
    )
    base.update(kw)
    return shards.Run(**base)


class TestShards(TestCase):
    def test_fetch_exclusions(self) -> None:
        bodies = {
            1: json.dumps(
                {"linux-a": {"default": ["d", "expected"], "cfg": []}}
            ).encode(),
            2: b"not json",
            4: None,
            3: json.dumps({"linux-a": {"default": ["e"]}, "bad": 3}).encode(),
        }
        with mock.patch.object(
            shards, "http_get", side_effect=lambda u: bodies[int(u.rsplit("/", 1)[1])]
        ):
            out = shards.fetch_exclusions(7, 4)
        self.assertEqual(out, {("linux-a", "default"): {"d", "e"}})

    def test_build_day_shard(self) -> None:
        runs_rows = [
            {
                "run_id": "1",
                "td_job_id": "11",
                "pr": "100",
                "head_sha": "h" * 40,
                "created_at": "2026-11-05 10:00:00.000",
                "attempts": "1",
            },
            {
                "run_id": "2",
                "td_job_id": "12",
                "pr": "101",
                "head_sha": "g" * 40,
                "created_at": "2026-11-05 11:00:00.000",
                "attempts": "1",
            },
        ]
        unit_rows = [
            {
                "run_id": "1",
                "build_env": "linux-a",
                "test_config": "default",
                "ran": ["b", "a"],
                "failed": ["a"],
                "neither": [],
            },
            {
                "run_id": "1",
                "build_env": "macos-a",
                "test_config": "default",
                "ran": ["a"],
                "failed": [],
                "neither": [],
            },
            {
                "run_id": "1",
                "build_env": "linux-a",
                "test_config": "other",
                "ran": ["a"],
                "failed": [],
                "neither": [],
            },
        ]
        main_rows = [
            {"build_env": "linux-a", "test_config": "default", "test_file": "a"}
        ]

        def query(name, sql, params):
            return {
                "td_scorer_runs": runs_rows,
                "td_scorer_units": unit_rows,
                "td_scorer_main_failures": main_rows,
            }[name]

        excl = {
            1: {("linux-a", "default"): {"d"}, ("macos-a", "default"): {"d"}},
            2: {},
        }
        with mock.patch.object(shards, "_query", side_effect=query), mock.patch.object(
            shards, "fetch_exclusions", side_effect=lambda r, a: excl[r]
        ), mock.patch.object(
            shards, "fetch_td_log_found", return_value=(logs.parse_td_log(LOG), True)
        ) as fetch:
            shard = shards.build_day_shard(date(2026, 11, 5))
            self.assertEqual([r.run_id for r in shard.runs], [1])
            self.assertEqual(
                shard.runs[0].changed_files, ["torch/nn/a.py", "test/test_nn.py"]
            )
            self.assertEqual(shard.runs[0].aggregated, {"test_nn": 0.8})
            self.assertEqual(len(shard.units), 1)
            u = shard.units[0]
            self.assertEqual(
                (u.ran, u.excluded, u.failed, u.main_broken),
                (["a", "b"], ["d"], ["a"], ["a"]),
            )
            self.assertEqual(shard.meta["td_on_runs"], 1)
            self.assertEqual((shard.meta["errors"], shard.meta["logs_missing"]), (0, 0))
            self.assertTrue(shard.healthy)

            fetch.side_effect = logs.requests.HTTPError("403")
            failed = shards.build_day_shard(date(2026, 11, 5))
            self.assertEqual(failed.meta["errors"], 1)
            self.assertFalse(failed.healthy)
            fetch.side_effect = None
            fetch.return_value = (None, False)
            missing = shards.build_day_shard(date(2026, 11, 5))
            self.assertEqual(
                (missing.meta["errors"], missing.meta["logs_missing"]), (0, 1)
            )
            self.assertEqual(missing.meta["logs_404"], 1)
            self.assertFalse(missing.healthy)
            fetch.return_value = (None, True)
            unparsable = shards.build_day_shard(date(2026, 11, 5))
            self.assertEqual(
                (unparsable.meta["logs_missing"], unparsable.meta["logs_404"]), (1, 0)
            )

    def test_healthy(self) -> None:
        meta = {"td_on_runs": 100, "logs_missing": 15, "errors": 0}
        self.assertTrue(shards.DayShard("d", units=[unit()], meta=meta).healthy)
        self.assertFalse(
            shards.DayShard(
                "d", units=[unit()], meta={**meta, "logs_missing": 16}
            ).healthy
        )
        self.assertFalse(shards.DayShard("d", units=[], meta=meta).healthy)
        self.assertTrue(shards.DayShard("d", meta={"td_on_runs": 0}).healthy)
        gap = shards.DayShard("d", units=[unit()], meta={**meta, "logs_missing": 16})
        self.assertTrue(gap.logs_gap)
        self.assertFalse(gap.permanent)
        gap.meta["logs_404"] = 16
        self.assertTrue(gap.permanent)
        no_outcomes = {**meta, "logs_parsed": 85, "units_seen": 0}
        self.assertTrue(shards.DayShard("d", units=[], meta=no_outcomes).permanent)
        self.assertFalse(shards.DayShard("d", units=[], meta=no_outcomes).logs_gap)
        self.assertFalse(shards.DayShard("d", units=[], meta=meta).permanent)
        filtered = {**no_outcomes, "units_seen": 3}
        self.assertFalse(shards.DayShard("d", units=[], meta=filtered).permanent)
        filtered["logs_missing"] = 16
        self.assertFalse(shards.DayShard("d", units=[], meta=filtered).logs_gap)
        unparsable = {**meta, "logs_missing": 100, "logs_404": 0, "logs_parsed": 0}
        unparsable["units_seen"] = 0
        self.assertTrue(shards.DayShard("d", units=[], meta=unparsable).logs_gap)
        self.assertFalse(shards.DayShard("d", units=[], meta=unparsable).permanent)
        failed_404 = {**meta, "logs_missing": 16, "logs_404": 16, "errors": 1}
        self.assertFalse(
            shards.DayShard("d", units=[unit()], meta=failed_404).permanent
        )
        self.assertFalse(shards.DayShard("d", units=[unit()], meta=meta).permanent)
        self.assertFalse(shards.DayShard("d", units=[unit()], meta=meta).logs_gap)
        failed = {**meta, "logs_missing": 16, "errors": 1}
        self.assertFalse(shards.DayShard("d", units=[unit()], meta=failed).logs_gap)
        self.assertFalse(shards.DayShard("d", units=[], meta=meta).logs_gap)

    def test_query_retries_transient_errors(self) -> None:
        busy = RuntimeError("q query failed: DatabaseError (code 202)")
        with mock.patch.object(
            shards, "_query", side_effect=[busy, [{"a": 1}]]
        ), mock.patch("torchci.td.scorer.shards.time.sleep") as sleep:
            self.assertEqual(shards.query("q", "SQL", {}), [{"a": 1}])
            sleep.assert_called_once()
        bad = RuntimeError("q query failed: DatabaseError (code 47)")
        with mock.patch.object(shards, "_query", side_effect=[bad]):
            with self.assertRaises(RuntimeError):
                shards.query("q", "SQL", {})
        with mock.patch.object(
            shards, "_query", side_effect=[busy] * shards.QUERY_RETRIES
        ), mock.patch("torchci.td.scorer.shards.time.sleep"):
            with self.assertRaises(RuntimeError):
                shards.query("q", "SQL", {})

    def test_dump_load_roundtrip(self) -> None:
        shard = shards.DayShard(
            day="2026-11-05",
            runs=[run()],
            units=[unit(run_id=1, build_env="z"), unit(run_id=1)],
            meta={"units": 2},
        )
        back = store.load_shard(store.dump_shard(shard))
        self.assertEqual(back.day, shard.day)
        self.assertEqual(back.meta, {"units": 2})
        self.assertEqual(back.runs[0].scores["Filepath"]["d"], 0.123456789)
        self.assertEqual(back.runs[0].aggregated, {"a": 0.25, "e": 0.75})
        self.assertEqual(back.units, [unit(run_id=1), unit(run_id=1, build_env="z")])
        self.assertEqual(store.dump_shard(shard), store.dump_shard(shard))
        bad = gzip.compress(b'{"kind": "meta", "day": "x", "format": "v0"}\n')
        with self.assertRaises(ValueError):
            store.load_shard(bad)
        with self.assertRaises(ValueError):
            store.load_shard(gzip.compress(b""))

    def test_dir_store_never_overwrites(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            dirs = store.DirStore(Path(d))
            self.assertFalse(dirs.exists("2026-11-05"))
            self.assertTrue(dirs.put_if_absent("2026-11-05", b"one"))
            self.assertFalse(dirs.put_if_absent("2026-11-05", b"two"))
            self.assertEqual(dirs.get("2026-11-05"), b"one")

    def test_s3_store(self) -> None:
        # torchci pins boto3 1.19.12, whose botocore fails to import on Python 3.12, so
        # the test stands in for both modules.
        class ClientError(Exception):
            def __init__(self, response, operation_name):
                super().__init__(operation_name)
                self.response = response

        client = mock.Mock()
        fakes = {
            "boto3": mock.Mock(client=mock.Mock(return_value=client)),
            "botocore": mock.Mock(),
            "botocore.exceptions": mock.Mock(ClientError=ClientError),
        }
        with mock.patch.dict(sys.modules, fakes):
            self._check_s3_store(client, ClientError)

    def _check_s3_store(self, client, ClientError) -> None:
        missing = ClientError({"Error": {"Code": "404"}}, "HeadObject")
        denied = ClientError({"Error": {"Code": "AccessDenied"}}, "HeadObject")
        s3 = store.S3Store()
        client.head_object.side_effect = missing
        self.assertTrue(s3.put_if_absent("d", b"x"))
        client.put_object.assert_called_once()
        self.assertEqual(
            client.put_object.call_args.kwargs["Key"], "td_scorer/rows/v2/d.jsonl.gz"
        )
        self.assertEqual(client.put_object.call_args.kwargs["Bucket"], logs.RAW_BUCKET)
        client.head_object.side_effect = None
        self.assertFalse(s3.put_if_absent("d", b"y"))
        self.assertEqual(client.put_object.call_count, 1)
        client.head_object.side_effect = denied
        with self.assertRaises(ClientError):
            s3.exists("d")
        client.get_object.side_effect = ClientError(
            {"Error": {"Code": "NoSuchKey"}}, "GetObject"
        )
        self.assertIsNone(s3.get("d"))

    def test_shards_write_only_final_healthy_days(self) -> None:
        built = []

        def build(day):
            built.append(day)
            meta = {"td_on_runs": 1, "errors": int(day.day == 3)}
            return shards.DayShard(day.isoformat(), [run()], [unit()], meta)

        with tempfile.TemporaryDirectory() as d, mock.patch.object(
            store, "build_day_shard", side_effect=build
        ):
            dirs = store.DirStore(Path(d))
            src = store.Shards(dirs, date(2026, 11, 6), date(2026, 10, 1))
            days = [date(2026, 11, 3), date(2026, 11, 5), date(2026, 11, 6)]
            src.ensure(days)
            src.ensure(days)
            self.assertEqual(built, sorted(days, reverse=True))
            self.assertEqual(src.missing, [])
            self.assertEqual(src.usable(days), days[1:])
            self.assertEqual(src.unhealthy, ["2026-11-03"])
            self.assertFalse(dirs.exists("2026-11-03"))
            self.assertTrue(dirs.exists("2026-11-05"))
            self.assertFalse(dirs.exists("2026-11-06"))
            self.assertEqual(src.get(date(2026, 11, 6)).units, [unit()])
            self.assertEqual(src.get(date(2026, 11, 3)).meta["errors"], 1)
            memory_only = store.Shards(None, date(2026, 11, 6), date(2026, 10, 1))
            memory_only.ensure([date(2026, 11, 4)])
            self.assertEqual(memory_only.get(date(2026, 11, 4)).day, "2026-11-04")
            with self.assertRaises(KeyError):
                memory_only.get(date(2026, 1, 1))

    def test_gap_days_are_marked_only_when_permanent(self) -> None:
        built = []
        gap_404 = {"logs_missing": 2, "logs_404": 2}
        unparsable = {"logs_missing": 2, "logs_404": 0}
        no_outcomes = {"logs_parsed": 10, "units_seen": 0}
        kinds = {
            date(2026, 10, 3): (gap_404, True),
            date(2026, 10, 4): ({"errors": 1}, True),
            date(2026, 10, 5): (unparsable, True),
            date(2026, 10, 6): (no_outcomes, False),
            date(2026, 10, 7): None,
            date(2026, 11, 3): (gap_404, True),
            date(2026, 11, 4): (no_outcomes, False),
        }

        def build(day):
            built.append(day)
            if kinds[day] is None:
                raise RuntimeError("td_scorer_units query failed: (code 159)")
            extra, with_units = kinds[day]
            meta = {"td_on_runs": 10, "logs_missing": 0, "errors": 0, **extra}
            units = [unit()] if with_units else []
            return shards.DayShard(day.isoformat(), [run()], units, meta)

        days = sorted(kinds)
        with tempfile.TemporaryDirectory() as d, mock.patch.object(
            store, "build_day_shard", side_effect=build
        ):
            dirs = store.DirStore(Path(d))
            src = store.Shards(dirs, date(2026, 11, 8), date(2026, 10, 27))
            src.ensure(days)
            self.assertEqual(
                sorted(src.gaps),
                ["2026-10-03", "2026-10-05", "2026-10-06", "2026-11-03"],
            )
            self.assertEqual(
                sorted(src.unhealthy), ["2026-10-04", "2026-10-07", "2026-11-04"]
            )
            self.assertEqual(src.usable(days), [])
            marked = {
                x.isoformat()
                for x in days
                if dirs.exists(x.isoformat() + store.GAP_SUFFIX)
            }
            self.assertEqual(marked, {"2026-10-03", "2026-10-06"})
            self.assertFalse(any(dirs.exists(x.isoformat()) for x in days))
            marker = store.load_shard(dirs.get("2026-10-03" + store.GAP_SUFFIX) or b"")
            self.assertEqual(
                (marker.meta["max_missing_logs"], marker.meta["logs_404"]),
                (shards.MAX_MISSING_LOGS, 2),
            )

            built.clear()
            again = store.Shards(dirs, date(2026, 11, 8), date(2026, 10, 27))
            again.ensure(days)
            self.assertEqual(
                built,
                [
                    date(2026, 11, 4),
                    date(2026, 11, 3),
                    date(2026, 10, 7),
                    date(2026, 10, 5),
                    date(2026, 10, 4),
                ],
            )
            self.assertIn("2026-10-03", again.gaps)

            built.clear()
            with mock.patch.object(store, "GAP_SUFFIX", "-gap-0.2"):
                store.Shards(dirs, date(2026, 11, 8), date(2026, 10, 27)).ensure(
                    [date(2026, 10, 3)]
                )
            self.assertEqual(built, [date(2026, 10, 3)])

    def test_unparsable_logs_are_never_marked_or_failing(self) -> None:
        runs_rows = [
            {
                "run_id": str(i),
                "td_job_id": str(10 + i),
                "pr": str(100 + i),
                "head_sha": str(i) * 40,
                "created_at": "2026-10-05 10:00:00.000",
                "attempts": "1",
            }
            for i in range(1, 4)
        ]
        unit_rows: list[dict] = []

        def query(name, sql, params):
            return {
                "td_scorer_runs": runs_rows,
                "td_scorer_units": unit_rows,
                "td_scorer_main_failures": [],
            }[name]

        day = date(2026, 10, 5)
        found = mock.Mock(return_value=(None, True))
        with tempfile.TemporaryDirectory() as d, mock.patch.object(
            shards, "_query", side_effect=query
        ), mock.patch.object(
            shards,
            "fetch_exclusions",
            return_value={("linux-a", "default"): {"d"}},
        ), mock.patch.object(shards, "fetch_td_log_found", found):
            dirs = store.DirStore(Path(d))
            for mark_before in (date(2026, 10, 27), date(2026, 10, 1)):
                src = store.Shards(dirs, date(2026, 11, 8), mark_before)
                src.ensure([day])
                self.assertEqual(src.get(day).meta["logs_parsed"], 0)
                self.assertEqual(src.get(day).meta["logs_missing"], 3)
                self.assertEqual((src.gaps, src.unhealthy), (["2026-10-05"], []))
                self.assertEqual(os.listdir(d), [])
            self.assertEqual(found.call_count, 6)

            found.return_value = (logs.parse_td_log(LOG), True)
            src = store.Shards(dirs, date(2026, 11, 8), date(2026, 10, 27))
            src.ensure([day])
            self.assertEqual(src.get(day).meta["logs_parsed"], 3)
            self.assertEqual((src.gaps, src.unhealthy), (["2026-10-05"], []))
            self.assertEqual(len(os.listdir(d)), 1)
            self.assertTrue(dirs.exists("2026-10-05" + store.GAP_SUFFIX))

    def test_backfill_budget_newest_first(self) -> None:
        built = []
        clock = [0.0]

        def build(day):
            built.append(day)
            clock[0] += 100.0
            meta = {"td_on_runs": 1, "errors": 0}
            return shards.DayShard(day.isoformat(), [run()], [unit()], meta)

        days = [date(2026, 11, d) for d in range(1, 7)]
        with tempfile.TemporaryDirectory() as d, mock.patch.object(
            store, "build_day_shard", side_effect=build
        ), mock.patch.object(store, "BACKFILL_SECONDS", 250.0), mock.patch.object(
            store.time, "monotonic", side_effect=lambda: clock[0]
        ):
            dirs = store.DirStore(Path(d))
            dirs.put_if_absent("2026-11-05", store.dump_shard(build(days[4])))
            built.clear()
            clock[0] = 0.0
            src = store.Shards(dirs, date(2026, 11, 10), date(2026, 10, 1))
            src.ensure(days)
            self.assertEqual(built, [date(2026, 11, 6), date(2026, 11, 4), days[2]])
            self.assertEqual(src.missing, ["2026-11-02", "2026-11-01"])
            self.assertEqual(src.usable(days), days[2:])
            for day in built:
                self.assertTrue(dirs.exists(day.isoformat()))
            again = store.Shards(dirs, date(2026, 11, 10), date(2026, 10, 1))
            clock[0] = 0.0
            again.ensure(days)
            self.assertEqual(built[3:], [date(2026, 11, 2), date(2026, 11, 1)])
            self.assertEqual(again.missing, [])


def _values(schema, rows):
    return f"(SELECT * FROM values('{schema}', {', '.join(map(repr, rows))}))"


ATR_SCHEMA = (
    "job_id Int64, workflow_id Int64, invoking_file String, failure_count UInt32,"
    " error_count UInt32, rerun_count UInt32"
)


def assert_units_sql_shape(test: TestCase, sql: str) -> None:
    test.assertIn("INNER JOIN jobs AS j ON j.id = o.job_id", sql)
    test.assertIn("AND j.run_id = o.workflow_id", sql)
    test.assertIn("FROM tests.all_test_runs", sql)
    test.assertIn("ORDER BY _inserted_at DESC\n        LIMIT 1 BY id", sql)
    test.assertIn("invoking_file NOT IN ('', 'expected')", sql)
    test.assertIn("max((failure_count > 0 OR error_count > 0) OR rerun_count > 0)", sql)
    test.assertIn("max((failure_count > 0 OR error_count > 0)) AS real_failure", sql)
    test.assertNotIn("test_run_summary", sql)
    test.assertNotIn("failed_test_runs", sql)


class TestOutcomeSqlShape(TestCase):
    """What the literal-table tests check, as text, for runs without ClickHouse."""

    def test_two_id_joins_and_main_runs(self) -> None:
        assert_units_sql_shape(self, rows_sql.UNITS_SQL)
        main_sql = rows_sql.MAIN_FAILURES_SQL
        self.assertIn(
            "INNER JOIN jobs AS j ON j.id = f.job_id AND j.run_id = f.workflow_id",
            main_sql,
        )
        self.assertIn("FROM tests.all_test_runs AS f", main_sql)
        self.assertIn("event IN ('push', 'schedule')", main_sql)
        self.assertIn(
            "WHERE id IN (SELECT run_id FROM candidates) AND head_branch = 'main'",
            main_sql,
        )
        self.assertIn("AND repository.full_name = 'pytorch/pytorch'", main_sql)
        self.assertIn(
            "(failure_count > 0 OR error_count > 0) AND invoking_file", main_sql
        )
        self.assertIn("FROM default.workflow_run", main_sql)
        self.assertNotIn("failed_test_runs", main_sql)
        self.assertIn("invoking_file NOT IN ('', 'expected')", main_sql)


@skipUnless(os.environ.get("CLICKHOUSE_ENDPOINT"), "needs ClickHouse (read-only)")
class TestUnitsSql(TestCase):
    """The outcome queries' logic on literal tables in place of the real ones."""

    def run_sql(self, sql, tables, params):
        from torchci.td.llm.events import _query

        for table, schema, data in tables:
            self.assertIn(table, sql)
            sql = sql.replace(table, _values(schema, data))
        return _query("test_units", sql, params)

    def test_units(self) -> None:
        name = "linux-a / test ({}, 1, 2, x)"
        jobs = [
            (11, 1, 1, "failure", name.format("default"), "2026-11-01 00:00:00"),
            (12, 1, 1, "failure", name.format("default"), "2026-11-01 00:00:00"),
            (13, 1, 2, "success", name.format("default"), "2026-11-01 00:00:00"),
            (14, 1, 1, "success", name.format("other"), "2026-11-01 00:00:00"),
            (15, 1, 1, "failure", name.format("big"), "2026-11-01 00:00:00"),
            (16, 1, 1, "failure", name.format("flaky"), "2026-11-01 00:00:00"),
            (16, 1, 1, "success", name.format("flaky"), "2026-11-01 01:00:00"),
        ]
        # One row per test case: test_a has a failing case and a passing one.
        cases = [
            (11, 1, "test_a", 1, 0, 1),
            (11, 1, "test_a", 0, 0, 0),
            (11, 1, "test_b", 0, 0, 0),
            (11, 1, "expected", 1, 0, 0),
            (11, 999, "test_forged", 1, 0, 0),
            (11, 999, "test_b", 1, 0, 0),
            (12, 1, "test_c", 0, 1, 0),
            (13, 1, "test_c", 0, 0, 0),
            (14, 1, "test_d", 1, 0, 0),
            (15, 1, "f1", 1, 0, 0),
            (15, 1, "f2", 1, 0, 0),
            (15, 1, "f3", 1, 0, 0),
            (16, 1, "test_e", 0, 0, 2),
            (16, 1, "test_f", 1, 0, 0),
        ]
        sql = re.sub(
            r"PREWHERE id IN \(\s*SELECT id FROM materialized_views\."
            r"workflow_job_by_head_sha\s*WHERE head_sha IN \{shas: Array\(String\)\}"
            r"\s*\)\s*WHERE",
            "WHERE",
            rows_sql.UNITS_SQL,
        )
        self.assertNotIn("PREWHERE", sql)
        self.assertNotIn("test_run_summary", sql)
        self.assertNotIn("failed_test_runs", sql)
        out = self.run_sql(
            sql,
            (
                (
                    "default.workflow_job",
                    "id Int64, run_id Int64, run_attempt Int64, conclusion String,"
                    " name String, _inserted_at DateTime",
                    jobs,
                ),
                ("tests.all_test_runs", ATR_SCHEMA, cases),
            ),
            {"runs": [1], "shas": ["h"], "max_failing": 2},
        )
        got = {
            r["test_config"]: (r["ran"], r["failed"], r["neither"])
            for r in out
            if r["build_env"] == "linux-a"
        }
        self.assertEqual(
            got,
            {
                "default": (["test_a", "test_b", "test_c"], ["test_a"], ["test_c"]),
                "other": (["test_d"], [], ["test_d"]),
                "big": (["f1", "f2", "f3"], [], ["f1", "f2", "f3"]),
                "flaky": (["test_e", "test_f"], [], ["test_e", "test_f"]),
            },
        )

    def test_main_failures(self) -> None:
        name = "{} / test (default, 1, 2, x)"
        jobs = [
            (21, 2, "trunk", "linux-a", "main"),
            (22, 3, "pull", "linux-b", "main"),
            (23, 4, "inductor", "linux-a", "main"),
            (24, 5, "trunk", "linux-a", "feature"),
            (25, 6, "pull", "linux-c", "main"),
        ]
        runs = [
            (2, "main", "push", "pytorch/pytorch"),
            (3, "main", "schedule", "pytorch/pytorch"),
            (4, "main", "push", "pytorch/pytorch"),
            (5, "feature", "push", "pytorch/pytorch"),
            (6, "main", "pull_request", "pytorch/pytorch"),
        ]
        job_rows = [
            (i, r, w, name.format(e), b, "pytorch/pytorch/x", "2026-11-01 00:00:00")
            for i, r, w, e, b in jobs
        ]
        cases = [
            (21, 2, "test_a", 1, 0, 1),
            (21, 2, "test_rerun", 0, 0, 2),
            (21, 2, "expected", 1, 0, 0),
            (21, 999, "test_forged", 1, 0, 0),
            (22, 3, "test_b", 0, 1, 0),
            (23, 4, "test_c", 1, 0, 0),
            (24, 5, "test_d", 1, 0, 0),
            (25, 6, "test_fork", 1, 0, 0),
        ]
        sql = re.sub(
            r"PREWHERE id IN \(\s*SELECT id FROM materialized_views\."
            r"workflow_job_by_created_at\s*WHERE created_at >= \{start: DateTime64\(3\)\}"
            r"\s+AND created_at < \{stop: DateTime64\(3\)\}\s*\)\s*WHERE",
            "WHERE",
            rows_sql.MAIN_FAILURES_SQL,
        )
        self.assertNotIn("PREWHERE", sql)
        out = self.run_sql(
            sql,
            (
                (
                    "default.workflow_job",
                    "id Int64, run_id Int64, workflow_name String, name String,"
                    " head_branch String, dynamoKey String, _inserted_at DateTime",
                    job_rows,
                ),
                (
                    "default.workflow_run",
                    "id Int64, head_branch String, event String,"
                    " `repository.full_name` String",
                    runs,
                ),
                ("tests.all_test_runs", ATR_SCHEMA, cases),
            ),
            {},
        )
        got = sorted((r["build_env"], r["test_config"], r["test_file"]) for r in out)
        self.assertEqual(
            got, [("linux-a", "default", "test_a"), ("linux-b", "default", "test_b")]
        )


class TestRows(TestCase):
    def test_sampled_is_deterministic_and_near_rate(self) -> None:
        hits = [rows.sampled(r, "env", "cfg", "f") for r in range(20000)]
        self.assertEqual(
            hits, [rows.sampled(r, "env", "cfg", "f") for r in range(20000)]
        )
        self.assertAlmostEqual(sum(hits) / len(hits), rows.NEG_RATE, delta=0.006)

    def test_unit_labels(self) -> None:
        self.assertEqual(rows.unit_labels(unit()), (["a"], ["c"]))
        self.assertEqual(rows.unit_labels(unit(main_broken=["a"])), ([], ["c"]))
        rerun_passed = unit(failed=[], neither=["a", "b"])
        self.assertEqual(rows.unit_labels(rerun_passed), ([], ["c"]))

    def test_job_times(self) -> None:
        times = rows.JobTimes(
            {
                "linux-a": {"default": {"a": 10.0, "b": 20.0, "c": 60.0}},
                "default": {"other": {"x": 4.0}, "default": {"y": 2.0}},
            }
        )
        oh = rows.OVERHEAD_SECONDS
        self.assertEqual(times.cost("linux-a", "default", "a"), 10.0 + oh)
        self.assertEqual(times.cost("linux-a", "default", "zz"), 20.0 + oh)
        self.assertEqual(times.cost("linux-b", "other", "x"), 4.0 + oh)
        self.assertEqual(times.cost("linux-b", "nope", "q"), 2.0 + oh)
        self.assertEqual(rows.JobTimes({}).cost("e", "c", "f"), oh)

    def test_builder(self) -> None:
        times = rows.JobTimes({"default": {"default": {"a": 5.0}}})
        many_neg = [f"n{i}" for i in range(400)]
        shard = shards.DayShard(
            day="2026-11-05",
            runs=[run(), run(run_id=2, pr=200)],
            units=[
                unit(ran=["a", "b"] + many_neg),
                unit(run_id=2, ran=["a"], failed=["a"], neither=[]),
            ],
        )
        b = rows.RowBuilder(times)
        b.add_shard(shard, exclude_prs={200})
        r = b.build()
        self.assertEqual(r.heuristics, ["Filepath"])
        self.assertEqual(int(r.label.sum()), 1)
        neg = r.label == 0
        expected = sum(rows.sampled(1, "linux-a", "default", f) for f in many_neg)
        self.assertEqual(int(neg.sum()), expected)
        self.assertTrue(np.all(r.weight[neg] == rows.NEG_WEIGHT))
        pos = int(np.flatnonzero(r.label == 1)[0])
        self.assertEqual(r.scores[pos].tolist(), [0.25])
        self.assertEqual(r.active[pos].tolist(), [True])
        self.assertEqual(r.cost[pos], 5.0 + rows.OVERHEAD_SECONDS)
        self.assertEqual(set(r.pr.tolist()), {100})

    def test_cap_per_pr(self) -> None:
        label = np.array([1] * 40 + [0, 1, 1], dtype=np.int8)
        weight = np.array([1.0] * 40 + [20.0, 1.0, 5.0])
        pr = np.array([1] * 41 + [2, 2])
        is_trunk = np.array([False] * 42 + [True])
        out = rows.cap_per_pr(weight, label, pr, is_trunk)
        self.assertAlmostEqual(out[:40].sum(), rows.PR_POSITIVE_CAP)
        self.assertAlmostEqual(out[40], 10.0)
        self.assertEqual(out[41:].tolist(), [1.0, 5.0])

        n = 600
        label = np.array([1] + [0] * n, dtype=np.int8)
        weight = np.array([2.0] + [rows.NEG_WEIGHT] * n)
        pr = np.ones(n + 1, dtype=np.int64)
        out = rows.cap_per_pr(weight, label, pr, np.zeros(n + 1, dtype=bool))
        self.assertEqual(out[0], 2.0)
        self.assertAlmostEqual(out[1:].sum(), rows.PR_NEGATIVE_CAP)
        small = rows.cap_per_pr(weight[:10], label[:10], pr[:10], np.zeros(10, bool))
        self.assertEqual(small.tolist(), weight[:10].tolist())

    def test_add_trunk(self) -> None:
        log = logs.parse_td_log(LOG)
        pair = lambda f, pr=5: trunk.TrunkPair(pr, "s" * 40, "linux-a", "default", f)
        landings = [
            trunk.TrunkLanding("l1", "2026-11-01", (pair("test_nn"), pair("test_ops"))),
            trunk.TrunkLanding(
                "l2", "2026-11-01", (trunk.TrunkPair(6, "x" * 40, "e", "c", "f"),)
            ),
            trunk.TrunkLanding("l3", "2026-11-01", (pair("test_nn", pr=7),)),
        ]
        b = rows.RowBuilder(rows.JobTimes({}))
        self.assertEqual(b.add_trunk(landings, {"s" * 40: log}, exclude_prs={7}), 1)
        r = b.build()
        self.assertEqual(r.weight.tolist(), [rows.W_TRUNK / 2] * 2)
        self.assertTrue(r.trunk.all())
        self.assertEqual(r.scores[0, r.heuristics.index("Filepath")], 0.5)


class TestTrunk(TestCase):
    def test_split_and_check_config(self) -> None:
        self.assertEqual(
            trunk.split_config("trunk / linux-a / default"), ("linux-a", "default")
        )
        self.assertEqual(
            trunk.split_config("pull / dyn / dyn-test (3.13) / dynamo_wrapped"),
            ("dyn / dyn-test (3.13)", "dynamo_wrapped"),
        )
        self.assertIsNone(trunk.split_config("trunk / macos-x / default"))
        self.assertIsNone(trunk.split_config("inductor / linux-a / default"))
        self.assertEqual(
            trunk.split_config("rocm-mi300 / linux-r / default"), ("linux-r", "default")
        )
        self.assertIsNone(trunk.split_config("pull / x"))
        self.assertEqual(
            trunk.check_config("pull / linux-a / test (default, 1, 5, linux.2xlarge)"),
            "pull / linux-a / default",
        )
        self.assertIsNone(trunk.check_config("Lint / lintrunner"))

    def _event(self, **kw):
        e = {
            "grain": "event",
            "landing_sha": "L" * 40,
            "landed_at": "2026-11-01 10:00:00.000",
            "test_configs": ["pull / linux-a / default"] * 3
            + ["pull / linux-b / default"],
            "test_files": ["f1", "f2", "f3", "f1"],
            "test_prs": ["5", "5", "5", "6"],
            "test_outcomes": ["td_skipped", "td_skipped", "passed_on_pr", "td_skipped"],
        }
        e.update(kw)
        return e

    def _merge(self, **kw):
        m = {
            "pr_num": "5",
            "merge_commit_sha": "L" * 40,
            "last_commit_sha": "H" * 40,
            "comment_id": "10",
            "skip_mandatory_checks": False,
            "ignore_current": False,
            "ignore_current_checks": [],
            "flaky_checks": [],
            "broken_trunk_checks": [],
            "ai_not_related_checks": [],
        }
        m.update(kw)
        return m

    def test_counted_landings(self) -> None:
        out = trunk.counted_landings([self._event()], {}, [self._merge()], [])
        self.assertEqual(len(out), 1)
        self.assertEqual(
            [(p.pr, p.test_file, p.head_sha) for p in out[0].pairs],
            [(5, "f1", "H" * 40), (5, "f2", "H" * 40)],
        )
        self.assertEqual(out[0].day, "2026-11-01")

        member = self._merge(
            pr_num="6", merge_commit_sha="M" * 40, last_commit_sha="G" * 40
        )
        out = trunk.counted_landings(
            [self._event(test_files=["f1", "f2", "f3", "f4"])],
            {"L" * 40: ["M" * 40, "L" * 40]},
            [self._merge(), member],
            [],
        )
        self.assertEqual([p.test_file for p in out[0].pairs], ["f1", "f2", "f4"])
        later = self._merge(comment_id="11", last_commit_sha="K" * 40)
        out = trunk.counted_landings([self._event()], {}, [self._merge(), later], [])
        self.assertEqual({p.head_sha for p in out[0].pairs}, {"K" * 40})

    def test_ghstack_landing(self) -> None:
        check = [["pull / linux-b / test (default, 1, 2, linux.2xlarge)", "u", "1"]]
        own = self._merge(pr_num="6", merge_commit_sha="M" * 40, flaky_checks=check)
        run_heads = [
            {"pr": "6", "head_sha": "A" * 40, "created_at": "2026-11-01 08:00:00"},
            {"pr": "6", "head_sha": "B" * 40, "created_at": "2026-11-01T09:00:00Z"},
            {"pr": "6", "head_sha": "C" * 40, "created_at": "2026-11-01 11:00:00"},
        ]
        members = {"L" * 40: ["M" * 40, "N" * 40, "L" * 40]}
        event = self._event(
            test_configs=["pull / linux-b / default", "pull / linux-a / default"],
            test_files=["f1", "f2"],
            test_prs=["6", "7"],
            test_outcomes=["td_skipped", "td_skipped"],
        )
        out = trunk.counted_landings([event], members, [self._merge()], run_heads)
        self.assertEqual(
            [(p.pr, p.head_sha, p.test_file) for p in out[0].pairs],
            [(6, "B" * 40, "f1")],
        )
        out = trunk.counted_landings([event], members, [self._merge(), own], run_heads)
        self.assertEqual([(p.pr, p.head_sha) for p in out[0].pairs], [(6, "H" * 40)])
        waived = self._merge(flaky_checks=check)
        self.assertEqual(
            trunk.counted_landings([event], members, [waived], run_heads), []
        )
        forced = self._merge(skip_mandatory_checks=True)
        self.assertEqual(
            trunk.counted_landings([event], members, [forced], run_heads), []
        )

    def test_not_counted(self) -> None:
        def counted(merges):
            return trunk.counted_landings([self._event()], {}, merges, [])

        self.assertEqual(counted([self._merge(skip_mandatory_checks=True)]), [])
        self.assertEqual(counted([]), [])
        check = [["pull / linux-a / test (default, 2, 5, linux.2xlarge)", "url", "1"]]
        self.assertEqual(counted([self._merge(flaky_checks=check)]), [])
        ignored = self._merge(ignore_current_checks=check)
        self.assertEqual(len(counted([ignored])), 1)
        ignored = self._merge(ignore_current_checks=check, ignore_current=True)
        self.assertEqual(counted([ignored]), [])

    def test_fetch_landings_and_logs(self) -> None:
        def query(name, sql, params):
            if name == "td_scorer_pushes":
                return [{"landing_sha": "L" * 40, "shas": ["L" * 40]}]
            if name == "td_scorer_merges":
                self.assertEqual(params["prs"], [5, 6])
                return [self._merge()]
            if name == "td_scorer_run_heads":
                return []
            return [{"head_sha": "H" * 40, "td_job_id": "9"}]

        with mock.patch.object(
            trunk, "fetch_e1", return_value=[self._event(), {"grain": "total"}]
        ), mock.patch.object(trunk, "query", side_effect=query), mock.patch.object(
            trunk, "fetch_td_log", return_value=logs.parse_td_log(LOG)
        ):
            out = trunk.fetch_landings(datetime(2026, 10, 1), datetime(2026, 11, 5))
            self.assertEqual(len(out), 1)
            self.assertEqual(set(trunk.fetch_head_logs(["H" * 40])), {"H" * 40})
            self.assertEqual(trunk.fetch_head_logs([]), {})
        with mock.patch.object(trunk, "fetch_e1", return_value=[]):
            self.assertEqual(
                trunk.fetch_landings(datetime(2026, 10, 1), datetime(2026, 11, 5)), []
            )


if __name__ == "__main__":
    main()
