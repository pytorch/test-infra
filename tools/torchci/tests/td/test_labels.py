import gzip
import json
import tempfile
from collections import Counter
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest import main, mock, TestCase

from torchci.td.labels import (
    __main__ as cli,
    build,
    exploration_rows,
    main_units,
    pr_units,
    queries,
    schema,
)
from torchci.td.llm import events


H1, H2, H3 = "1" * 40, "2" * 40, "3" * 40
CALL = "0123456789ab"
START, STOP = datetime(2026, 11, 1), datetime(2026, 11, 4)
DAY0 = 1793491200  # 2026-11-01 00:00 UTC
CFG = {"workflow": "trunk", "build_environment": "linux", "test_config": "default"}
DEEP = "[" * 100000 + "]" * 100000


def job(push, shard=1, shards=1, conclusion="success", **kw):
    row = {"push_sha": push, "shard": shard, "shards": shards}
    return {**row, "conclusion": conclusion, **CFG, **kw}


def fail(push, file, **kw):
    return {"push_sha": push, "file": file, **CFG, **kw}


def e2_row(pr, file, failed_at="2026-11-02 10:00:00", **kw):
    row = {
        "pr_number": pr,
        "test_file": file,
        "failed_at": failed_at,
        "run_id": 1,
        "job_id": 2,
        "workflow": "pull",
        "build_environment": "linux",
        "test_config": "default",
        "position": 3,
        "n": 4,
        "max_score": 1.0,
        "all_scores": json.dumps({file: 1.0, "cpp/test_x": 0.5}),
        "head_sha": H1,
        "nonpr_branches": [],
        "pr_source": "pull_request",
    }
    return {**row, **kw}


def drawn(file="test_e", count=250, top_part=False, test=None, **kw):
    d = {"test": test or file, "test_file": file, "score": 0.0, "weight": 1.0}
    d |= {"position": 9, "cost": 20.0, "count": count, "propensity": count / 1000}
    return {**d, "top_part": top_part, **kw}


def info_of(tests=None, **kw):
    body = {
        "sha": H2,
        "pr_number": 8,
        "call": CALL,
        "replicates": 1000,
        "frame": 40,
        "out_of_frame": 2,
        "out_of_frame_seconds": 900.0,
        "skipped_seconds": 3600.0,
        "explored": [drawn()] if tests is None else tests,
    }
    return json.dumps({**body, **kw})


def xrow(tests=None, job_id=11, run_id=10, ts="2026-11-02 10:00:00", **info):
    return {
        "repo": "pytorch/pytorch",
        "run_id": run_id,
        "job_id": job_id,
        "workflow": "pull",
        "build_environment": "linux",
        "test_config": "default",
        "timestamp": ts,
        "oversized": 0,
        "info": info_of(tests, **info),
    }


def xjob(job_id=11, run_id=10, attempt=1, **kw):
    row = {
        "job_id": job_id,
        "run_id": run_id,
        "run_attempt": attempt,
        "head_sha": H2,
        "head_branch": "feature",
        "workflow": "pull",
        "name": "linux / test (default, 1, 2, linux.2xlarge)",
        "repo": "pytorch/pytorch",
        "td_scope": 1,
        "run_prs": [8],
    }
    return {job_id: {**row, **kw}}


def head_job(job_id, run_id=10, attempt=1, sha=H2, created=DAY0 + 33 * 3600, **kw):
    row = {"job_id": job_id, "run_id": run_id, "run_attempt": attempt}
    row |= {"created": created, "head_sha": sha}
    return {**row, **CFG, "workflow": "pull", **kw}


def stub(rows):
    return mock.patch.object(queries, "ch", lambda name, sql, params: rows[name])


