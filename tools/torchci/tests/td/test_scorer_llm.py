import contextlib
import hashlib
import io
import json
import os
import re
import subprocess
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any, Optional
from unittest import main, mock, TestCase

import numpy as np
from torchci.td.llm import bundle, cache, diff, models, replay, retrieve
from torchci.td.scorer import llm


DIM = 32
SPEC = models.ModelSpec(
    key="fake",
    repo="fake/fake",
    revision="0" * 40,
    query_prompt="query: ",
    doc_prompt="",
    files={"config.json": (hashlib.sha256(b"{}").hexdigest(), 2)},
)
CORPUS = {
    "test_alpha": ["alpha kernel torch", "alpha import"],
    "test_beta": ["beta reduce torch"],
    "nn/test_gamma": ["gamma conv"],
    "test_delta": ["delta sparse"],
    "test_epsilon": ["epsilon misc"],
    "test_zeta": ["zeta alpha gamma"],
    "test_eta": ["eta kernel conv"],
    "test_theta": ["theta def return"],
    "test_iota": ["iota pass"],
    "test_kappa": ["kappa"],
    "test_lambda": ["lambda gamma pass"],
    "test_mu": ["mu"],
}


def oracle_llm_py(mapping: dict[str, float], tests: list[str]) -> dict[str, float]:
    """pytorch tools/testing/target_determination/heuristics/llm.py on a mapping:
    get_mappings, get_prediction_confidence and normalize_ratings(scores, 0.25), with
    TestPrioritizations' 0.0 for every test it was not given a score for."""
    grouped: dict[str, list[float]] = defaultdict(list)
    for key, value in mapping.items():
        re_match = re.match("(.*).py", key)
        if re_match:
            file = re_match.group(1)
            grouped[file].append(value)
    r = {file: sum(scores) / len(scores) for file, scores in grouped.items()}
    ratings = {test: score for test, score in r.items() if test in tests}
    if ratings:
        if min(ratings.values()) <= 0:
            raise AssertionError("min_rating must be > 0")
        max_rating = max(ratings.values())
        ratings = {t: rank / max_rating * (0.25 - 0) + 0 for t, rank in ratings.items()}
    return {test: ratings.get(test, 0.0) for test in tests}


def dense(scores: dict[str, float], tests: list[str]) -> dict[str, float]:
    return {test: scores.get(test, 0.0) for test in tests}


class FakeEmbedder:
    """Hashed bag of words; records every encode call."""

    calls: list[list[str]] = []
    made = 0

    def __init__(self, spec, model_dir, threads=None) -> None:
        type(self).made += 1
        self.dim = DIM

    def encode(self, texts, kind, batch_size=16) -> np.ndarray:
        assert kind == "query"
        type(self).calls.append(list(texts))
        out = np.full((len(texts), DIM), 0.01, dtype=np.float32)
        for row, text in enumerate(texts):
            for word in re.findall(r"[a-z]+", text.lower()):
                out[row, int(hashlib.md5(word.encode()).hexdigest(), 16) % DIM] += 1
        return out / np.linalg.norm(out, axis=1, keepdims=True)


def fake_bundle(model_dir: Path) -> bundle.Bundle:
    tests = [t for t, texts in CORPUS.items() for _ in texts]
    texts = [x for texts in CORPUS.values() for x in texts]
    embeddings = FakeEmbedder(SPEC, model_dir).encode(texts, "query")
    FakeEmbedder.calls.clear()
    FakeEmbedder.made = 0
    return bundle.Bundle(embeddings, tests, {}, SPEC, model_dir)


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    ).stdout.strip()


def commit(repo: Path, files: dict[str, str], message: str) -> str:
    for rel, text in files.items():
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text(text)
        git(repo, "add", rel)
    git(repo, "commit", "-q", "-m", message)
    return git(repo, "rev-parse", "HEAD")


def unit(unit_id: str, kind: str, sha: Optional[str]) -> dict[str, Any]:
    return {"unit_id": unit_id, "kind": kind, "sha": sha, "candidates_month": "m"}


