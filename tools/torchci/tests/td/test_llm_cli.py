import contextlib
import datetime
import hashlib
import io
import json
import os
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path
from typing import Any, Optional
from unittest import main, mock, TestCase

import numpy as np
from torchci.td.llm import diff, index, models, retrieve


# The flags pytorch/pytorch passes: .github/workflows/llm_td_retrieval.yml ("Run
# Retriever") and .github/workflows/target-determination-indexer.yml ("Build index").
RETRIEVE_WORKFLOW_FLAGS = [
    "--pytorch",
    "--bundle",
    "--out",
    "--pr-number",
    "--base-ref",
    "--base-sha",
    "--github-ref",
]
INDEX_WORKFLOW_FLAGS = ["--pytorch", "--out", "--threads"]

DIM = 64
FAKE_MODEL_FILES = {
    "config.json": b'{"fake": true}\n',
    "model.safetensors": b"not really weights",
}


def fake_spec(files: Optional[dict[str, bytes]] = None) -> models.ModelSpec:
    files = FAKE_MODEL_FILES if files is None else files
    return models.ModelSpec(
        key="fake",
        repo="fake/fake",
        revision="0" * 40,
        query_prompt="query: ",
        doc_prompt="",
        max_tokens=256,
        files={
            rel: (hashlib.sha256(data).hexdigest(), len(data))
            for rel, data in files.items()
        },
    )


class FakeEmbedder:
    """Hashed bag of words: texts sharing words get close unit vectors."""

    def __init__(self, spec, model_dir, threads=None) -> None:
        self.spec = spec
        self.dim = DIM

    def encode(self, texts, kind, batch_size=16) -> np.ndarray:
        out = np.full((len(texts), DIM), 0.01, dtype=np.float32)
        for row, text in enumerate(texts):
            for word in re.findall(r"[a-z]+", text.lower()):
                bucket = int(hashlib.md5(word.encode()).hexdigest(), 16) % DIM
                out[row, bucket] += 1.0
        return out / np.linalg.norm(out, axis=1, keepdims=True)


def member_bytes(tar: tarfile.TarFile, member: Any) -> bytes:
    f = tar.extractfile(member)
    assert f is not None
    return f.read()


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    ).stdout.strip()


def commit(repo: Path, files: dict[str, str], message: str) -> str:
    for rel, text in files.items():
        path = repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        git(repo, "add", rel)
    git(repo, "commit", "-q", "-m", message)
    return git(repo, "rev-parse", "HEAD")


TEST_FILES = {
    "test/test_alpha.py": "import torch\n\nclass TestAlpha:\n    def test_alpha_kernel(self):\n        pass\n",
    "test/test_beta.py": "import torch\n\nclass TestBeta:\n    def test_beta_reduce(self):\n        pass\n",
    "test/nn/test_gamma.py": "def test_gamma_conv():\n    pass\n",
    "test/test_delta.py": "def test_delta_sparse():\n    pass\n",
}