class TestSilver(TestCase):
    def test_new_failure_confirmed_at_next_reported_push(self):
        jobs = [job("p0"), job("p1", conclusion="failure"), job("p2")]
        jobs += [job("p3", conclusion="failure")]
        fails = [fail("p1", "test_a"), fail("p3", "test_a")]
        order = ["p0", "p1", "p2", "p3"]
        self.assertEqual(main_units.silver(order, jobs, fails), {})
        jobs[2] = job("p2", conclusion="cancelled")
        self.assertEqual(main_units.silver(order, jobs, fails), {"p1": {"test_a"}})

    def test_rejections(self):
        order = ["p0", "p1", "p2"]
        jobs = [job("p0"), job("p1", conclusion="failure")]
        jobs += [job("p2", conclusion="failure")]
        fails = [fail("p1", "test_a"), fail("p2", "test_a")]
        self.assertEqual(main_units.silver(order, jobs, fails), {"p1": {"test_a"}})
        failing_before = fails + [fail("p0", "test_a", test_config="other")]
        self.assertEqual(main_units.silver(order, jobs, failing_before), {})
        prev_partial = [job("p0", shard=1, shards=2)] + jobs[1:]
        self.assertEqual(main_units.silver(order, prev_partial, fails), {})
        self.assertEqual(main_units.silver(order, jobs, fails[:1]), {})

    def test_confirmation_window(self):
        n = main_units.SILVER_CONFIRM_PUSHES
        order = [f"p{i}" for i in range(n + 3)]
        jobs = [job("p0"), job("p1", conclusion="failure")]
        jobs += [job(f"p{i}", conclusion="cancelled") for i in range(2, n + 2)]
        jobs += [job(f"p{n + 2}", conclusion="failure")]
        fails = [fail("p1", "test_a"), fail(f"p{n + 2}", "test_a")]
        self.assertEqual(main_units.silver(order, jobs, fails), {})

    def test_main_units(self):
        t0 = DAY0 - 365 * 86400
        pushes = [
            {"push_sha": H1, "pushed_at": t0 + 10, "commit_shas": [H1]},
            {"push_sha": H2, "pushed_at": t0 + 20, "commit_shas": [H2, H3]},
            {"push_sha": H3, "pushed_at": t0 - 10, "commit_shas": [H3]},
        ]
        for p, title in zip(pushes, ("Fix it (#123)", "x", "y")):
            p["title"] = title
        many = {f"t{i}" for i in range(main_units.SILVER_MAX_TRAIN_FILES + 1)}
        cands = {"2025-11": ["test_a", "t1"]}
        start, stop = datetime(2025, 11, 1), datetime(2025, 12, 1)
        out = main_units.units(pushes, {H1: many | {"test_a"}}, cands, start, stop)
        self.assertEqual([u["unit_id"] for u in out], [f"c:{H1}"])
        u = out[0]
        self.assertEqual(list(u), list(schema.FIELDS))
        self.assertEqual((u["pr_number"], u["candidates_month"]), (123, "2025-11"))
        self.assertEqual(u["positives"], ["t1", "test_a"])
        self.assertFalse(u["train_ok"])

    def test_cpp_tests(self):
        rankings = [("2026-11-02 10:00:00", {"cpp/test_y::A": 1.0, "test_nn": 0.0})]
        self.assertEqual(main_units.cpp_tests(rankings), {"2026-11": {"cpp/test_y"}})


class TestTdOff(TestCase):
    def extra(self, env="macos-arm64", head=H1, scores=None, **kw):
        scores = scores or json.dumps({"test_c": 1.0, "test_d, TestD": 0.5})
        off = [5, 6, "trunk", env, "default", head, 3, 10, scores]
        row = {"pr_number": 7, "test_file": "test_c", "n_jobs": 2, "n_heads": 1}
        return {**row, "off_failed_at": "2026-11-02 11:00:00", "off": off, **kw}

    def test_units_and_drops(self):
        e2 = events.parse_e2([e2_row(7, "test_c"), e2_row(9, "test_z")])
        dropped = Counter()
        groups = pr_units.td_off_failures(e2, [self.extra()], dropped)
        key = (7, H1, "trunk", "macos-arm64", "default")
        self.assertEqual(list(groups), [key])
        rows = {
            "head_jobs": [head_job(6, 5, sha=H1, build_environment="macos-arm64")],
            "ran_files": [{"job_id": 6, "ran": ["test_c", "test_d"], "failed": []}],
        }
        rows["head_jobs"][0]["workflow"] = "trunk"
        with stub(rows):
            (u,) = pr_units.td_off_units(groups)
        self.assertEqual(u["unit_id"], f"p:7:{H1}:trunk:macos-arm64:default")
        self.assertEqual(u["candidates"], ["test_c", "test_d"])
        self.assertEqual((u["positives"], u["confirmed"]), (["test_c"], ["test_c"]))
        self.assertEqual(u["observed"], ["test_c", "test_d"])
        for bad in (self.extra(env="linux"), self.extra(head="")):
            pr_units.td_off_failures(e2, [bad], dropped)
        for scores in (DEEP, '{"a": 1' + "0" * 400 + "}", "[1]", '{"a": "x"}'):
            pr_units.td_off_failures(e2, [self.extra(scores=scores)], dropped)
        no_off = self.extra()
        no_off["off"] = [0, 0, "", "", "", "", 0, 0, "{}"]
        self.assertEqual(pr_units.td_off_failures(e2, [no_off], dropped), {})
        self.assertEqual(
            dropped,
            {
                "pr_td_off:cut_applied": 1,
                "pr_td_off:no_head": 1,
                "pr_td_off:malformed": 4,
            },
        )

    def test_run_evidence_falls_back_to_all_test_runs(self):
        key = (7, H1, "trunk", "macos-arm64", "default")
        jobs = [head_job(j, 5, sha=H1, workflow="trunk") for j in (6, 7, 8)]
        for j in jobs[:2]:
            j["build_environment"] = "macos-arm64"
        rows = {
            "head_jobs": jobs,
            "ran_files": [{"job_id": 6, "ran": ["test_c"], "failed": []}],
            "ran_files_all": [{"job_id": 7, "ran": ["test_d"], "failed": []}],
        }
        calls = []

        def ch(name, sql, params):
            calls.append((name, params))
            return rows[name]

        with mock.patch.object(queries, "ch", ch):
            out = pr_units.run_evidence({key: DAY0 + 86400 + 11 * 3600})
        self.assertEqual(out, {key: {"test_c", "test_d"}})
        self.assertEqual(calls[1][1], {"run_ids": [5], "job_ids": [6, 7]})
        self.assertEqual(calls[2][1]["job_ids"], [7])
        self.assertEqual(calls[2][1]["start"], "2026-10-31 11:00:00")

    def test_e2_reads_back_a_year(self):
        params = {}

        def ch(name, sql, p):
            params[name] = p
            return []

        with mock.patch.object(queries, "ch", ch):
            self.assertEqual(queries.fetch_e2(START, STOP), [])
        self.assertEqual(params["e2"]["look_back_days"], 365)


