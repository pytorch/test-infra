import json
import os
import tempfile
from dataclasses import asdict, replace
from datetime import datetime
from pathlib import Path
from unittest import main, mock, TestCase

from torchci.td.llm import events, events_sql


HEAD = "a" * 40
BASE = "b" * 40
MERGE_BASE = "c" * 40


def e2_row(**kw):
    row = {
        "pr_number": "123",
        "test_file": "test_nn",
        "failed_at": "2026-09-01 10:00:00.123456000",
        "run_id": "1",
        "job_id": "2",
        "workflow": "pull",
        "build_environment": "linux-jammy-py3.11-gcc11",
        "test_config": "default",
        "position": "3",
        "n": "4",
        "max_score": 1.5,
        "all_scores": json.dumps({"test_nn": 1.0, "test_ops": 1.5, "a": 0, "b": 0}),
        "head_sha": HEAD,
        "pr_base_sha": BASE,
        "merge_base": MERGE_BASE,
        "nonpr_branches": [],
        "pr_source": "pull_request",
    }
    row.update(kw)
    return row


def e1_row(**kw):
    row = {
        "grain": "event",
        "landing_sha": HEAD,
        "landed_at": "2026-10-08 21:36:48.000",
        "stack_size": 2,
        "outcome": "signal_on_pr",
        "test_files": ["test_nn", "inductor/test_x", "test_nn"],
        "test_configs": ["trunk / linux / default", "pull / linux / default"],
    }
    row.update(kw)
    return row


class TestParsing(TestCase):
    def test_test_file_of(self) -> None:
        self.assertEqual(events.test_file_of("test_nn"), "test_nn")
        self.assertEqual(events.test_file_of("test_nn::TestFoo"), "test_nn")
        self.assertEqual(events.test_file_of("dir/test_nn, TestFoo"), "dir/test_nn")
        self.assertEqual(events.test_file_of("test_nn, not (TestFoo)"), "test_nn")

    def test_e1_keeps_events_with_unique_files(self) -> None:
        rows = [e1_row(), e1_row(grain="total", landing_sha="")]
        (event,) = events.parse_e1(rows)
        self.assertEqual(event.test_files, ["inductor/test_x", "test_nn"])
        self.assertEqual(event.test_configs[0], "pull / linux / default")
        self.assertEqual(
            (event.stack_size, event.landed_at), (2, "2026-10-08 21:36:48")
        )

    def test_e2_row(self) -> None:
        (event,) = events.parse_e2([e2_row()])
        self.assertEqual(
            (event.pr_number, event.test_file, event.n), (123, "test_nn", 4)
        )
        self.assertEqual(event.pr_source, "pull_request")
        self.assertEqual((event.base_sha, event.base_source), (BASE, "pr_base_sha"))
        self.assertEqual(event.failed_at, "2026-09-01 10:00:00")
        self.assertEqual(event.row.position, 3)
        self.assertEqual(event.row.all_scores["test_ops"], 1.5)

    def test_e2_base_falls_back_to_merge_base(self) -> None:
        (event,) = events.parse_e2([e2_row(pr_base_sha="", pr_source="ciflow_tag")])
        self.assertEqual(event.pr_source, "ciflow_tag")
        self.assertEqual(
            (event.base_sha, event.base_source), (MERGE_BASE, "merge_base")
        )
        (event,) = events.parse_e2([e2_row(pr_base_sha="", merge_base="bad")])
        self.assertEqual((event.base_sha, event.base_source), ("", ""))

    def test_rank_row_keeps_when_it_was_logged(self) -> None:
        sql_row = {**e2_row(), "timestamp": "2026-11-05T01:02:03.456"}
        self.assertEqual(
            events.parse_rank_row(sql_row).logged_at, "2026-11-05 01:02:03"
        )
        self.assertEqual(
            events.parse_rank_row(e2_row()).logged_at, "2026-09-01 10:00:00"
        )
        (event,) = events.parse_e2([e2_row()])
        self.assertEqual(event.row.logged_at, event.failed_at)
        stored = asdict(events.parse_rank_row(sql_row))
        self.assertEqual(events.parse_rank_row(stored).logged_at, "2026-11-05 01:02:03")
        del stored["logged_at"]
        self.assertEqual(events.parse_rank_row(stored).logged_at, "")

    def test_rank_row_from_parsed_scores(self) -> None:
        row = events.parse_rank_row(e2_row(all_scores={"x": 1}))
        self.assertEqual(row.all_scores, {"x": 1.0})
        self.assertEqual(events.parse_rank_row(e2_row(all_scores="")).all_scores, {})