class LlmCliTestCase(TestCase):
    def setUp(self) -> None:
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(mock.patch.dict(os.environ))
        os.environ.pop("GITHUB_TOKEN", None)
        self.enterContext(mock.patch.object(models, "Embedder", FakeEmbedder))
        self.enterContext(mock.patch.dict(models.MODELS, {"fake": fake_spec()}))
        self.model_dir = self.tmp / "fake-model"
        for rel, data in FAKE_MODEL_FILES.items():
            (self.model_dir / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.model_dir / rel).write_bytes(data)
        self.repo = self.make_repo()
        self.bundle = self.tmp / "bundle.tar"
        self.out = self.tmp / "out" / "mappings" / "indexer-files-gitdiff-output.json"

    def make_repo(self) -> Path:
        """main: c1; ghstack-shaped base branch: c2; PR head: c3 on top of c2."""
        repo = self.tmp / "pytorch"
        repo.mkdir()
        git(repo, "init", "-q", "-b", "main")
        git(repo, "config", "user.name", "t")
        git(repo, "config", "user.email", "t@example.com")
        files = dict(TEST_FILES)
        files["torch/alpha.py"] = "def alpha_kernel():\n    return 1\n"
        files["torch/beta.py"] = "def beta_reduce():\n    return 1\n"
        self.c1 = commit(repo, files, "c1")
        git(repo, "update-ref", "refs/remotes/origin/main", self.c1)
        self.c2 = commit(
            repo, {"torch/beta.py": "def beta_reduce():\n    return 2\n"}, "c2"
        )
        git(repo, "update-ref", "refs/remotes/origin/gh/u/1/base", self.c2)
        self.c3 = commit(
            repo, {"torch/alpha.py": "def alpha_kernel():\n    return 2\n"}, "c3"
        )
        return repo

    def build_bundle(self, min_files: int = 2) -> None:
        with (
            mock.patch.object(index, "MIN_TEST_FILES", min_files),
            mock.patch.object(models, "download", return_value=self.model_dir),
        ):
            rc = index.main(
                [
                    "--pytorch",
                    str(self.repo),
                    "--out",
                    str(self.bundle),
                    "--model",
                    "fake",
                    "--work-dir",
                    str(self.tmp / "index-work"),
                ]
            )
        self.assertEqual(rc, 0)

    def run_retrieve(self, *extra: str) -> tuple[int, Any]:
        argv = [
            "--pytorch",
            str(self.repo),
            "--bundle",
            str(self.bundle),
            "--out",
            str(self.out),
            "--work-dir",
            str(self.tmp / "retrieve-work"),
            *extra,
        ]
        stdout, stderr = io.StringIO(), io.StringIO()
        with (
            mock.patch.object(diff, "git_diff", wraps=diff.git_diff) as spy,
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            rc = retrieve.main(argv)
        self.stdout, self.stderr = stdout.getvalue(), stderr.getvalue()
        self.base = spy.call_args.args[1] if spy.called else None
        mapping = json.loads(self.out.read_text()) if self.out.exists() else None
        return rc, mapping

    def rewrite_bundle(self, change) -> None:
        """Copy the bundle member by member, letting change(name, data) edit each."""
        with tarfile.open(self.bundle, "r:") as src:
            members = [(m, member_bytes(src, m)) for m in src.getmembers()]
        with tarfile.open(self.bundle, "w") as dst:
            for member, data in members:
                data = change(member.name, data)
                member.size = len(data)
                dst.addfile(member, io.BytesIO(data))


class TestRetrieve(LlmCliTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.build_bundle()

    def test_writes_mapping_for_a_ghstack_pr(self) -> None:
        rc, mapping = self.run_retrieve(
            "--pr-number", "7", "--base-ref", "gh/u/1/base", "--base-sha", ""
        )
        self.assertEqual(rc, 0, self.stderr)
        self.assertEqual(self.base, self.c2)
        self.assertEqual(list(mapping), ["test_alpha.py"])
        self.assertGreater(mapping["test_alpha.py"], 0)
        self.assertEqual(list(self.out.parent.iterdir()), [self.out])
        self.assertNotIn(retrieve.STALE_BUNDLE_WARNING, self.stdout)

    def test_warns_about_a_stale_bundle(self) -> None:
        def age(name: str, data: bytes) -> bytes:
            if name != "meta.json":
                return data
            meta = json.loads(data)
            meta["created_at"] = "2020-01-01T00:00:00+00:00"
            return json.dumps(meta).encode()

        self.rewrite_bundle(age)
        rc, mapping = self.run_retrieve()
        self.assertEqual(rc, 0, self.stderr)
        self.assertIn(retrieve.STALE_BUNDLE_WARNING, self.stdout.splitlines())
        self.assertEqual(list(mapping), ["test_alpha.py"])

    def test_bundle_age(self) -> None:
        now = datetime.datetime(2026, 11, 4, tzinfo=datetime.timezone.utc)
        for created_at, stale in (
            ("2026-11-03T12:00:00+00:00", False),
            ("2026-11-03T12:00:00", False),
            ("2026-10-31T23:59:59+00:00", True),
            ("not a date", True),
            (None, True),
        ):
            meta = {} if created_at is None else {"created_at": created_at}
            self.assertEqual(retrieve.bundle_is_stale(meta, now), stale, created_at)

    def test_base_sha_when_base_ref_is_absent(self) -> None:
        rc, _ = self.run_retrieve(
            "--pr-number", "7", "--base-ref", "gone/branch", "--base-sha", self.c2
        )
        self.assertEqual(rc, 0, self.stderr)
        self.assertEqual(self.base, self.c2)

    def test_ciflow_tag_ref_takes_base_from_api(self) -> None:
        os.environ["GITHUB_TOKEN"] = "fake-token"
        with mock.patch.object(
            diff, "pr_base_from_api", return_value=("gh/u/1/base", self.c2)
        ) as api:
            rc, mapping = self.run_retrieve(
                "--pr-number", "", "--github-ref", "refs/tags/ciflow/trunk/123"
            )
        self.assertEqual(rc, 0, self.stderr)
        self.assertEqual(api.call_args.args[:2], (123, "fake-token"))
        self.assertEqual(self.base, self.c2)
        self.assertEqual(list(mapping), ["test_alpha.py"])

    def test_no_pr_uses_merge_base_with_main(self) -> None:
        git(self.repo, "checkout", "-q", "-b", "feature", self.c3)
        rc, _ = self.run_retrieve("--github-ref", "refs/heads/feature")
        self.assertEqual(rc, 0, self.stderr)
        self.assertEqual(self.base, self.c1)

    def test_no_pr_on_main_uses_parent(self) -> None:
        git(self.repo, "update-ref", "refs/remotes/origin/main", self.c3)
        rc, mapping = self.run_retrieve("--github-ref", "refs/heads/main")
        self.assertEqual(rc, 0, self.stderr)
        self.assertEqual(self.base, diff.PARENT_OF_HEAD)
        self.assertEqual(list(mapping), ["test_alpha.py"])

    def test_empty_diff_writes_empty_mapping(self) -> None:
        rc, mapping = self.run_retrieve("--pr-number", "7", "--base-sha", self.c3)
        self.assertEqual(rc, 0, self.stderr)
        self.assertEqual(mapping, {})

    def test_missing_bundle(self) -> None:
        self.bundle = self.tmp / "absent.tar"
        rc, mapping = self.run_retrieve()
        self.assertEqual(rc, 1)
        self.assertIsNone(mapping)
        self.assertIn("absent.tar", self.stderr)

    def test_wrong_format_version(self) -> None:
        def bump(name: str, data: bytes) -> bytes:
            if name != "meta.json":
                return data
            meta = json.loads(data)
            meta["format"] += 1
            return json.dumps(meta).encode()

        self.rewrite_bundle(bump)
        rc, mapping = self.run_retrieve()
        self.assertEqual(rc, 1)
        self.assertIsNone(mapping)

    def test_tampered_member(self) -> None:
        self.rewrite_bundle(
            lambda name, data: b'["test_x"]' if name == "tests.json" else data
        )
        rc, mapping = self.run_retrieve()
        self.assertEqual(rc, 1)
        self.assertIsNone(mapping)
        self.assertIn("tests.json", self.stderr)

    def test_model_file_not_matching_registry(self) -> None:
        tampered = dict(FAKE_MODEL_FILES, **{"config.json": b'{"fake": nope}\n'})
        with mock.patch.dict(models.MODELS, {"fake": fake_spec(tampered)}):
            rc, mapping = self.run_retrieve()
        self.assertEqual(rc, 1)
        self.assertIsNone(mapping)
        self.assertIn("config.json does not match its sha256", self.stderr)

    def test_model_dimension_not_matching_embeddings(self) -> None:
        class NarrowEmbedder(FakeEmbedder):
            def __init__(self, *args, **kwargs) -> None:
                super().__init__(*args, **kwargs)
                self.dim = DIM // 2

            def encode(self, texts, kind, batch_size=16) -> np.ndarray:
                return super().encode(texts, kind, batch_size)[:, : self.dim]

        with mock.patch.object(models, "Embedder", NarrowEmbedder):
            rc, mapping = self.run_retrieve()
        self.assertEqual(rc, 1)
        self.assertIsNone(mapping)
        self.assertIn(f"dimension {DIM}, the model {DIM // 2}", self.stderr)

    def test_invalid_base_ref_falls_back_to_main(self) -> None:
        with self.assertLogs(diff.logger, "WARNING") as logs:
            rc, mapping = self.run_retrieve("--pr-number", "7", "--base-ref=-x")
        self.assertEqual(rc, 0, self.stderr)
        self.assertEqual(self.base, self.c1)
        self.assertEqual(sorted(mapping), ["test_alpha.py"])
        self.assertIn("'-x'", "\n".join(logs.output))


class TestIndex(LlmCliTestCase):
    def test_refuses_a_corpus_below_the_floor(self) -> None:
        with (
            mock.patch.object(models, "download") as download,
            contextlib.redirect_stderr(io.StringIO()) as stderr,
        ):
            rc = index.main(
                ["--pytorch", str(self.repo), "--out", str(self.bundle)]
                + ["--model", "fake"]
            )
        self.assertEqual(rc, 1)
        self.assertIn("4 test files", stderr.getvalue())
        download.assert_not_called()
        self.assertFalse(self.bundle.exists())

    def test_refuses_a_model_without_hashes(self) -> None:
        with (
            mock.patch.dict(models.MODELS, {"fake": fake_spec({})}),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            rc = index.main(
                ["--pytorch", str(self.repo), "--out", str(self.bundle)]
                + ["--model", "fake"]
            )
        self.assertEqual(rc, 1)
        self.assertFalse(self.bundle.exists())

    def test_read_back_failure_leaves_no_bundle(self) -> None:
        with (
            mock.patch.object(
                index.bundle, "read", side_effect=index.bundle.BundleError("bad")
            ) as read,
            mock.patch.object(index, "MIN_TEST_FILES", 2),
            mock.patch.object(models, "download", return_value=self.model_dir),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            rc = index.main(
                ["--pytorch", str(self.repo), "--out", str(self.bundle)]
                + ["--model", "fake"]
            )
        self.assertEqual(rc, 1)
        read.assert_called_once()
        self.assertEqual(sorted(p.name for p in self.tmp.glob("*.tar*")), [])
        self.assertEqual(sorted(p.name for p in self.tmp.glob(".*")), [])

    def test_bundle_records_the_corpus(self) -> None:
        self.build_bundle()
        self.assertEqual(sorted(p.name for p in self.tmp.glob(".*")), [])
        with tarfile.open(self.bundle, "r:") as tar:
            meta = json.loads(member_bytes(tar, "meta.json"))
            tests = json.loads(member_bytes(tar, "tests.json"))
        self.assertEqual(meta["pytorch_commit"], self.c3)
        self.assertEqual(meta["model_key"], "fake")
        self.assertEqual(
            sorted(set(tests)),
            ["nn/test_gamma", "test_alpha", "test_beta", "test_delta"],
        )


class TestWorkflowFlags(TestCase):
    def check_parser(self, module, flags: list[str], argv: list[str]) -> None:
        parser = module.build_parser()
        required = {a.option_strings[0] for a in parser._actions if a.required}
        self.assertLessEqual(required, set(flags))
        self.assertLessEqual(set(flags), set(parser._option_string_actions))
        parser.parse_args(argv)

    def test_retrieve_accepts_the_workflow_flags(self) -> None:
        values = ["/pytorch", "/b.tar", "/o.json", "", "", "", "refs/heads/main"]
        argv = [x for pair in zip(RETRIEVE_WORKFLOW_FLAGS, values) for x in pair]
        self.check_parser(retrieve, RETRIEVE_WORKFLOW_FLAGS, argv)
        args = retrieve.build_parser().parse_args(argv)
        self.assertIsNone(args.pr_number)
        self.assertIsNone(args.base_ref)
        self.assertIsNone(args.base_sha)
        self.assertEqual(args.github_ref, "refs/heads/main")

    def test_index_accepts_the_workflow_flags(self) -> None:
        argv = ["--pytorch", "/p", "--out", "/b.tar", "--threads", "16"]
        self.check_parser(index, INDEX_WORKFLOW_FLAGS, argv)
        args = index.build_parser().parse_args(argv)
        self.assertEqual(args.threads, 16)
        self.assertEqual(args.model, models.DEFAULT_MODEL)

    def test_missing_required_flags_exit_2(self) -> None:
        for module in (retrieve, index):
            with (
                contextlib.redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit) as raised,
            ):
                module.main([])
            self.assertEqual(raised.exception.code, 2)


if __name__ == "__main__":
    main()
