import json
import os
import subprocess
import tempfile
from pathlib import Path
from unittest import main, TestCase

from torchci.td.llm import diff, pytorch_repo


DISCOVER = """
import glob
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CPP_TESTS_DIR = os.path.abspath(os.getenv("CPP_TESTS_DIR", default="build/bin"))
TESTS = sorted(
    str(Path(p).relative_to(REPO_ROOT / "test"))[:-3]
    for p in glob.glob(f"{REPO_ROOT}/test/**/test_*.py", recursive=True)
    if "blocked" not in p
) + [f"cpp/{n}" for n in sorted(os.listdir(CPP_TESTS_DIR))]
"""


def git(repo: Path, *args: str, date: str = "2026-08-15T12:00:00Z") -> str:
    env = {**os.environ, "GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date}
    command = ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t"]
    return subprocess.run(
        [*command, *args], capture_output=True, text=True, check=True, env=env
    ).stdout.strip()


def commit(repo: Path, files: dict[str, str], date: str) -> str:
    for rel, text in files.items():
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text(text)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "c", date=date)
    return git(repo, "rev-parse", "HEAD")


class RepoTest(TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.work, self.cache = root / "work", root / "cache"
        self.work.mkdir()
        self.cache.mkdir()
        git(self.work, "init", "-q", "-b", "main")
        files = {
            "tools/testing/discover_tests.py": DISCOVER,
            "test/test_a.py": "import torch\n\nclass TestA:\n    def test_one(self):\n        pass\n",
            "test/blocked/test_b.py": "def test_b():\n    pass\n",
            "torch/x.py": "x = 1\n",
        }
        self.c1 = commit(self.work, files, "2026-07-20T00:00:00Z")
        self.c2 = commit(
            self.work,
            {"torch/x.py": "x = 2\n", "test/test_c.py": "def test_c():\n    pass\n"},
            "2026-08-20T00:00:00Z",
        )
        git(self.work, "checkout", "-q", "-b", "side", self.c1)
        self.c3 = commit(self.work, {"torch/y.py": "y = 1\n"}, "2026-08-21T00:00:00Z")
        git(self.work, "checkout", "-q", "main")
        self.repo = root / "clone.git"
        subprocess.run(
            ["git", "clone", "-q", "--bare", str(self.work), str(self.repo)], check=True
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_resolve_and_present(self) -> None:
        found = pytorch_repo.resolve(
            self.repo, [self.c2, f"{self.c2}~1", "0" * 40, "nope"]
        )
        self.assertEqual(found, {self.c2: self.c2, f"{self.c2}~1": self.c1})
        self.assertEqual(
            pytorch_repo.present(self.repo, [self.c3, "0" * 40]), {self.c3}
        )

    def test_fetch_missing_by_sha(self) -> None:
        shallow = Path(self.tmp.name) / "partial.git"
        subprocess.run(
            [
                "git",
                "clone",
                "-q",
                "--bare",
                "--no-local",
                "--single-branch",
                "-b",
                "main",
                str(self.work),
                str(shallow),
            ],
            check=True,
        )
        self.assertFalse(pytorch_repo.present(shallow, [self.c3]))
        absent, fetched = pytorch_repo.fetch_missing(
            shallow, {self.c3, self.c2, "f" * 40}
        )
        self.assertEqual((absent, fetched), ({"f" * 40}, 1))
        self.assertEqual(pytorch_repo.present(shallow, [self.c3]), {self.c3})

    def test_fetch_refuses_what_is_not_a_sha(self) -> None:
        for bad in ("--upload-pack=x", "main", self.c1[:39]):
            with self.assertRaises(ValueError):
                pytorch_repo.fetch_missing(self.repo, {bad, self.c1})

    def test_two_and_three_dot_diffs(self) -> None:
        two = pytorch_repo.diff_text(self.repo, f"{self.c3}..{self.c2}")
        self.assertEqual(two, git(self.repo, "diff", self.c3, self.c2) + "\n")
        three = pytorch_repo.diff_text(self.repo, f"{self.c2}...{self.c3}")
        self.assertEqual(diff.changed_paths(three), ["torch/y.py"])
        self.assertEqual(
            set(diff.changed_paths(two)),
            {"torch/x.py", "torch/y.py", "test/test_c.py"},
        )

    def test_load_diffs_caches_and_skips_failures(self) -> None:
        revs = {f"{self.c1}..{self.c2}", f"{'0' * 40}..{self.c2}"}
        diffs = pytorch_repo.load_diffs(self.repo, self.cache, revs)
        self.assertEqual(set(diffs), {f"{self.c1}..{self.c2}"})
        self.assertIn("test/test_c.py", diffs[f"{self.c1}..{self.c2}"]["paths"])
        self.assertTrue(
            diffs[f"{self.c1}..{self.c2}"]["chunks"][0].startswith(
                "diff --git a/test/test_c.py"
            )
        )
        with open(self.cache / pytorch_repo.DIFFS_FILE, "a") as f:
            f.write('{"rev": "torn')
        rev = f"{self.c1}...{self.c2}"
        again = pytorch_repo.load_diffs(
            self.repo, self.cache, {rev, f"{self.c1}..{self.c2}"}
        )
        self.assertEqual(again[f"{self.c1}..{self.c2}"], diffs[f"{self.c1}..{self.c2}"])
        lines = (self.cache / pytorch_repo.DIFFS_FILE).read_text().splitlines()
        self.assertEqual(json.loads(lines[-1])["rev"], rev)

    def test_snapshot_per_month(self) -> None:
        snap = pytorch_repo.snapshot(self.repo, self.cache, "2026-08")
        self.assertEqual(snap.commit, self.c1)
        self.assertEqual(snap.tests, frozenset({"test_a"}))
        self.assertEqual(
            {u.test for u in snap.units["skeleton"]}, {"test_a", "blocked/test_b"}
        )
        self.assertGreater(
            len(snap.units["skeleton+functions"]), len(snap.units["skeleton"])
        )
        later = pytorch_repo.snapshot(self.repo, self.cache, "2026-09")
        self.assertEqual(later.commit, self.c2)
        self.assertEqual(later.tests, frozenset({"test_a", "test_c"}))
        stored = json.loads(
            (self.cache / "corpus" / self.c2 / pytorch_repo.TESTS_FILE).read_text()
        )
        self.assertEqual(stored, ["test_a", "test_c"])
        with self.assertRaises(RuntimeError):
            pytorch_repo.snapshot(self.repo, self.cache, "2026-01")


if __name__ == "__main__":
    main()