class TestExploredValidation(TestCase):
    def check(self, row, jobs=None):
        return exploration_rows.validate(row, xjob() if jobs is None else jobs)[0]

    def test_accepts_and_takes_the_pr_from_github(self):
        reason, unit = exploration_rows.validate(xrow(), xjob())
        self.assertEqual(reason, "")
        group = (8, H2, "pull", "linux", "default")
        self.assertEqual((unit["group"], unit["call"]), (group, CALL))
        self.assertEqual(unit["attempt"], (10, 1))
        self.assertEqual(unit["frame"]["skipped_seconds"], 3600.0)
        tagged = xjob(head_branch="ciflow/trunk/8", run_prs=[])
        self.assertEqual(self.check(xrow(pr_number=None), tagged), "")
        self.assertEqual(self.check(xrow(pr_number=None)), "")
        self.assertEqual(self.check(xrow([])), "")

    def test_each_rejection(self):
        missing = drawn()
        del missing["top_part"]
        cases = {
            "repo": [({**xrow(), "repo": "x/fork"}, None)],
            "too_large": [({**xrow(), "oversized": 1}, None)],
            "replicates": [(xrow(replicates=999), None)],
            "too_many_tests": [(xrow([drawn()] * 501), None)],
            "job_missing": [(xrow(), {})],
            "run_mismatch": [(xrow(), xjob(run_id=99))],
            "sha_mismatch": [(xrow(), xjob(head_sha=H3))],
            "workflow_scope": [(xrow(), xjob(td_scope=0))],
            "not_shard_1": [(xrow(), xjob(name="linux / test (default, 2, 2, x)"))],
            "test_config": [(xrow(), xjob(name="linux / test (crossref, 1, 1, x)"))],
            "no_pr": [(xrow(pr_number=None), xjob(run_prs=[]))],
            "pr_ambiguous": [(xrow(pr_number=None), xjob(run_prs=[8, 9]))],
            "pr_mismatch": [
                (xrow(), xjob(run_prs=[9])),
                (xrow(), xjob(run_prs=[], head_branch="ciflow/trunk/9")),
            ],
            "propensity": [
                (xrow([drawn(count=0)]), None),
                (xrow([drawn(count=1001)]), None),
                (xrow([{**drawn(), "count": 10**400}]), None),
                (xrow([{**drawn(), "propensity": 10**400}]), None),
                (xrow([{**drawn(), "propensity": 0.5}]), None),
            ],
        }
        cases["repo"].append((xrow(), xjob(repo="pytorch/ciforge")))
        for reason, pairs in cases.items():
            for row, jobs in pairs:
                self.assertEqual(self.check(row, jobs), reason, reason)
        malformed = [
            {**xrow(), "info": "{not json"},
            {**xrow(), "info": DEEP},
            {**xrow(), "info": None},
            {**xrow(), "job_id": "x"},
            xrow(call="x"),
            xrow(sha="abc"),
            xrow(explored={}),
            xrow(frame=-1),
            xrow(skipped_seconds=float("nan")),
            xrow(skipped_seconds=10**400),
            xrow(out_of_frame_seconds=None),
            xrow(pr_number=10**400),
            xrow([missing]),
            xrow([drawn(score="high")]),
            xrow([drawn(test_file="")]),
        ]
        with mock.patch.object(exploration_rows.logger, "warning") as warn:
            for row in malformed:
                self.assertEqual(self.check(row), "malformed", str(row)[:80])
        self.assertEqual(warn.call_count, 3)


