"""Unit tests for the pure logic in tools/scripts/hf_cache_sync.

Run from the repo root with either:
    python3 -m unittest discover -vs tools/tests -p 'test_*.py'
    pytest tools/tests/test_hf_cache_sync.py

boto3 is deliberately not a test dependency: hf_cache_sync imports it lazily,
so everything below runs with fake S3 clients.
"""

import os
import sys
import tempfile
from typing import Any, Dict, List, Optional
from unittest import main, mock, TestCase

import tools.scripts.hf_cache_sync as m


class FakeS3:
    """The slice of the boto3 S3 client hf_cache_sync actually uses."""

    def __init__(self, objects: Optional[Dict[str, int]] = None) -> None:
        # key -> size
        self.objects: Dict[str, int] = dict(objects or {})
        self.copied: List[str] = []
        self.uploaded: List[str] = []

    def get_paginator(self, _name: str) -> "FakeS3":
        return self

    def paginate(self, **kwargs: Any) -> List[Dict[str, Any]]:
        prefix = kwargs.get("Prefix", "")
        keys = sorted(k for k in self.objects if k.startswith(prefix))
        if kwargs.get("Delimiter") == "/":
            depth = prefix.count("/") + 1
            common = sorted(
                {"/".join(k.split("/")[:depth]) + "/" for k in keys if "/" in k}
            )
            return [{"CommonPrefixes": [{"Prefix": p} for p in common]}]
        return [{"Contents": [{"Key": k, "Size": self.objects[k]} for k in keys]}]

    def copy(self, _source: Dict[str, str], _bucket: str, key: str, **_kw: Any) -> None:
        self.copied.append(key)
        # Size is a placeholder: copy_repo never re-lists the destination
        # after copying, so only the key's presence matters here.
        self.objects[key] = 1

    def upload_file(self, _path: str, _bucket: str, key: str) -> None:
        self.uploaded.append(key)


def fake_clients(mapping: Dict[str, FakeS3]):
    """Patch hf_cache_sync.client so each cluster resolves to its FakeS3."""
    return mock.patch.object(m, "client", lambda cluster: mapping[cluster])


class TestCacheDir(TestCase):
    def test_model_repo(self) -> None:
        self.assertEqual(m.cache_dir("Qwen/Qwen3-0.6B"), "models--Qwen--Qwen3-0.6B")

    def test_dataset_repo_plural_and_singular(self) -> None:
        for spec in ("datasets/kalomaze/alpha", "dataset/kalomaze/alpha"):
            self.assertEqual(m.cache_dir(spec), "datasets--kalomaze--alpha")

    def test_already_encoded_passes_through(self) -> None:
        for name in ("models--a--b", "datasets--a--b", "spaces--a--b"):
            self.assertEqual(m.cache_dir(name), name)

    def test_trailing_slash_is_stripped(self) -> None:
        self.assertEqual(m.cache_dir("models--a--b/"), "models--a--b")

    def test_leading_and_trailing_slashes_tolerated(self) -> None:
        self.assertEqual(m.cache_dir("/Qwen/Qwen3-0.6B/"), "models--Qwen--Qwen3-0.6B")

    def test_bare_name_is_a_legacy_un_namespaced_repo(self) -> None:
        # gpt2, t5-base and albert-base-v2 really are repo ids, and torchbench
        # asks for them in that form.
        for spec in ("gpt2", "t5-base", "albert-base-v2"):
            self.assertEqual(m.cache_dir(spec), f"models--{spec}")

    def test_bare_name_is_not_the_namespaced_repo(self) -> None:
        # A cache holding one still misses a job that asks for the other, which
        # is the whole reason the bare form has to be addressable.
        self.assertNotEqual(m.cache_dir("gpt2"), m.cache_dir("openai-community/gpt2"))

    def test_rejects_bare_dataset_name(self) -> None:
        # No namespace to copy from, so this is a typo rather than a legacy id.
        with self.assertRaises(ValueError):
            m.cache_dir("datasets/alpha")

    def test_rejects_empty(self) -> None:
        for spec in ("", "/"):
            with self.assertRaises(ValueError):
                m.cache_dir(spec)

    def test_rejects_too_many_segments(self) -> None:
        with self.assertRaises(ValueError):
            m.cache_dir("a/b/c")


