import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path
from unittest import main, mock, TestCase

from torchci.td.llm import evaluate, events
from torchci.td.llm.pytorch_repo import CorpusSnapshot
from torchci.td.llm.replay import FileTimes, NO_LLM_PART_BEFORE


FETCHED = "2026-11-04 20:00:00"


def git(repo: Path, *args: str) -> str:
    env = {**os.environ, "GIT_AUTHOR_DATE": "2026-08-01T00:00:00Z"}
    env["GIT_COMMITTER_DATE"] = env["GIT_AUTHOR_DATE"]
    command = [
        "git",
        "-C",
        str(repo),
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        *args,
    ]
    return subprocess.run(
        command, capture_output=True, text=True, check=True, env=env
    ).stdout.strip()


def commit(repo: Path, rel: str, text: str) -> str:
    (repo / rel).parent.mkdir(parents=True, exist_ok=True)
    (repo / rel).write_text(text)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", rel)
    return git(repo, "rev-parse", "HEAD")


def rank_row(test_file: str, job_id: int, logged_at: str = "") -> events.RankRow:
    scores = {"test_a": 2.0, "test_b": 1.0, "test_c": 0.5, "test_d": 0.0}
    position = sorted(scores, key=lambda k: -scores[k]).index(test_file)
    return events.RankRow(
        1, job_id, "pull", "env", "default", test_file, position, 2.0, scores, logged_at
    )


def e1_event(sha: str, landed_at: str, *logged: str) -> events.E1Event:
    rows = [rank_row("test_c", 90 + i, at) for i, at in enumerate(logged)]
    return events.E1Event(
        sha, landed_at, 1, "signal_on_pr", ["test_c"], ["pull / env"], rows
    )


def e2_event(pr: int, test_file: str, head: str, base: str, day: str) -> events.E2Event:
    return events.E2Event(
        pr_number=pr,
        test_file=test_file,
        failed_at=f"{day} 10:00:00",
        head_sha=head,
        base_sha=base,
        base_source="pr_base_sha" if base else "",
        pr_source="pull_request",
        n=4,
        row=rank_row(test_file, pr, f"{day} 10:00:00"),
    )