def world():
    off = [5, 6, "trunk", "macos-arm64", "default", H1, 3, 10, '{"test_c": 1.0}']
    push = {"commit_shas": [], "title": ""}
    return {
        "e2": [e2_row(7, "test_c")],
        "main_pushes": [
            {**push, "push_sha": H3, "pushed_at": DAY0 - 3600, "commit_shas": [H3]},
            {**push, "push_sha": H1, "pushed_at": DAY0 + 10, "commit_shas": [H1]},
            {**push, "push_sha": H2, "pushed_at": DAY0 + 20, "commit_shas": [H2]},
        ],
        "main_jobs": [
            job(H3, job_id=1),
            job(H1, conclusion="failure", job_id=2),
            job(H2, conclusion="failure", job_id=3),
        ],
        "failed_files": [
            {"job_id": 2, "file": "test_a"},
            {"job_id": 3, "file": "test_a"},
        ],
        "pr_fail_extra": [
            {
                "pr_number": 7,
                "test_file": "test_c",
                "n_jobs": 1,
                "n_heads": 1,
                "off_failed_at": "2026-11-02 11:00:00",
                "off": off,
            }
        ],
        "head_jobs": [
            head_job(6, 5, sha=H1, workflow="trunk", build_environment="macos-arm64")
        ],
        "ran_files": [{"job_id": 6, "ran": ["test_c", "test_d"], "failed": []}],
        "ran_files_all": [],
    }


class TestCli(TestCase):
    def run_build(self, rows, start="2026-11-01", now=None):
        snap = SimpleNamespace(commit=H3, tests=frozenset({"test_a", "test_b"}))
        with tempfile.TemporaryDirectory() as tmp, stub(rows), mock.patch.object(
            main_units.pytorch_repo, "snapshot", return_value=snap
        ):
            out = Path(tmp) / "out"
            argv = ["--start", start, "--stop", "2026-11-04"]
            with mock.patch("builtins.print"), mock.patch.object(
                cli, "build", lambda *a: build(*a, now=now or datetime(2026, 11, 9))
            ):
                cli.main(argv + ["--pytorch", tmp, "--out", str(out)])
            manifest = json.loads((out / "manifest.json").read_text())
            with gzip.open(out / "units.jsonl.gz", "rt") as f:
                units = [json.loads(line) for line in f]
            with gzip.open(out / "candidates.jsonl.gz", "rt") as f:
                lists = [json.loads(line) for line in f]
        return manifest, units, lists

    def test_writes_files(self):
        manifest, units, lists = self.run_build(world())
        expected = {"main": 2, "pr_td_off": 1}
        self.assertEqual(manifest["units"], expected)
        self.assertEqual(manifest["positives"], expected | {"main": 1})
        self.assertFalse(manifest["pr_kinds_skipped"])
        by_id = {u["unit_id"]: u for u in units}
        self.assertEqual(by_id[f"c:{H1}"]["positives"], ["test_a"])
        self.assertEqual(
            {tuple(sorted(u)) for u in units}, {tuple(sorted(schema.FIELDS))}
        )
        self.assertEqual(lists[0]["tests"], ["cpp/test_x", "test_a", "test_b"])

    def test_old_window_skips_pr_kinds(self):
        rows = {k: v for k, v in world().items() if k.startswith(("main", "failed"))}
        with self.assertLogs("torchci.td.labels", "WARNING"):
            manifest, _, _ = self.run_build(rows, now=datetime(2027, 11, 2))
        self.assertTrue(manifest["pr_kinds_skipped"])
        self.assertEqual(manifest["units"], {"main": 2, "pr_td_off": 0})
        manifest, _, _ = self.run_build(world(), now=datetime(2027, 11, 1))
        self.assertFalse(manifest["pr_kinds_skipped"])

    def test_rejects_empty_window(self):
        argv = ["--start", "2026-11-04", "--stop", "2026-11-04"]
        with self.assertRaises(SystemExit), mock.patch("sys.stderr"):
            cli.main(argv + ["--pytorch", "x", "--out", "y"])


if __name__ == "__main__":
    main()
