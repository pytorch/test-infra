import fnmatch
import hashlib
import os
import re
import sys
import tempfile
import types
from pathlib import Path
from typing import Any
from unittest import main, mock, TestCase

import numpy as np
from torchci.td.llm import models


FILES = {
    "config.json": b'{"hidden_size": 3}',
    "1_Pooling/config.json": b"{}",
    "model.safetensors": b"weights" * 5,
}


def spec_for(files: dict[str, bytes], key: str = "tiny") -> models.ModelSpec:
    return models.ModelSpec(
        key=key,
        repo="example/tiny",
        revision="1" * 40,
        query_prompt="Q: ",
        doc_prompt="D: ",
        files={
            rel: (hashlib.sha256(data).hexdigest(), len(data))
            for rel, data in files.items()
        },
    )


def write_files(root: Path, files: dict[str, bytes]) -> None:
    for rel, data in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_bytes(data)


class TestRegistry(TestCase):
    def test_specs(self) -> None:
        self.assertIn(models.DEFAULT_MODEL, models.MODELS)
        self.assertEqual(
            sorted(models.MODELS), ["gemma2", "qwen3-0.6b", "qwen3-4b", "qwen3-8b"]
        )
        for key, spec in models.MODELS.items():
            self.assertEqual(spec.key, key)
            self.assertRegex(spec.revision, r"^[0-9a-f]{40}$")
            self.assertEqual(spec.max_tokens, 256)
            self.assertIn("modules.json", spec.files)
            self.assertTrue(any(rel.endswith(".safetensors") for rel in spec.files))
            for rel, (sha256, size) in spec.files.items():
                self.assertRegex(sha256, r"^[0-9a-f]{64}$")
                self.assertGreater(size, 0)
                # download() passes the paths as fnmatch patterns.
                self.assertFalse(set(rel) & set("*?[]"), rel)
                self.assertFalse(
                    rel.endswith((".bin", ".pt", ".pth", ".pkl", ".py")), rel
                )

    def test_require_files(self) -> None:
        models.require_files(spec_for(FILES))
        with self.assertRaises(models.SnapshotError) as ctx:
            models.require_files(spec_for({}))
        self.assertIn("no committed file hashes", str(ctx.exception))

    def test_prompts(self) -> None:
        for key in ["qwen3-0.6b", "qwen3-4b", "qwen3-8b"]:
            spec = models.MODELS[key]
            self.assertTrue(spec.query_prompt.startswith("Instruct: "))
            self.assertTrue(spec.query_prompt.endswith("\nQuery: "))
            self.assertEqual(spec.doc_prompt, "")
        gemma = models.MODELS["gemma2"]
        self.assertEqual(gemma.query_prompt, "task: code retrieval | query: ")
        self.assertEqual(gemma.doc_prompt, "title: none | text: ")

    def test_files_table(self) -> None:
        table = "\n" + "a" * 64 + " 12 x/y.json\n\n" + "b" * 64 + " 3 z.txt\n"
        self.assertEqual(
            models._files(table), {"x/y.json": ("a" * 64, 12), "z.txt": ("b" * 64, 3)}
        )