class EvaluateTest(TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        work = root / "work"
        work.mkdir()
        git(work, "init", "-q", "-b", "main")
        self.base = commit(work, "torch/x.py", "x = 1\n")
        self.landing = commit(work, "torch/x.py", "x = 2\n")
        self.late, self.after, self.untimed = (
            commit(work, f"torch/l{i}.py", "l = 1\n") for i in range(3)
        )
        git(work, "checkout", "-q", "-b", "pr1", self.base)
        self.pr1 = commit(work, "test/test_a.py", "def test_a():\n    pass\n")
        git(work, "checkout", "-q", "-b", "pr2", self.base)
        self.pr2 = commit(work, "torch/y.py", "y = 1\n")
        self.repo = root / "clone.git"
        subprocess.run(
            ["git", "clone", "-q", "--bare", str(work), str(self.repo)], check=True
        )
        self.args = argparse.Namespace(
            pytorch_git=self.repo, cache_dir=root / "cache", sample_prs=0, seed=0
        )
        self.args.cache_dir.mkdir()
        e1 = [
            e1_event(self.landing, "2026-09-01 12:00:00", "2026-09-01 13:00:00"),
            # Landed the day before the cutoff; its main-push ranking was logged after it.
            e1_event(
                self.late, "2026-11-04 23:00:00", f"{NO_LLM_PART_BEFORE} 01:00:00"
            ),
            e1_event(
                self.after,
                f"{NO_LLM_PART_BEFORE} 02:00:00",
                f"{NO_LLM_PART_BEFORE} 03:00:00",
            ),
            e1_event(self.untimed, "2026-10-01 12:00:00", ""),
        ]
        e2 = [
            e2_event(1, "test_a", self.pr1, self.base, "2026-09-02"),
            e2_event(2, "test_b", self.pr2, self.base, "2026-10-02"),
            e2_event(3, "test_c", self.pr2, "", "2026-10-03"),
            e2_event(4, "test_d", self.pr2, self.base, "2026-11-06"),
        ]
        meta = {"start": "2026-07-13", "fetched_at": FETCHED}
        self.snap = events.Snapshot(e1=e1, e2=e2, test_times={}, meta=meta)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_prepare_keeps_events_with_a_base_and_diffs(self) -> None:
        prep = evaluate.prepare(self.args, self.snap)
        self.assertEqual(
            [e.landing_sha for e in prep.e1],
            [self.landing, self.late, self.after, self.untimed],
        )
        self.assertEqual(
            sorted(evaluate.e2_id(e) for e in prep.e2),
            ["1:test_a", "2:test_b", "4:test_d"],
        )
        self.assertIn(f"{self.landing}~1..{self.landing}", prep.diffs)
        self.assertIn(f"{self.landing}^..{self.landing}", prep.diffs)
        self.assertIn(f"{self.base}...{self.pr1}", prep.diffs)
        self.assertTrue(prep.meta["e2"]["1:test_a"]["edited"])
        self.assertFalse(prep.meta["e2"]["2:test_b"]["edited"])
        self.assertEqual(
            prep.meta["e1"][self.landing], {"date": "2026-09-01", "stack_size": 1}
        )
        data = prep.data
        self.assertEqual(data["E2 events skipped (sample, base, commits or diff)"], 1)
        cutoff = NO_LLM_PART_BEFORE
        self.assertEqual(
            data[f"E1 ranking rows left out of the replay (logged from {cutoff})"], 2
        )
        self.assertEqual(
            data[f"E2 events left out of the replay (logged from {cutoff})"], 1
        )
        skipped = "E2 events in the snapshot from pull_request runs, base from nowhere (skipped)"
        self.assertEqual(data[skipped], 1)

    def test_replayable_rows_by_their_own_time(self) -> None:
        late = evaluate.replayable(self.snap.e1[1], self.snap.meta)
        self.assertEqual(late.rows, [])
        untimed = evaluate.replayable(self.snap.e1[3], self.snap.meta)
        self.assertEqual(len(untimed.rows), 1)
        self.assertEqual(evaluate.replayable(self.snap.e1[3], {}).rows, [])

    def test_config_results_wiring(self) -> None:
        prep = evaluate.prepare(self.args, self.snap)
        calls = []

        def unit_scores(rev: str, month: str, agg: str) -> dict[str, float]:
            calls.append((rev, month, agg))
            return {
                "test_a": 0.1,
                "test_b": 0.2,
                "test_c": 0.9,
                "test_d": 0.3,
                "blocked": 1.0,
            }

        tests = frozenset({"test_a", "test_b", "test_c", "test_d"})
        snaps = {
            m: CorpusSnapshot("c", tests, {}) for m in ("2026-09", "2026-10", "2026-11")
        }
        out = evaluate.config_results(
            prep, snaps, FileTimes({}), unit_scores, "max", ("rank",)
        )
        self.assertIn((f"{self.landing}~1..{self.landing}", "2026-09", "max"), calls)
        self.assertIn((f"{self.landing}^..{self.landing}", "2026-09", "max"), calls)
        self.assertIn((f"{self.base}...{self.pr2}", "2026-10", "max"), calls)
        self.assertEqual(out["e1"][self.landing], 0.0)
        self.assertEqual(
            set(out["e1"]), {self.landing, self.late, self.after, self.untimed}
        )
        self.assertEqual(out["e2"]["1:test_a"], 0.75)
        self.assertEqual(sorted(out["e2"]), ["1:test_a", "2:test_b", "4:test_d"])
        self.assertEqual(out["missing"], 0)
        replayed = out["replay"]["rank"]
        self.assertEqual(
            sorted(e["key"] for e in replayed["e1"]),
            sorted([self.landing, self.untimed]),
        )
        self.assertEqual(
            sorted(e["key"] for e in replayed["e2"]), ["1:test_a", "2:test_b"]
        )
        landing = next(e for e in replayed["e1"] if e["key"] == self.landing)
        self.assertEqual(list(landing["rows"][0][1:3]), [False, False])

    def test_save_is_atomic_json(self) -> None:
        path = self.args.cache_dir / "x.json"
        evaluate.save(path, {"b": 1, "a": [1.5]})
        self.assertEqual(path.read_text(), '{"a": [1.5], "b": 1}')
        with mock.patch("json.dump", side_effect=ValueError("boom")):
            with self.assertRaises(ValueError):
                evaluate.save(path, {"c": 2})
        self.assertEqual(json.loads(path.read_text()), {"a": [1.5], "b": 1})
        self.assertEqual([p.name for p in self.args.cache_dir.iterdir()], ["x.json"])


if __name__ == "__main__":
    main()