class TestBasesAndShas(TestCase):
    def test_tag_run_takes_the_base_of_a_pull_request_run_at_its_head(self) -> None:
        tag = dict(pr_source="ciflow_tag", pr_base_sha="", head_pr_base_sha=BASE)
        (event,) = events.parse_e2([e2_row(**tag)])
        self.assertEqual(
            (event.base_sha, event.base_source), (BASE, "head_pr_base_sha")
        )
        (event,) = events.parse_e2([e2_row(**{**tag, "head_pr_base_sha": ""})])
        self.assertEqual(
            (event.base_sha, event.base_source), (MERGE_BASE, "merge_base")
        )

    def test_rows_with_invalid_shas_are_dropped(self) -> None:
        self.assertEqual(events.parse_e2([e2_row(head_sha="-x")]), [])
        self.assertEqual(events.parse_e2([e2_row(head_sha="")]), [])
        self.assertEqual(events.parse_e1([e1_row(landing_sha="HEAD")]), [])

    def test_query_errors_redact_the_host(self) -> None:
        secret, user = "abc123.clickhouse.example", "hud_reader_42"

        def failing(sql, params):
            raise ValueError(
                f"HTTPDriver for https://{secret}:8443 received code 516: "
                f"{user}: Authentication failed"
            )

        env = {
            "CLICKHOUSE_ENDPOINT": f"https://{secret}:8443",
            "CLICKHOUSE_USERNAME": user,
        }
        with mock.patch.dict(os.environ, env), mock.patch(
            "torchci.clickhouse.query_clickhouse", failing
        ), self.assertLogs(events.logger, "ERROR") as logs:
            with self.assertRaises(RuntimeError) as raised:
                events._query("e2", "SELECT 1", {})
        self.assertNotIn(secret, str(raised.exception))
        self.assertNotIn(secret, "\n".join(logs.output))
        self.assertIn("https://<host>:8443", "\n".join(logs.output))
        self.assertIn("<user>: Authentication failed", "\n".join(logs.output))
        self.assertNotIn(user, "\n".join(logs.output) + str(raised.exception))
        self.assertIn("Traceback", "\n".join(logs.output))


class TestMainBranchFilter(TestCase):
    def test_only_main_failures_drop_a_pr_failure(self) -> None:
        rows = [
            e2_row(pr_number="1", nonpr_branches=["main"]),
            e2_row(pr_number="2", nonpr_branches=["ciflow/trunk/2", "release/2.9"]),
            e2_row(pr_number="3", nonpr_branches=["main", "ciflow/trunk/3"]),
            e2_row(pr_number="4"),
        ]
        self.assertEqual([e.pr_number for e in events.parse_e2(rows)], [2, 4])
        self.assertFalse(events.is_pr_specific(rows[0]))
        self.assertTrue(events.is_pr_specific({}))


class TestDeduplication(TestCase):
    def test_e2_keeps_first_failure_per_pr_and_file(self) -> None:
        rows = [
            e2_row(failed_at="2026-09-02 00:00:00", job_id="9"),
            e2_row(failed_at="2026-09-01 00:00:00", job_id="8"),
            e2_row(test_file="test_ops", job_id="7"),
        ]
        parsed = events.parse_e2(rows)
        self.assertEqual(
            [(e.test_file, e.row.job_id) for e in parsed],
            [("test_nn", 8), ("test_ops", 7)],
        )

    def test_e1_events_and_rankings(self) -> None:
        self.assertEqual(len(events.parse_e1([e1_row(), e1_row()])), 1)
        ranking = {**e2_row(), "landing_sha": HEAD}
        other_file = {**ranking, "test_file": "test_ops"}
        out = events.parse_e1_rankings([ranking, dict(ranking), other_file])
        self.assertEqual([r.test_file for r in out[HEAD]], ["test_nn", "test_ops"])