class TestVerifySnapshot(TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "model"
        write_files(self.root, FILES)
        self.spec = spec_for(FILES)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def assert_rejects(self, fragment: str) -> None:
        with self.assertRaises(models.SnapshotError) as ctx:
            models.verify_snapshot(self.spec, self.root)
        self.assertIn(fragment, str(ctx.exception))

    def test_accepts_the_files_and_a_license(self) -> None:
        models.verify_snapshot(self.spec, self.root)
        (self.root / "LICENSE").write_text("Apache")
        models.verify_snapshot(self.spec, self.root)

    def test_missing_file(self) -> None:
        (self.root / "config.json").unlink()
        self.assert_rejects("missing: config.json")

    def test_wrong_size_and_hash(self) -> None:
        (self.root / "config.json").write_bytes(b"{}")
        self.assert_rejects("has 2 bytes")
        (self.root / "config.json").write_bytes(b'{"hidden_size": 4}')
        self.assert_rejects("does not match its sha256")

    def test_extra_entries(self) -> None:
        (self.root / "README.md").write_text("x")
        self.assert_rejects("unexpected file in the model: README.md")
        (self.root / "README.md").unlink()
        (self.root / ".cache").mkdir()
        self.assert_rejects("unexpected directory in the model: .cache")
        (self.root / ".cache").rmdir()
        (self.root / "1_Pooling" / "extra.py").write_text("x")
        self.assert_rejects("unexpected file in the model: 1_Pooling/extra.py")

    def test_symlinks(self) -> None:
        target = Path(self._tmp.name) / "real.json"
        target.write_bytes(FILES["config.json"])
        (self.root / "config.json").unlink()
        os.symlink(target, self.root / "config.json")
        self.assert_rejects("not a regular file: config.json")
        (self.root / "config.json").unlink()
        (self.root / "config.json").write_bytes(FILES["config.json"])
        os.symlink(self.root / "1_Pooling", self.root / "2_Normalize")
        self.assert_rejects("unexpected directory in the model: 2_Normalize")

    def test_no_committed_files(self) -> None:
        self.spec = spec_for({})
        self.assert_rejects("no committed file hashes")


class TestDownload(TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.spec = spec_for(FILES)
        self.served = dict(FILES)
        self.served["README.md"] = b"not selected by the spec"
        self.calls: list[dict[str, Any]] = []
        hub = types.ModuleType("huggingface_hub")
        hub.snapshot_download = self.fake_snapshot_download  # type: ignore[attr-defined]
        self._modules = mock.patch.dict(sys.modules, {"huggingface_hub": hub})
        self._modules.start()

    def tearDown(self) -> None:
        self._modules.stop()
        self._tmp.cleanup()

    def fake_snapshot_download(self, repo: str, **kwargs: Any) -> str:
        self.calls.append({"repo": repo, **kwargs})
        patterns = kwargs["allow_patterns"]
        selected = {
            rel: data
            for rel, data in self.served.items()
            if any(fnmatch.fnmatchcase(rel, p) for p in patterns)
        }
        selected[".cache/huggingface/download/config.json.metadata"] = b"meta"
        write_files(Path(kwargs["local_dir"]), selected)
        return str(kwargs["local_dir"])

    def test_returns_exactly_the_committed_files(self) -> None:
        dest = self.tmp / "work" / "model"
        self.assertEqual(models.download(self.spec, dest), dest)
        (call,) = self.calls
        self.assertEqual(call["repo"], "example/tiny")
        self.assertEqual(call["revision"], "1" * 40)
        self.assertEqual(call["allow_patterns"], sorted(FILES))
        self.assertEqual(
            sorted(call), ["allow_patterns", "local_dir", "repo", "revision"]
        )
        found = sorted(
            Path(root, name).relative_to(dest).as_posix()
            for root, _, names in os.walk(dest)
            for name in names
        )
        self.assertEqual(found, sorted(FILES))
        self.assertEqual(os.listdir(self.tmp / "work"), ["model"])

    def test_existing_dest_is_verified_not_downloaded(self) -> None:
        dest = self.tmp / "model"
        models.download(self.spec, dest)
        self.assertEqual(models.download(self.spec, dest), dest)
        self.assertEqual(len(self.calls), 1)
        (dest / "config.json").write_bytes(b'{"hidden_size": 4}')
        with self.assertRaises(models.SnapshotError):
            models.download(self.spec, dest)

    def test_tampered_or_missing_download(self) -> None:
        for served in [
            {**FILES, "model.safetensors": b"Weights" * 5},
            {k: v for k, v in FILES.items() if k != "config.json"},
        ]:
            self.served = served
            dest = self.tmp / "model"
            with self.assertRaises(models.SnapshotError):
                models.download(self.spec, dest)
            self.assertEqual(os.listdir(self.tmp), [])

    def test_refuses_a_model_without_hashes(self) -> None:
        with self.assertRaises(models.SnapshotError):
            models.download(spec_for({}), self.tmp / "model")
        self.assertEqual(self.calls, [])


class TestTokenCounts(TestCase):
    def test_counts_without_special_tokens(self) -> None:
        calls: list[Any] = []

        class FakeTokenizer:
            @classmethod
            def from_pretrained(cls, path: str, **kwargs: Any) -> "FakeTokenizer":
                calls.append((path, kwargs))
                return cls()

            def __call__(self, texts: list[str], **kwargs: Any) -> dict[str, Any]:
                calls.append((texts, kwargs))
                return {"input_ids": [t.split() for t in texts]}

        transformers = types.ModuleType("transformers")
        transformers.AutoTokenizer = FakeTokenizer  # type: ignore[attr-defined]
        with mock.patch.dict(sys.modules, {"transformers": transformers}):
            counts = models.token_counts(Path("/m"), ("a b c", "d"))
        self.assertEqual(counts, [3, 1])
        self.assertEqual(
            calls,
            [
                ("/m", {"local_files_only": True}),
                (["a b c", "d"], {"add_special_tokens": False}),
            ],
        )


class FakeSentenceTransformer:
    instances: list["FakeSentenceTransformer"] = []

    def __init__(self, path: str, **kwargs: Any) -> None:
        self.path = path
        self.kwargs = kwargs
        self.max_seq_length = 32768
        self.encode_calls: list[dict[str, Any]] = []
        FakeSentenceTransformer.instances.append(self)

    def get_embedding_dimension(self) -> int:
        return 3

    def encode(self, texts: list[str], **kwargs: Any) -> np.ndarray:
        self.encode_calls.append({"texts": texts, **kwargs})
        return np.full((len(texts), 3), 0.5, dtype=np.float64)


class TestEmbedder(TestCase):
    def setUp(self) -> None:
        FakeSentenceTransformer.instances = []
        self.torch = types.ModuleType("torch")
        self.torch.bfloat16 = "bf16"  # type: ignore[attr-defined]
        self.torch.set_num_threads = mock.Mock()  # type: ignore[attr-defined]
        self.st = types.ModuleType("sentence_transformers")
        self.st.__version__ = "6.2.0"  # type: ignore[attr-defined]
        self.st.SentenceTransformer = FakeSentenceTransformer  # type: ignore[attr-defined]
        self._modules = mock.patch.dict(
            sys.modules, {"torch": self.torch, "sentence_transformers": self.st}
        )
        self._modules.start()
        self.spec = spec_for(FILES)

    def tearDown(self) -> None:
        self._modules.stop()

    def test_loads_offline_from_the_directory(self) -> None:
        embedder = models.Embedder(self.spec, Path("/m"), threads=4)
        (model,) = FakeSentenceTransformer.instances
        self.assertEqual(model.path, "/m")
        self.assertEqual(
            model.kwargs,
            {
                "trust_remote_code": False,
                "local_files_only": True,
                "model_kwargs": {"dtype": "bf16", "use_safetensors": True},
            },
        )
        self.assertEqual(model.max_seq_length, 256)
        self.torch.set_num_threads.assert_called_once_with(4)  # type: ignore[attr-defined]
        self.assertEqual(embedder.dim, 3)

    def test_encode_prompts_and_normalization(self) -> None:
        embedder = models.Embedder(self.spec, Path("/m"))
        self.torch.set_num_threads.assert_not_called()  # type: ignore[attr-defined]
        query = embedder.encode(["a", "b"], "query", batch_size=8)
        doc = embedder.encode(("c",), "doc")
        model = FakeSentenceTransformer.instances[0]
        self.assertEqual(model.encode_calls[0]["prompt"], "Q: ")
        self.assertEqual(model.encode_calls[0]["batch_size"], 8)
        self.assertTrue(model.encode_calls[0]["normalize_embeddings"])
        self.assertEqual(model.encode_calls[1]["prompt"], "D: ")
        self.assertEqual(model.encode_calls[1]["texts"], ["c"])
        for out, rows in [(query, 2), (doc, 1)]:
            self.assertEqual(out.dtype, np.float32)
            self.assertEqual(out.shape, (rows, 3))
            np.testing.assert_allclose(np.linalg.norm(out, axis=1), 1.0, rtol=1e-6)

    def test_empty_prompt_is_passed_explicitly(self) -> None:
        spec = models.ModelSpec("t", "r", "1" * 40, "", "", 256, self.spec.files)
        models.Embedder(spec, Path("/m")).encode(["x"], "doc")
        call = FakeSentenceTransformer.instances[0].encode_calls[0]
        self.assertEqual(call["prompt"], "")

    def test_empty_texts(self) -> None:
        out = models.Embedder(self.spec, Path("/m")).encode([], "query")
        self.assertEqual(out.shape, (0, 3))
        self.assertEqual(out.dtype, np.float32)
        self.assertEqual(FakeSentenceTransformer.instances[0].encode_calls, [])

    def test_unknown_kind(self) -> None:
        with self.assertRaises(ValueError):
            models.Embedder(self.spec, Path("/m")).encode(["x"], "code")  # type: ignore[arg-type]

    def test_old_sentence_transformers_is_refused(self) -> None:
        for version in ["5.4.1", "2.0.0", "dev"]:
            self.st.__version__ = version  # type: ignore[attr-defined]
            with self.assertRaises(RuntimeError) as ctx:
                models.Embedder(self.spec, Path("/m"))
            self.assertTrue(re.search(r">= 6", str(ctx.exception)))
        self.assertEqual(FakeSentenceTransformer.instances, [])


if __name__ == "__main__":
    main()