class TestClusterTable(TestCase):
    def test_bucket_name_derives_from_cluster(self) -> None:
        self.assertEqual(
            m.bucket_of("meta-prod-aws-uw2"),
            "pytorch-hf-model-cache-meta-prod-aws-uw2",
        )

    def test_prod_is_the_meta_prod_subset(self) -> None:
        self.assertEqual(m.PROD, [c for c in m.CLUSTERS if c.startswith("meta-prod-")])
        self.assertTrue(m.PROD)

    def test_every_cluster_has_a_plausible_region(self) -> None:
        for cluster, region in m.CLUSTERS.items():
            self.assertRegex(region, r"^[a-z]{2}-[a-z]+-\d$", cluster)


class TestListRepos(TestCase):
    def test_only_repo_prefixes_are_returned(self) -> None:
        s3 = FakeS3(
            {
                "hub/models--a--b/refs/main": 1,
                "hub/datasets--c--d/refs/main": 1,
                "hub/blobs/deadbeef": 1,
                "hub/.locks/whatever": 1,
            }
        )
        with fake_clients({"meta-prod-aws-ue1": s3}):
            self.assertEqual(
                m.list_repos("meta-prod-aws-ue1"),
                {"models--a--b", "datasets--c--d"},
            )


class TestCopyRepo(TestCase):
    def test_dry_run_reports_but_does_not_copy(self) -> None:
        src = FakeS3({"hub/models--a--b/f": 10})
        dst = FakeS3({})
        with fake_clients({"src": src, "dst": dst}):
            n, size = m.copy_repo("src", "dst", "models--a--b", apply=False)
        self.assertEqual((n, size), (1, 10))
        self.assertEqual(dst.copied, [])

    def test_apply_copies_missing_objects(self) -> None:
        src = FakeS3({"hub/models--a--b/f": 10, "hub/models--a--b/g": 20})
        dst = FakeS3({})
        with fake_clients({"src": src, "dst": dst}):
            n, size = m.copy_repo("src", "dst", "models--a--b", apply=True)
        self.assertEqual((n, size), (2, 30))
        self.assertEqual(
            sorted(dst.copied), ["hub/models--a--b/f", "hub/models--a--b/g"]
        )

    def test_same_size_objects_are_skipped(self) -> None:
        objs = {"hub/models--a--b/f": 10}
        src, dst = FakeS3(objs), FakeS3(dict(objs))
        with fake_clients({"src": src, "dst": dst}):
            n, size = m.copy_repo("src", "dst", "models--a--b", apply=True)
        self.assertEqual((n, size), (0, 0))
        self.assertEqual(dst.copied, [])

    def test_differing_size_is_recopied(self) -> None:
        src = FakeS3({"hub/models--a--b/f": 10})
        dst = FakeS3({"hub/models--a--b/f": 9})
        with fake_clients({"src": src, "dst": dst}):
            n, _ = m.copy_repo("src", "dst", "models--a--b", apply=True)
        self.assertEqual(n, 1)
        self.assertEqual(dst.copied, ["hub/models--a--b/f"])

    def test_missing_in_source_is_a_no_op(self) -> None:
        with fake_clients({"src": FakeS3({}), "dst": FakeS3({})}):
            self.assertEqual(
                m.copy_repo("src", "dst", "models--a--b", apply=True), (0, 0)
            )

    def test_prefix_is_scoped_to_the_repo(self) -> None:
        """A repo whose name prefixes another must not drag it along."""
        src = FakeS3(
            {"hub/models--a--b/f": 1, "hub/models--a--b-extra/f": 1},
        )
        dst = FakeS3({})
        with fake_clients({"src": src, "dst": dst}):
            n, _ = m.copy_repo("src", "dst", "models--a--b", apply=True)
        self.assertEqual(n, 1)
        self.assertEqual(dst.copied, ["hub/models--a--b/f"])


class TestCopyDatasets(TestCase):
    def test_copies_the_top_level_datasets_prefix(self) -> None:
        src = FakeS3({"datasets/json/default-abc/0.0.0/cache-1.arrow": 5})
        dst = FakeS3({})
        with fake_clients({"src": src, "dst": dst}):
            n, size = m.copy_datasets("src", "dst", apply=True)
        self.assertEqual((n, size), (1, 5))
        self.assertEqual(dst.copied, ["datasets/json/default-abc/0.0.0/cache-1.arrow"])

    def test_does_not_pick_up_hub_dataset_repos(self) -> None:
        """hub/datasets--x--y is a repo; datasets/ is the arrow cache. Distinct."""
        src = FakeS3(
            {
                "datasets/json/a.arrow": 1,
                "hub/datasets--x--y/refs/main": 1,
            }
        )
        dst = FakeS3({})
        with fake_clients({"src": src, "dst": dst}):
            m.copy_datasets("src", "dst", apply=True)
        self.assertEqual(dst.copied, ["datasets/json/a.arrow"])