class ScorerLlmTestCase(TestCase):
    def setUp(self) -> None:
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(mock.patch.dict(os.environ))
        self.enterContext(mock.patch.object(models, "Embedder", FakeEmbedder))
        self.index = fake_bundle(self.tmp / "model")
        self.read = self.enterContext(
            mock.patch.object(bundle, "read", return_value=self.index)
        )
        self.month = sorted(CORPUS) + ["test_not_in_corpus"]
        self.repo = self.make_repo()
        self.bases = {"pr": self.c1}

    def make_repo(self) -> Path:
        """origin/main: c1, c2 (main units); PR head c4 on c3, which forks from c1."""
        repo = self.tmp / "pytorch"
        repo.mkdir()
        git(repo, "init", "-q", "-b", "main")
        git(repo, "config", "user.name", "t")
        git(repo, "config", "user.email", "t@example.com")
        files = {f"torch/{n}.py": f"def {n}():\n    return 1\n" for n in CORPUS}
        files["third_party/x.py"] = "x = 1\n"
        self.c1 = commit(repo, files, "c1")
        self.c2 = commit(
            repo, {"torch/test_beta.py": "def beta_reduce():\n    return 2\n"}, "c2"
        )
        git(repo, "update-ref", "refs/remotes/origin/main", self.c2)
        git(repo, "checkout", "-q", "-b", "pr", self.c1)
        self.c3 = commit(repo, {"torch/a.py": "def alpha_kernel():\n    pass\n"}, "c3")
        self.c4 = commit(repo, {"torch/b.py": "def gamma_conv():\n    pass\n"}, "c4")
        git(repo, "checkout", "-q", "main")
        self.third_party = commit(repo, {"third_party/x.py": "x = 2\n"}, "tp")
        git(repo, "update-ref", "refs/remotes/origin/main", self.third_party)
        return repo

    def scores(self, units, diffs, cache_dir: Optional[Path] = None):
        work = Path(tempfile.mkdtemp(dir=self.tmp))
        return llm.scores(
            units,
            diffs,
            lambda u: self.month,
            self.tmp / "bundle.tar",
            4,
            cache_dir or self.tmp / "cache",
            work,
        )


class TestLlmPart(TestCase):
    TESTS = ["test_a", "dir/test_b", "test_c", "test_d", ""]

    def check(self, mapping: dict[str, float]) -> None:
        self.assertEqual(
            dense(replay.llm_part(mapping, set(self.TESTS)), self.TESTS),
            oracle_llm_py(mapping, self.TESTS),
        )

    def test_key_conversion_matches_llm_py(self) -> None:
        self.check(
            {
                "test_a.py": 0.2,
                "test_a.pyc": 0.6,
                "dir/test_b.py": 0.1,
                "test_c": 0.9,
                "xpy": 0.7,
                "test_dpy.py": 0.3,
                "test_outside.py": 5.0,
            }
        )

    def test_scales_kept_scores_to_a_quarter(self) -> None:
        out = replay.llm_part(
            {"test_a.py": 0.5, "test_c.py": 0.125, "zz.py": 9.0}, set(self.TESTS)
        )
        self.assertEqual(out, {"test_a": 0.25, "test_c": 0.0625})

    def test_no_kept_key_scores_nothing(self) -> None:
        self.check({"test_outside.py": 1.0})
        self.assertEqual(replay.llm_part({}, set(self.TESTS)), {})

    def test_a_score_llm_py_rejects_scores_nothing(self) -> None:
        mapping = {"test_a.py": 0.5, "test_c.py": 0.0}
        with self.assertRaises(AssertionError):
            oracle_llm_py(mapping, self.TESTS)
        self.assertEqual(replay.llm_part(mapping, set(self.TESTS)), {})


class TestUnitDiffs(ScorerLlmTestCase):
    def test_diff_per_kind(self) -> None:
        units = [
            unit("main", "main", self.c2),
            unit("pr", "pr_td_off", self.c4),
            unit("ghstack", "pr_td_off", self.c4),
            unit("no-base", "pr_td_off", self.c4),
            unit("bad-base", "pr_td_off", self.c4),
            unit("explored", "explored", self.c2),
            unit("bad", "main", "not-a-sha"),
            unit("absent", "pr_td_off", "a" * 40),
            unit("absent-main", "main", "b" * 40),
        ]
        bases = {
            "pr": self.c1,
            "ghstack": self.c3,
            "bad-base": "origin/main",
            "explored": self.c1,
            "absent": self.c1,
        }
        diffs = llm.unit_diffs(units, self.repo, bases)
        self.assertEqual(sorted(diffs), ["ghstack", "main", "pr"])
        self.assertEqual(diffs["main"], diff.git_diff(self.repo, self.c1, self.c2))
        self.assertEqual(diffs["pr"], diff.git_diff(self.repo, self.c1, self.c4))
        self.assertEqual(diff.changed_paths(diffs["pr"]), ["torch/a.py", "torch/b.py"])
        # A PR stacked on c3 (its base ref's merge base) diffs only its own change.
        self.assertEqual(diff.changed_paths(diffs["ghstack"]), ["torch/b.py"])

    def test_reads_no_fetch(self) -> None:
        with mock.patch.object(subprocess, "run", wraps=subprocess.run) as run:
            llm.unit_diffs(
                [unit("pr", "pr_td_off", self.c4)], self.repo, {"pr": self.c1}
            )
        self.assertFalse(any("fetch" in c.args[0] for c in run.call_args_list))


