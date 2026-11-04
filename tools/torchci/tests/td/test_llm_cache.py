import argparse
import io
import json
import stat
import sys
import tempfile
from pathlib import Path
from unittest import main, mock, TestCase

import numpy as np
from torchci.td.llm import cache
from torchci.td.llm.models import MODELS


SPEC = MODELS["qwen3-0.6b"]


def npy_bytes(array: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    np.lib.format.write_array(buffer, array, allow_pickle=True)
    return buffer.getvalue()


class CacheTest(TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "cache"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_dirs_are_private(self) -> None:
        self.root.mkdir(mode=0o755)
        cache.ensure_dir(self.root / "a" / "b")
        for path in (self.root, self.root / "a" / "b"):
            cache.ensure_dir(path)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)

    def test_lock_refuses_a_second_run(self) -> None:
        with cache.exclusive(self.root):
            with self.assertRaises(RuntimeError):
                with cache.exclusive(self.root):
                    pass
        with cache.exclusive(self.root):
            pass

    def test_shard_files_keep_their_format(self) -> None:
        directory = cache.ensure_dir(self.root / "g")
        matrix = np.arange(4, dtype=np.float32).reshape(2, 2)
        cache.write_shard(directory, "s", ["k1", "k2"], matrix)
        self.assertEqual((directory / "s.npy").read_bytes(), npy_bytes(matrix))
        self.assertEqual(
            (directory / "s.keys.json").read_text(), json.dumps(["k1", "k2"])
        )
        self.assertEqual(
            sorted(p.name for p in directory.iterdir()), ["s.keys.json", "s.npy"]
        )

    def test_a_failed_shard_write_leaves_nothing(self) -> None:
        directory = cache.ensure_dir(self.root / "g")
        with mock.patch(
            "numpy.lib.format.write_array", side_effect=OSError("disk full")
        ):
            with self.assertRaises(OSError):
                cache.write_shard(
                    directory, "s", ["k"], np.zeros((1, 2), dtype=np.float32)
                )
        self.assertEqual(list(directory.iterdir()), [])

    def test_worker_writes_shards_the_cache_reads(self) -> None:
        class FakeEmbedder:
            def __init__(self, spec, model_dir, threads=None):
                self.spec = spec

            def encode(self, texts, kind, batch_size=16):
                return np.array([[len(t), 1.0] for t in texts], dtype=np.float32)

        texts = [f"text {i}" * (i + 1) for i in range(cache.SHARD_TEXTS + 3)]
        path = self.root / "texts.json"
        cache.ensure_dir(self.root)
        path.write_text(json.dumps(texts))
        args = argparse.Namespace(
            model="qwen3-0.6b",
            no_instruction=True,
            texts=path,
            cache_dir=self.root,
            kind="query",
            threads=1,
        )
        with mock.patch("torchci.td.llm.models.Embedder", FakeEmbedder):
            cache.worker(args)
        plain = cache.spec_for("qwen3-0.6b", instruction=False)
        shards = list(cache.group_dir(self.root, plain, "query").glob("*.npy"))
        self.assertEqual(len(shards), 2)
        out = cache.embed(self.root, plain, "query", texts[-2:], False, 1, 1)
        np.testing.assert_array_equal(out[:, 0], [len(texts[-2]), len(texts[-1])])

    def test_group_depends_on_prompt_and_kind(self) -> None:
        plain = cache.spec_for("qwen3-0.6b", instruction=False)
        self.assertEqual(plain.query_prompt, "")
        self.assertEqual(cache.spec_for("qwen3-0.6b", True), SPEC)
        groups = {
            cache.group_dir(self.root, SPEC, "query"),
            cache.group_dir(self.root, plain, "query"),
            cache.group_dir(self.root, SPEC, "doc"),
        }
        self.assertEqual(len(groups), 3)
        self.assertEqual(
            cache.group_dir(self.root, plain, "doc"),
            cache.group_dir(self.root, SPEC, "doc"),
        )
        params = json.loads(
            (cache.group_dir(self.root, SPEC, "query") / "params.json").read_text()
        )
        self.assertEqual(
            params, [SPEC.revision, "query", SPEC.query_prompt, SPEC.max_tokens]
        )
        with self.assertRaises(ValueError):
            cache.group_dir(self.root, SPEC, "code")

    def test_shards_round_trip_and_cached_embed(self) -> None:
        directory = cache.group_dir(self.root, SPEC, "doc")
        texts = ["alpha", "beta", "gamma"]
        matrix = np.arange(6, dtype=np.float32).reshape(3, 2)
        cache.write_shard(directory, "s1", [cache.text_key(t) for t in texts], matrix)
        (directory / "partial.npy").write_bytes(npy_bytes(matrix))
        loaded = cache.load(self.root, SPEC, "doc")
        self.assertEqual(len(loaded), 3)
        out = cache.embed(self.root, SPEC, "doc", ["gamma", "alpha"], True, 1, 1)
        np.testing.assert_array_equal(out, matrix[[2, 0]])
        self.assertEqual(
            cache.embed(self.root, SPEC, "doc", [], True, 1, 1).shape[0], 0
        )

    def test_shard_validation(self) -> None:
        good = np.ones((2, 3), dtype=np.float32)
        cases = {
            "float64": npy_bytes(good.astype(np.float64)),
            "rows": npy_bytes(np.ones((3, 3), dtype=np.float32)),
            "pickle": npy_bytes(np.array([{"a": 1}, None], dtype=object)),
            "nan": npy_bytes(np.full((2, 3), np.nan, dtype=np.float32)),
            "truncated": npy_bytes(good)[:-4],
            "fortran": npy_bytes(np.asfortranarray(good)),
            "1d": npy_bytes(np.ones(2, dtype=np.float32)),
        }
        directory = cache.group_dir(self.root, SPEC, "doc")
        (directory / "s.keys.json").write_text(json.dumps(["k1", "k2"]))
        for name, data in cases.items():
            (directory / "s.npy").write_bytes(data)
            with self.subTest(name), self.assertRaises(ValueError):
                cache.load(self.root, SPEC, "doc")
        (directory / "s.npy").write_bytes(npy_bytes(good))
        np.testing.assert_array_equal(cache.load(self.root, SPEC, "doc")["k2"], good[1])

    def test_worker_failure_is_reported(self) -> None:
        ok = [sys.executable, "-c", "pass"]
        failing = [sys.executable, "-c", "import sys; sys.exit(3)"]
        cache.run_workers([ok, ok])
        with self.assertRaisesRegex(RuntimeError, "worker 1 exited 3"):
            cache.run_workers([ok, failing])


if __name__ == "__main__":
    main()