class TestMirrorCoversBothPrefixes(TestCase):
    """A mirror that only walks hub/ leaves a new region missing its arrow cache.

    list_repos() is hub-only by construction, so the datasets/ prefix has to be
    carried separately or it is silently dropped.
    """

    def _run_mirror(self, src: FakeS3, dst: FakeS3) -> None:
        """Drive main() end to end, so the wiring is covered and not just the helpers."""
        argv = [
            "hf_cache_sync.py",
            "--mirror",
            "--source",
            "meta-prod-aws-ue1",
            "--to",
            "meta-prod-aws-uw2",
            "--apply",
        ]
        clients = {"meta-prod-aws-ue1": src, "meta-prod-aws-uw2": dst}
        with mock.patch.object(sys, "argv", argv), fake_clients(clients):
            m.main()

    def test_repos_and_datasets_are_both_copied(self) -> None:
        src = FakeS3({"hub/models--a--b/f": 1, "datasets/json/a.arrow": 1})
        dst = FakeS3({})
        self._run_mirror(src, dst)
        self.assertEqual(
            sorted(dst.copied),
            ["datasets/json/a.arrow", "hub/models--a--b/f"],
        )

    def test_list_repos_alone_would_miss_the_datasets_cache(self) -> None:
        """The gap this guards: list_repos is hub-only by construction."""
        src = FakeS3({"hub/models--a--b/f": 1, "datasets/json/a.arrow": 1})
        with fake_clients({"src": src}):
            self.assertEqual(m.list_repos("src"), {"models--a--b"})

    def test_datasets_only_source_still_mirrors(self) -> None:
        src = FakeS3({"datasets/json/a.arrow": 1})
        dst = FakeS3({})
        self._run_mirror(src, dst)
        self.assertEqual(dst.copied, ["datasets/json/a.arrow"])


class TestInterruptedMirrorResumes(TestCase):
    """A mirror that died halfway has to finish on the next run.

    pool.map re-raises the first worker failure, so one throttled object aborts
    the whole mirror. Seeding a region is exactly when that matters: the repos
    already written look present, and if presence is what decides, the re-run
    reports "copied 0 objects" over a half-copied region that was just declared
    at parity.
    """

    def _mirror(self, src: FakeS3, dst: FakeS3) -> None:
        argv = [
            "hf_cache_sync.py",
            "--mirror",
            "--source",
            "meta-prod-aws-ue1",
            "--to",
            "meta-prod-aws-uw2",
            "--apply",
        ]
        clients = {"meta-prod-aws-ue1": src, "meta-prod-aws-uw2": dst}
        with mock.patch.object(sys, "argv", argv), fake_clients(clients):
            m.main()

    def test_half_copied_repo_is_finished_not_skipped(self) -> None:
        src = FakeS3(
            {
                "hub/models--a--b/one": 10,
                "hub/models--a--b/two": 20,
                "hub/models--a--b/three": 30,
            }
        )
        # What an interrupted run leaves: the repo exists, incompletely.
        dst = FakeS3({"hub/models--a--b/one": 10})
        self._mirror(src, dst)
        self.assertEqual(
            sorted(dst.copied),
            ["hub/models--a--b/three", "hub/models--a--b/two"],
            "the two missing objects must be copied, not skipped as present",
        )

    def test_complete_repo_still_copies_nothing(self) -> None:
        """Dropping the presence filter must not make a no-op mirror re-copy."""
        objects = {"hub/models--a--b/one": 10, "hub/models--a--b/two": 20}
        src, dst = FakeS3(dict(objects)), FakeS3(dict(objects))
        self._mirror(src, dst)
        self.assertEqual(dst.copied, [])


class TestStaleRefIsRefreshed(TestCase):
    """refs/<name> is a 40-byte sha, so size cannot say whether it is current."""

    def test_same_size_ref_is_still_copied(self) -> None:
        sha = 40
        src = FakeS3({"hub/models--a--b/refs/main": sha})
        dst = FakeS3({"hub/models--a--b/refs/main": sha})
        with fake_clients({"s": src, "d": dst}):
            n, _ = m.copy_prefix("s", "d", "hub/models--a--b/", "r", apply=True)
        self.assertEqual(n, 1, "a ref must be re-copied even at identical size")
        self.assertEqual(dst.copied, ["hub/models--a--b/refs/main"])

    def test_same_size_blob_is_still_skipped(self) -> None:
        """Only refs are exempt; content-addressed blobs keep the size skip."""
        src = FakeS3({"hub/models--a--b/blobs/deadbeef": 40})
        dst = FakeS3({"hub/models--a--b/blobs/deadbeef": 40})
        with fake_clients({"s": src, "d": dst}):
            n, _ = m.copy_prefix("s", "d", "hub/models--a--b/", "r", apply=True)
        self.assertEqual(n, 0)
        self.assertEqual(dst.copied, [])