class TestScores(ScorerLlmTestCase):
    def retriever_mapping(self) -> dict[str, float]:
        """What retrieve.main writes for the PR head c4 against base c1."""
        git(self.repo, "checkout", "-q", self.c4)
        out = self.tmp / "out.json"
        with contextlib.redirect_stdout(io.StringIO()):
            rc = retrieve.main(
                [
                    "--pytorch",
                    str(self.repo),
                    "--bundle",
                    str(self.tmp / "bundle.tar"),
                    "--out",
                    str(out),
                    "--pr-number",
                    "1",
                    "--base-sha",
                    self.c1,
                    "--work-dir",
                    str(self.tmp / "retrieve-work"),
                ]
            )
        git(self.repo, "checkout", "-q", "main")
        self.assertEqual(rc, 0)
        return json.loads(out.read_text())

    def test_matches_the_retriever_and_llm_py(self) -> None:
        mapping = self.retriever_mapping()
        self.assertGreaterEqual(len(mapping), 3)
        units = [unit("pr", "pr_td_off", self.c4)]
        out = self.scores(units, llm.unit_diffs(units, self.repo, self.bases))
        self.assertEqual(
            dense(out["pr"], self.month), oracle_llm_py(mapping, self.month)
        )
        self.assertEqual(max(out["pr"].values()), 0.25)
        self.assertTrue(all(v > 0 for v in out["pr"].values()))

    def test_units_without_chunks_or_diff(self) -> None:
        units = [
            unit("tp", "main", self.third_party),
            unit("empty", "main", self.c2),
            unit("nodiff", "main", self.c2),
        ]
        out = self.scores(
            units,
            {"tp": diff.git_diff(self.repo, self.c2, self.third_party), "empty": ""},
        )
        self.assertEqual(out, {"tp": {}, "empty": {}})
        self.assertEqual(FakeEmbedder.made, 0)

    def test_chunks_are_embedded_once_and_cached(self) -> None:
        units = [
            unit("main", "main", self.c2),
            unit("pr", "pr_td_off", self.c4),
            unit("again", "main", self.c2),
        ]
        diffs = llm.unit_diffs(units[:2], self.repo, self.bases)
        diffs["again"] = diffs["main"]
        first = self.scores(units, diffs)
        texts = [t for call in FakeEmbedder.calls for t in call]
        chunks = {c for d in diffs.values() for c in diff.query_chunks(d)}
        self.assertEqual(sorted(texts), sorted(chunks))
        self.assertEqual(len(FakeEmbedder.calls), 2)
        self.assertEqual(FakeEmbedder.made, 1)
        self.assertEqual(first["again"], first["main"])
        # The rows sit in td/llm's cache group of the bundle's model, as the harness keys it.
        self.assertEqual(
            set(cache.load(self.tmp / "cache", SPEC, "query")),
            {cache.text_key(c) for c in chunks},
        )
        FakeEmbedder.calls.clear()
        FakeEmbedder.made = 0
        self.assertEqual(self.scores(units, diffs), first)
        self.assertEqual((FakeEmbedder.calls, FakeEmbedder.made), ([], 0))

    def test_unit_batches_and_shards(self) -> None:
        units = [unit("main", "main", self.c2), unit("pr", "pr_td_off", self.c4)]
        diffs = llm.unit_diffs(units, self.repo, self.bases)
        with mock.patch.object(llm, "UNIT_BATCH", 1), mock.patch.object(
            cache, "SHARD_TEXTS", 1
        ):
            out = self.scores(units, diffs, self.tmp / "cache-small")
        self.assertEqual(out, self.scores(units, diffs, self.tmp / "cache-big"))

    def test_model_of_another_dimension_is_refused(self) -> None:
        units = [unit("pr", "pr_td_off", self.c4)]
        diffs = llm.unit_diffs(units, self.repo, self.bases)
        with mock.patch.object(FakeEmbedder, "dim", DIM + 1, create=True):
            with mock.patch.object(FakeEmbedder, "__init__", lambda s, *a, **k: None):
                with self.assertRaises(bundle.BundleError):
                    self.scores(units, diffs)


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc) -> None:
        self.close()


class TestDownloadBundle(TestCase):
    def setUp(self) -> None:
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))

    def test_downloads_and_verifies(self) -> None:
        with mock.patch.object(
            llm.urllib.request, "urlopen", return_value=FakeResponse(b"tar bytes")
        ) as urlopen, mock.patch.object(bundle, "verify", return_value={}) as verify:
            path = llm.download_bundle(self.tmp / "dl")
        self.assertEqual(urlopen.call_args.args[0], llm.BUNDLE_URL)
        self.assertEqual(path, self.tmp / "dl" / "bundle.tar")
        self.assertEqual(path.read_bytes(), b"tar bytes")
        verify.assert_called_once_with(path)

    def test_refuses_an_oversized_download(self) -> None:
        with mock.patch.object(
            llm.urllib.request, "urlopen", return_value=FakeResponse(b"x" * 10)
        ), mock.patch.object(llm, "MAX_BUNDLE_BYTES", 5), mock.patch.object(
            llm, "DOWNLOAD_BLOCK", 4
        ):
            with self.assertRaises(bundle.BundleError):
                llm.download_bundle(self.tmp / "dl")
        self.assertEqual(list((self.tmp / "dl").iterdir()), [])

    def test_an_invalid_bundle_raises(self) -> None:
        with mock.patch.object(
            llm.urllib.request, "urlopen", return_value=FakeResponse(b"junk")
        ):
            with self.assertRaises(bundle.BundleError):
                llm.download_bundle(self.tmp / "dl")


if __name__ == "__main__":
    main()
