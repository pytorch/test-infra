import gzip
import json
import tempfile
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest import main, mock, TestCase

from torchci.td.labels import __main__ as cli, build, main_units, queries, schema


H1, H2, H3 = "1" * 40, "2" * 40, "3" * 40
DAY0 = 1793491200  # 2026-11-01 00:00 UTC
CFG = {"workflow": "trunk", "build_environment": "linux", "test_config": "default"}


def job(push, shard=1, shards=1, conclusion="success", **kw):
    row = {"push_sha": push, "shard": shard, "shards": shards}
    return {**row, "conclusion": conclusion, **CFG, **kw}


def fail(push, file, **kw):
    return {"push_sha": push, "file": file, **CFG, **kw}


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


def world():
    push = {"commit_shas": [], "title": ""}
    return {
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
        self.assertEqual(manifest["units"], {"main": 2})
        self.assertEqual(manifest["positives"], {"main": 1})
        by_id = {u["unit_id"]: u for u in units}
        self.assertEqual(by_id[f"c:{H1}"]["positives"], ["test_a"])
        self.assertEqual(
            {tuple(sorted(u)) for u in units}, {tuple(sorted(schema.FIELDS))}
        )
        self.assertEqual(lists[0]["tests"], ["test_a", "test_b"])

    def test_rejects_empty_window(self):
        argv = ["--start", "2026-11-04", "--stop", "2026-11-04"]
        with self.assertRaises(SystemExit), mock.patch("sys.stderr"):
            cli.main(argv + ["--pytorch", "x", "--out", "y"])


if __name__ == "__main__":
    main()
