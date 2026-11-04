import contextlib
import gzip
import hashlib
import io
import json
import os
import tarfile
import tempfile
from pathlib import Path
from typing import Any, Callable, Optional
from unittest import main, mock, TestCase

import numpy as np
from torchci.td.llm import bundle, models


MODEL_FILES = {
    "config.json": b'{"hidden_size": 4}',
    "1_Pooling/config.json": b'{"pooling_mode_lasttoken": true}',
    "model.safetensors": b"\x00weights\x01" * 10,
}

Item = tuple[tarfile.TarInfo, bytes]


def tiny_spec(files: Optional[dict[str, bytes]] = None) -> models.ModelSpec:
    files = MODEL_FILES if files is None else files
    return models.ModelSpec(
        key="tiny",
        repo="example/tiny",
        revision="0" * 40,
        query_prompt="Query: ",
        doc_prompt="",
        max_tokens=256,
        files={
            rel: (hashlib.sha256(data).hexdigest(), len(data))
            for rel, data in files.items()
        },
    )


def item(name: str, data: bytes, **attrs: Any) -> Item:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    for key, value in attrs.items():
        setattr(info, key, value)
    return info, data


def tar_bytes(items: list[Item]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:", format=tarfile.PAX_FORMAT) as tar:
        for info, data in items:
            tar.addfile(info, io.BytesIO(data) if info.isreg() else None)
    return buffer.getvalue()


def npy_bytes(array: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    np.lib.format.write_array(buffer, array, allow_pickle=False)
    return buffer.getvalue()


class TestAtomicFile(TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.path = self.dir / "out.json"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_replaces_on_success(self) -> None:
        self.path.write_text("old")
        with bundle.atomic_file(self.path) as f:
            f.write(b"new bytes")
            self.assertEqual(self.path.read_text(), "old")
        self.assertEqual(self.path.read_bytes(), b"new bytes")
        with bundle.atomic_file(self.path, "w") as f:
            f.write("t\u00e9xt")
        self.assertEqual(self.path.read_text(encoding="utf-8"), "t\u00e9xt")
        self.assertEqual(os.listdir(self.dir), ["out.json"])

    def test_keeps_the_old_file_on_failure(self) -> None:
        self.path.write_text("old")
        with self.assertRaises(RuntimeError):
            with bundle.atomic_file(self.path) as f:
                f.write(b"partial")
                raise RuntimeError("boom")
        self.assertEqual(self.path.read_text(), "old")
        self.assertEqual(os.listdir(self.dir), ["out.json"])

    def test_write_modes_only(self) -> None:
        for mode in ["r", "rb", "a", "ab", "w+"]:
            with self.assertRaises(ValueError):
                with bundle.atomic_file(self.path, mode):
                    pass
        self.assertEqual(os.listdir(self.dir), [])


class TestLoadNpyChecked(TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "a.npy"
        self.array = np.arange(6, dtype=np.float32).reshape(2, 3)
        self.path.write_bytes(npy_bytes(self.array))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def assert_rejects(self, fragment: str, **kwargs: Any) -> None:
        with self.assertRaises(ValueError) as ctx:
            bundle.load_npy_checked(self.path, **{"dtype": np.float32, **kwargs})
        self.assertIn(fragment, str(ctx.exception))

    def test_loads(self) -> None:
        for kwargs in [{}, {"rows": 2}, {"dim": 3}, {"rows": 2, "dim": 3}]:
            loaded = bundle.load_npy_checked(self.path, np.float32, **kwargs)
            np.testing.assert_array_equal(loaded, self.array)
        empty = np.zeros((0, 3), dtype=np.float32)
        self.path.write_bytes(npy_bytes(empty))
        self.assertEqual(bundle.load_npy_checked(self.path, "<f4", 0, 3).shape, (0, 3))

    def test_loads_a_version_2_header(self) -> None:
        buffer = io.BytesIO()
        np.lib.format.write_array(buffer, self.array, version=(2, 0))
        self.assertEqual(buffer.getvalue()[6:8], b"\x02\x00")
        self.path.write_bytes(buffer.getvalue())
        loaded = bundle.load_npy_checked(self.path, np.float32, 2, 3)
        np.testing.assert_array_equal(loaded, self.array)

    def test_rejects(self) -> None:
        self.assert_rejects("has shape", rows=3)
        self.assert_rejects("has shape", dim=2)
        self.assert_rejects("is not a C-ordered <f2 array", dtype="<f2")
        for array, fragment in [
            (np.zeros(3, dtype=np.float32), "has shape"),
            (np.asfortranarray(self.array), "C-ordered"),
            (np.array([[1.0, np.inf]], dtype=np.float32), "non-finite"),
        ]:
            self.path.write_bytes(npy_bytes(array))
            self.assert_rejects(fragment)
        self.path.write_bytes(npy_bytes(self.array)[:-1])
        self.assert_rejects("size does not match its header")
        self.path.write_bytes(npy_bytes(self.array) + b"x")
        self.assert_rejects("size does not match its header")
        data = bytearray(npy_bytes(self.array))
        data[6] = 3
        self.path.write_bytes(bytes(data))
        self.assert_rejects("unsupported .npy version")

    def test_bool_or_negative_shape_is_refused(self) -> None:
        for shape in [(True, True), (2, False), (-1, 3)]:
            buffer = io.BytesIO()
            header = {"descr": "<f4", "fortran_order": False, "shape": shape}
            np.lib.format.write_array_header_1_0(buffer, header)
            self.path.write_bytes(buffer.getvalue() + b"\x00" * 4)
            self.assert_rejects("has shape")

    def test_object_header_is_refused_before_loading(self) -> None:
        buffer = io.BytesIO()
        header = {"descr": "|O", "fortran_order": False, "shape": (1, 2)}
        np.lib.format.write_array_header_1_0(buffer, header)
        self.path.write_bytes(buffer.getvalue() + b"\x80\x04junk")
        self.assert_rejects("C-ordered")


class BundleTest(TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.spec = tiny_spec()
        self._registry = mock.patch.dict(models.MODELS, {"tiny": self.spec})
        self._registry.start()
        self.model_dir = self.make_model_dir(MODEL_FILES)
        rng = np.random.default_rng(0)
        self.embeddings = rng.normal(size=(3, 4)).astype(np.float32)
        self.embeddings /= np.linalg.norm(self.embeddings, axis=1, keepdims=True)
        self.tests = ["test_a", "nn/test_b", "test_a"]
        self.path = self.tmp / "bundle.tar"
        bundle.write(
            self.path, self.embeddings, self.tests, self.spec, self.model_dir, "abc123"
        )
        self.dest_count = 0

    def tearDown(self) -> None:
        self._registry.stop()
        self._tmp.cleanup()

    def make_model_dir(self, files: dict[str, bytes], name: str = "model") -> Path:
        root = self.tmp / name
        for rel, data in files.items():
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_bytes(data)
        return root

    def dest(self) -> Path:
        self.dest_count += 1
        return self.tmp / f"out{self.dest_count}"

    def items(self) -> list[Item]:
        with tarfile.open(self.path, "r:") as tar:
            return [(m, tar.extractfile(m).read()) for m in tar]  # type: ignore[union-attr]

    def rebuild(
        self,
        edit: Callable[[list[Item]], list[Item]],
        meta_edit: Optional[Callable[[dict], None]] = None,
        rehash: bool = True,
    ) -> Path:
        items = edit(self.items())
        if rehash:
            meta = json.loads(items[0][1])
            meta["sha256"] = {
                info.name: hashlib.sha256(data).hexdigest() for info, data in items[1:]
            }
            if meta_edit:
                meta_edit(meta)
            items[0] = item(bundle.META, json.dumps(meta).encode())
        path = self.tmp / f"edited{self.dest_count}.tar"
        path.write_bytes(tar_bytes(items))
        return path

    def assert_invalid(
        self, path: Path, fragment: str, verify_too: bool = True
    ) -> None:
        with self.assertRaises(bundle.BundleError) as ctx:
            bundle.read(path, self.dest())
        self.assertIn(fragment, str(ctx.exception))
        self.assertNotIn("\n", str(ctx.exception))
        if verify_too:
            with self.assertRaises(bundle.BundleError):
                bundle.verify(path)


class TestRoundTrip(BundleTest):
    def test_write_then_read(self) -> None:
        result = bundle.read(self.path, self.dest())
        self.assertEqual(result.embeddings.dtype, np.float32)
        np.testing.assert_allclose(result.embeddings, self.embeddings, atol=1e-3)
        self.assertEqual(result.tests, self.tests)
        self.assertIs(result.spec, self.spec)
        meta = result.meta
        self.assertEqual(meta["format"], bundle.FORMAT_VERSION)
        self.assertEqual(meta["model_key"], "tiny")
        self.assertEqual(meta["model_revision"], "0" * 40)
        self.assertEqual(meta["query_prompt"], "Query: ")
        self.assertEqual(meta["max_tokens"], 256)
        self.assertEqual((meta["rows"], meta["dim"]), (3, 4))
        self.assertEqual(meta["pytorch_commit"], "abc123")
        self.assertTrue(meta["created_at"].endswith("+00:00"))
        for rel, data in MODEL_FILES.items():
            self.assertEqual((result.model_dir / rel).read_bytes(), data)
        self.assertEqual(
            (result.model_dir / "LICENSE").read_bytes(),
            bundle.LICENSE_TEXT.read_bytes(),
        )
        self.assertIn("Apache License", bundle.LICENSE_TEXT.read_text())

    def test_member_layout(self) -> None:
        names = [info.name for info, _ in self.items()]
        self.assertEqual(names[0], bundle.META)
        self.assertEqual(
            sorted(names),
            sorted(
                [bundle.META, bundle.EMBEDDINGS, bundle.TESTS, "model/LICENSE"]
                + [f"model/{rel}" for rel in MODEL_FILES]
            ),
        )
        meta = json.loads(self.items()[0][1])
        self.assertEqual(sorted(meta["sha256"]), sorted(names[1:]))
        stored = np.load(
            io.BytesIO(dict((i.name, d) for i, d in self.items())[bundle.EMBEDDINGS])
        )
        self.assertEqual(stored.dtype, np.float16)

    def test_verify_and_command(self) -> None:
        self.assertEqual(bundle.verify(self.path)["model_key"], "tiny")
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(bundle.main(["verify", str(self.path)]), 0)
        self.assertIn("bundle ok", out.getvalue())
        broken = self.tmp / "broken.tar"
        broken.write_bytes(self.path.read_bytes()[:2048])
        with contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(bundle.main(["verify", str(broken)]), 1)
        self.assertTrue(err.getvalue().startswith("invalid bundle: "))

    def test_snapshot_license_is_kept(self) -> None:
        files = {**MODEL_FILES, "LICENSE": b"the model's own license\n"}
        spec = tiny_spec(files)
        model_dir = self.make_model_dir(files, "licensed")
        path = self.tmp / "licensed.tar"
        with mock.patch.dict(models.MODELS, {"tiny": spec}):
            bundle.write(path, self.embeddings, self.tests, spec, model_dir, "c")
            result = bundle.read(path, self.dest())
        self.assertEqual((result.model_dir / "LICENSE").read_bytes(), files["LICENSE"])

    def test_empty_index(self) -> None:
        path = self.tmp / "empty.tar"
        bundle.write(path, np.zeros((0, 4)), [], self.spec, self.model_dir, "c")
        result = bundle.read(path, self.dest())
        self.assertEqual(result.embeddings.shape, (0, 4))


class TestWrite(BundleTest):
    def test_refuses_bad_input_and_leaves_no_temp_file(self) -> None:
        before = self.path.read_bytes()
        bad = self.embeddings.copy()
        bad[0, 0] = np.nan
        cases = [
            (bad, self.tests, self.model_dir, ValueError),
            (np.full((3, 4), 1e6), self.tests, self.model_dir, ValueError),
            (self.embeddings, self.tests[:2], self.model_dir, ValueError),
            (self.embeddings[0], self.tests[:1], self.model_dir, ValueError),
        ]
        for embeddings, tests, model_dir, error in cases:
            with self.assertRaises(error):
                bundle.write(self.path, embeddings, tests, self.spec, model_dir, "c")
        (self.model_dir / "extra.bin").write_bytes(b"x")
        with self.assertRaises(models.SnapshotError):
            bundle.write(
                self.path, self.embeddings, self.tests, self.spec, self.model_dir, "c"
            )
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(
            sorted(p.name for p in self.tmp.iterdir()), ["bundle.tar", "model"]
        )

    def test_refuses_a_model_without_hashes(self) -> None:
        spec = tiny_spec({})
        with self.assertRaises(models.SnapshotError):
            bundle.write(
                self.path, self.embeddings, self.tests, spec, self.model_dir, "c"
            )


class TestReadRejects(BundleTest):
    def replace(self, name: str, data: bytes) -> Callable[[list[Item]], list[Item]]:
        return lambda items: [
            item(i.name, data) if i.name == name else (i, d) for i, d in items
        ]

    def test_wrong_format_version(self) -> None:
        for value in [2, True, "1", None]:
            path = self.rebuild(lambda x: x, lambda m: m.update(format=value))
            self.assert_invalid(path, "unsupported bundle format", verify_too=False)

    def test_truncated_embeddings(self) -> None:
        data = dict((i.name, d) for i, d in self.items())[bundle.EMBEDDINGS]
        path = self.rebuild(self.replace(bundle.EMBEDDINGS, data[:-5]))
        self.assert_invalid(path, "size does not match its header", verify_too=False)

    def test_huge_npy_header(self) -> None:
        data = dict((i.name, d) for i, d in self.items())[bundle.EMBEDDINGS]
        header = data.replace(b"(3, 4)", b"(10000000000000, 4)", 1)
        self.assertNotEqual(header, data)
        path = self.rebuild(self.replace(bundle.EMBEDDINGS, header))
        self.assert_invalid(path, "has shape", verify_too=False)

    def test_float32_or_fortran_embeddings(self) -> None:
        arrays: list[np.ndarray] = [
            self.embeddings,
            np.asfortranarray(self.embeddings.astype(np.float16)),
        ]
        for array in arrays:
            path = self.rebuild(self.replace(bundle.EMBEDDINGS, npy_bytes(array)))
            self.assert_invalid(path, "is not a C-ordered <f2 array", verify_too=False)

    def test_nan_rows(self) -> None:
        array = self.embeddings.astype(np.float16)
        array[1] = np.nan
        path = self.rebuild(self.replace(bundle.EMBEDDINGS, npy_bytes(array)))
        self.assert_invalid(path, "non-finite", verify_too=False)

    def test_tests_json(self) -> None:
        for data, fragment in [
            (b'{"a": 1}', "not a list"),
            (b'["a", 1, "b"]', "not a list"),
            (b'["a"]', "1 names for 3 rows"),
            (b"[[[", "invalid bundle"),
        ]:
            path = self.rebuild(self.replace(bundle.TESTS, data))
            self.assert_invalid(path, fragment, verify_too=False)

    def test_hostile_member_names(self) -> None:
        for name in ["model/../../evil", "/etc/evil", "model/extra.py", "x"]:
            path = self.rebuild(lambda items: items + [item(name, b"x")])
            self.assert_invalid(path, "unexpected member", verify_too=False)

    def test_duplicate_member(self) -> None:
        path = self.rebuild(lambda items: items + [items[2]])
        self.assert_invalid(path, "duplicate member")

    def test_non_regular_members(self) -> None:
        cases = [
            item(
                "model/config.json", b"", type=tarfile.SYMTYPE, linkname="/etc/passwd"
            ),
            item("model/config.json", b"", type=tarfile.LNKTYPE, linkname="tests.json"),
            item("model", b"", type=tarfile.DIRTYPE),
            item("model/config.json", b"", type=tarfile.FIFOTYPE),
            item("model/config.json", b"", type=tarfile.CHRTYPE),
            item(
                "model/config.json", MODEL_FILES["config.json"], type=tarfile.CONTTYPE
            ),
            item(
                "model/config.json",
                MODEL_FILES["config.json"],
                type=tarfile.GNUTYPE_SPARSE,
            ),
            item(
                "model/config.json",
                MODEL_FILES["config.json"],
                pax_headers={"GNU.sparse.map": "0,18", "GNU.sparse.size": "18"},
            ),
            item(
                "model/config.json",
                MODEL_FILES["config.json"],
                pax_headers={"GNU.sparse.major": "1"},
            ),
        ]
        for case in cases:

            def edit(items: list[Item], case: Item = case) -> list[Item]:
                kept = [(i, d) for i, d in items if i.name != "model/config.json"]
                return kept + [case]

            path = self.rebuild(edit, rehash=False)
            self.assert_invalid(path, "not a plain regular file")

    def test_global_pax_headers(self) -> None:
        for headers in [{"size": "100"}, {"comment": "x"}]:
            buffer = io.BytesIO()
            with tarfile.open(
                fileobj=buffer,
                mode="w:",
                format=tarfile.PAX_FORMAT,
                pax_headers=headers,
            ) as tar:
                for info, data in self.items():
                    tar.addfile(info, io.BytesIO(data))
            path = self.tmp / "global.tar"
            path.write_bytes(buffer.getvalue())
            self.assert_invalid(path, "global pax headers")

    def test_gzip_compressed(self) -> None:
        path = self.tmp / "bundle.tar.gz"
        path.write_bytes(gzip.compress(self.path.read_bytes()))
        self.assert_invalid(path, "invalid bundle")

    def test_too_many_members(self) -> None:
        extra = [item(f"model/x{i}", b"") for i in range(bundle.MAX_MEMBERS)]
        path = self.rebuild(lambda items: items + extra)
        self.assert_invalid(path, "unexpected member")
        with self.assertRaises(bundle.BundleError) as ctx:
            bundle.verify(path)
        self.assertIn(f"more than {bundle.MAX_MEMBERS} members", str(ctx.exception))

    def test_tampered_model_file(self) -> None:
        tampered = b'{"hidden_size": 5}'
        path = self.rebuild(self.replace("model/config.json", tampered))
        self.assert_invalid(path, "does not match its sha256", verify_too=False)
        self.assertEqual(bundle.verify(path)["model_key"], "tiny")
        unhashed = self.rebuild(
            self.replace("model/config.json", tampered), rehash=False
        )
        self.assert_invalid(unhashed, "'model/config.json' does not match its sha256")

    def test_model_file_over_its_committed_size(self) -> None:
        path = self.rebuild(self.replace("model/config.json", b"x" * 1000))
        self.assert_invalid(path, "over its size cap", verify_too=False)

    def test_meta_over_cap(self) -> None:
        path = self.rebuild(
            lambda x: x, lambda m: m.update(pad="x" * bundle.MAX_META_BYTES)
        )
        self.assert_invalid(path, "meta.json is over")

    def test_deeply_nested_meta(self) -> None:
        nested = b"[" * 200000 + b"]" * 200000
        path = self.rebuild(
            lambda items: [item(bundle.META, nested)] + items[1:], rehash=False
        )
        self.assert_invalid(path, "invalid bundle")

    def test_missing_member(self) -> None:
        for name in [
            bundle.TESTS,
            bundle.EMBEDDINGS,
            "model/LICENSE",
            "model/config.json",
        ]:
            path = self.rebuild(
                lambda items: [(i, d) for i, d in items if i.name != name]
            )
            self.assert_invalid(
                path, f"'{name}' is missing", verify_too=name in bundle.DATA
            )

    def test_hash_for_an_absent_member(self) -> None:
        path = self.rebuild(
            lambda x: x, lambda m: m["sha256"].update({"model/ghost": "0" * 64})
        )
        self.assert_invalid(path, "'model/ghost' is missing")

    def test_member_without_hash(self) -> None:
        path = self.rebuild(lambda x: x, lambda m: m["sha256"].pop(bundle.TESTS))
        self.assert_invalid(path, "no sha256 for member 'tests.json'")

    def test_meta_not_first(self) -> None:
        path = self.rebuild(lambda items: items[1:] + items[:1], rehash=False)
        self.assert_invalid(path, "not meta.json")

    def test_meta_without_hashes(self) -> None:
        path = self.rebuild(
            lambda items: [item(bundle.META, b"{}")] + items[1:], rehash=False
        )
        self.assert_invalid(path, "no sha256 map")

    def test_invalid_header_mid_archive(self) -> None:
        data = bytearray(self.path.read_bytes())
        offsets = []
        with tarfile.open(self.path, "r:") as tar:
            offsets = [m.offset for m in tar]
        start = offsets[2]
        data[start + 148 : start + 156] = b"0000000\x00"
        path = self.tmp / "corrupt.tar"
        path.write_bytes(bytes(data))
        self.assert_invalid(path, "is missing")

    def test_registry_checks(self) -> None:
        cases: list[tuple[dict[str, Any], str]] = [
            ({"model_key": "unknown"}, "not in the registry"),
            ({"model_key": None}, "not in the registry"),
            ({"query_prompt": "other: "}, "query_prompt differs"),
            ({"max_tokens": 512}, "max_tokens differs"),
            ({"rows": -1}, "not a non-negative integer"),
            ({"dim": 5}, "has shape"),
        ]
        for change, fragment in cases:
            path = self.rebuild(lambda x: x, lambda m: m.update(change))
            self.assert_invalid(path, fragment, verify_too=False)

    def test_model_without_hashes_in_registry(self) -> None:
        with mock.patch.dict(models.MODELS, {"tiny": tiny_spec({})}):
            self.assert_invalid(self.path, "no committed file hashes", verify_too=False)

    def test_extra_file_in_the_extracted_model(self) -> None:
        extra = {**MODEL_FILES, "extra.json": b"{}"}
        model_dir = self.make_model_dir(extra, "extra")
        spec = tiny_spec(extra)
        path = self.tmp / "extra.tar"
        bundle.write(path, self.embeddings, self.tests, spec, model_dir, "c")
        self.assert_invalid(
            path, "unexpected member 'model/extra.json'", verify_too=False
        )

    def test_dest_must_be_empty(self) -> None:
        dest = self.dest()
        dest.mkdir()
        (dest / "stale").write_text("x")
        self.assert_invalid_dest(dest)

    def assert_invalid_dest(self, dest: Path) -> None:
        with self.assertRaises(bundle.BundleError) as ctx:
            bundle.read(self.path, dest)
        self.assertIn("not empty", str(ctx.exception))

    def test_unreadable_paths(self) -> None:
        empty = self.tmp / "empty.tar"
        empty.write_bytes(b"")
        for path in [self.tmp / "missing.tar", empty, self.tmp]:
            self.assert_invalid(path, "bundle")


if __name__ == "__main__":
    main()