class TestSavedQuerySettings(TestCase):
    def test_appends_readonly_to_the_settings_line(self) -> None:
        sql = "-- settings are below\nSELECT 1\nSETTINGS max_threads = 8, max_execution_time = 60\n"
        out = events.with_readonly(sql)
        self.assertTrue(
            out.endswith(
                "SETTINGS max_threads = 8, max_execution_time = 60, readonly = 2\n"
            )
        )
        self.assertIn("-- settings are below\nSELECT 1\n", out)

    def test_zero_or_two_settings_lines_raise(self) -> None:
        with self.assertRaises(ValueError):
            events.with_readonly("SELECT 1\n")
        with self.assertRaises(ValueError):
            events.with_readonly(
                "SELECT 1\nSETTINGS a = 1\nUNION ALL SELECT 2\nSETTINGS b = 2\n"
            )

    def test_settings_must_be_the_last_line(self) -> None:
        with self.assertRaises(ValueError):
            events.with_readonly("SELECT 1\nSETTINGS a = 1\n-- trailing comment\n")
        self.assertTrue(
            events.with_readonly("SELECT 1\nSETTINGS a = 1\n\n\n").endswith(
                "readonly = 2\n"
            )
        )

    def test_saved_query_has_one_settings_line(self) -> None:
        sql, params = events.saved_breakages_query()
        self.assertTrue(sql.rstrip().endswith("readonly = 2"))
        self.assertEqual(
            set(params["params"]), {"startTime", "stopTime", "tdWorkflows"}
        )

    def test_inline_queries_are_readonly(self) -> None:
        for sql in (events_sql.E2_SQL, events_sql.E1_RANKINGS_SQL):
            self.assertTrue(sql.rstrip().endswith(events_sql.SETTINGS))
            self.assertIn("readonly = 2", events_sql.SETTINGS)


class TestFetch(TestCase):
    def test_fetch_writes_a_snapshot_load_reads(self) -> None:
        e1_rows = [e1_row(landing_sha=HEAD), e1_row(grain="total", landing_sha="")]
        ranking = {
            **e2_row(test_file="test_nn"),
            "landing_sha": HEAD,
            "timestamp": "2026-10-09",
        }
        e2_rows = [e2_row(), e2_row(pr_number="9", nonpr_branches=["main"])]
        patches = [
            mock.patch.object(events, "fetch_e1", return_value=e1_rows),
            mock.patch.object(events, "fetch_e1_rankings", return_value=[ranking]),
            mock.patch.object(events, "_query", return_value=e2_rows),
            mock.patch(
                "torchci.td.utils.download_test_times", return_value={"env": {}}
            ),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "snap"
            for p in patches:
                p.start()
            try:
                meta = events.fetch(datetime(2026, 7, 13), datetime(2026, 11, 5), out)
            finally:
                for p in patches:
                    p.stop()
            self.assertEqual(
                sorted(p.name for p in out.iterdir()),
                sorted(
                    [
                        events.E1_FILE,
                        events.E2_FILE,
                        events.TEST_TIMES_FILE,
                        events.META_FILE,
                    ]
                ),
            )
            snap = events.load(out)
        self.assertEqual((meta["e1_events"], meta["e1_ranking_rows"]), (1, 1))
        self.assertEqual(
            (meta["e2_candidates"], meta["e2_dropped_main"], meta["e2_events"]),
            (2, 1, 1),
        )
        self.assertEqual(snap.e1[0].rows[0].logged_at, "2026-10-09")
        self.assertEqual(snap.test_times, {"env": {}})
        self.assertEqual(snap.meta, meta)


class TestChunksAndSnapshot(TestCase):
    def test_chunks_of_at_most_90_days(self) -> None:
        out = events.chunks(datetime(2026, 7, 13), datetime(2026, 11, 4))
        self.assertEqual(out[0], (datetime(2026, 7, 13), datetime(2026, 10, 11)))
        self.assertEqual(out[1], (datetime(2026, 10, 11), datetime(2026, 11, 4)))
        self.assertEqual(events.chunks(datetime(2026, 1, 2), datetime(2026, 1, 2)), [])

    def test_snapshot_round_trip(self) -> None:
        (e1,) = events.parse_e1([e1_row()])
        e1 = replace(e1, rows=[events.parse_rank_row(e2_row())])
        e2 = events.parse_e2([e2_row()])
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            events.write_text(out / events.E1_FILE, events._jsonl([e1]))
            events.write_text(out / events.E2_FILE, events._jsonl(e2))
            events.write_text(out / events.TEST_TIMES_FILE, "{}")
            events.write_text(out / events.META_FILE, '{"start": "2026-07-13"}')
            snap = events.load(out)
        self.assertEqual(snap.e1, [e1])
        self.assertEqual(snap.e1[0].rows[0].all_scores, e1.rows[0].all_scores)
        self.assertEqual(snap.e2[0].row.all_scores, e2[0].row.all_scores)
        self.assertEqual(snap.meta["start"], "2026-07-13")


if __name__ == "__main__":
    main()