class TestReviewFixes(TestCase):
    """Regressions for the findings on #8905."""

    def test_client_is_built_once_per_cluster(self) -> None:
        """Unmemoized, the copy worker built one boto3 client per object."""
        built = []

        class FakeBoto3:
            @staticmethod
            def client(_svc, region_name=None):
                built.append(region_name)
                return FakeS3()

        m.client.cache_clear()
        with mock.patch.dict(sys.modules, {"boto3": FakeBoto3}):
            a = m.client("meta-prod-aws-ue1")
            b = m.client("meta-prod-aws-ue1")
            c = m.client("meta-prod-aws-ue2")
        m.client.cache_clear()
        self.assertIs(a, b, "same cluster must reuse one client")
        self.assertIsNot(a, c)
        self.assertEqual(built, ["us-east-1", "us-east-2"])

    def test_precomputed_source_listing_skips_the_source_list(self) -> None:
        src = FakeS3({"hub/models--a--b/f": 7})
        dst = FakeS3({})
        listed = []
        orig = m.list_objects

        def spy(cluster, prefix):
            listed.append(cluster)
            return orig(cluster, prefix)

        with fake_clients({"src": src, "dst": dst}), mock.patch.object(
            m, "list_objects", spy
        ):
            n, size = m.copy_prefix(
                "src",
                "dst",
                "hub/models--a--b/",
                "a--b",
                True,
                src_objects={"hub/models--a--b/f": 7},
            )
        self.assertEqual((n, size), (1, 7))
        self.assertNotIn("src", listed, "source must not be re-listed")

    def test_upload_tree_skips_objects_already_present(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            local = os.path.join(tmp, "models--a--b")
            os.makedirs(os.path.join(local, "blobs"))
            f = os.path.join(local, "blobs", "x")
            with open(f, "w") as fh:
                fh.write("hello")  # 5 bytes
            dst = FakeS3({"hub/models--a--b/blobs/x": 5})
            with fake_clients({"dst": dst}):
                n, size = m.upload_tree(local, "dst", "models--a--b", apply=True)
            self.assertEqual((n, size), (0, 0))
            self.assertEqual(dst.uploaded, [])

            dst2 = FakeS3({"hub/models--a--b/blobs/x": 4})  # wrong size
            with fake_clients({"dst": dst2}):
                n2, _ = m.upload_tree(local, "dst", "models--a--b", apply=True)
            self.assertEqual(n2, 1)

    def test_repo_and_mirror_are_rejected(self) -> None:
        """Without the guard main() silently mirrors the whole cache instead."""
        argv = [
            "hf_cache_sync.py",
            "--mirror",
            "--source",
            "meta-prod-aws-ue1",
            "--repo",
            "Qwen/Qwen3-0.6B",
            "--apply",
        ]
        # Fakes so that, if the guard is ever removed, this fails cleanly on the
        # missing SystemExit rather than hanging on a real AWS call.
        src = FakeS3({"hub/models--x--y/f": 1})
        mapping = {
            c: (src if c == "meta-prod-aws-ue1" else FakeS3()) for c in m.CLUSTERS
        }
        with mock.patch.object(sys, "argv", argv), fake_clients(mapping):
            with self.assertRaises(SystemExit):
                m.main()

    def test_pick_source_candidates_are_not_narrowed_away(self) -> None:
        """With --to omitted every prod cluster is a target; a source must still exist."""
        holder = FakeS3({"hub/models--a--b/f": 1})
        empty = FakeS3({})
        mapping = dict.fromkeys(m.PROD, empty)
        mapping[m.PROD[0]] = holder
        with fake_clients(mapping):
            self.assertEqual(m.pick_source("models--a--b", m.PROD), m.PROD[0])


class TestPickSource(TestCase):
    def test_returns_first_cluster_holding_the_repo(self) -> None:
        a = FakeS3({})
        b = FakeS3({"hub/models--a--b/f": 1})
        with fake_clients({"a": a, "b": b}):
            self.assertEqual(m.pick_source("models--a--b", ["a", "b"]), "b")

    def test_returns_none_when_nobody_has_it(self) -> None:
        with fake_clients({"a": FakeS3({}), "b": FakeS3({})}):
            self.assertIsNone(m.pick_source("models--a--b", ["a", "b"]))


if __name__ == "__main__":
    main()
