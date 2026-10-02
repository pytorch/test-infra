"""Unit tests for the pure logic in tools/scripts/hf_cache_sync.

Run from the repo root with either:
    python3 -m unittest discover -vs tools/tests -p 'test_*.py'
    pytest tools/tests/test_hf_cache_sync.py

boto3 is deliberately not a test dependency: hf_cache_sync imports it lazily,
so everything below runs with fake S3 clients.
"""

import io
import os
import sys
import tempfile
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from unittest import main, mock, TestCase

import tools.scripts.hf_cache_sync as m


class FakeS3:
    """The slice of the boto3 S3 client hf_cache_sync actually uses."""

    def __init__(
        self,
        objects: Optional[Dict[str, int]] = None,
        etags: Optional[Dict[str, str]] = None,
        mtimes: Optional[Dict[str, float]] = None,
        bodies: Optional[Dict[str, bytes]] = None,
    ) -> None:
        # key -> size
        self.objects: Dict[str, int] = dict(objects or {})
        # Optional per-key ETag, LastModified (epoch) and body; the listing
        # falls back to a size-derived ETag and the epoch.
        self.etags: Dict[str, str] = dict(etags or {})
        self.mtimes: Dict[str, float] = dict(mtimes or {})
        self.bodies: Dict[str, bytes] = dict(bodies or {})
        self.copied: List[str] = []
        self.uploaded: List[str] = []
        self.got: List[str] = []

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
        return [
            {
                "Contents": [
                    {
                        "Key": k,
                        "Size": self.objects[k],
                        "ETag": self.etags.get(k, f'"{self.objects[k]}"'),
                        "LastModified": datetime.fromtimestamp(
                            self.mtimes.get(k, 0.0), tz=timezone.utc
                        ),
                    }
                    for k in keys
                ]
            }
        ]

    def get_object(self, Bucket: str, Key: str) -> Dict[str, Any]:
        self.got.append(Key)
        return {"Body": io.BytesIO(self.bodies[Key])}

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


REF = "hub/models--a--b/refs/main"
BLOB = "hub/models--a--b/blobs/deadbeef"


def entries(objects: Dict[str, Any]) -> Dict[str, "m.Entry"]:
    """key -> Entry from key -> size, or key -> (size, etag, modified)."""
    out = {}
    for k, v in objects.items():
        size, etag, modified = v if isinstance(v, tuple) else (v, f'"{v}"', 0.0)
        out[k] = m.Entry(size, etag, modified)
    return out


def never_called(key: str, have: Dict[str, Any]) -> str:
    raise AssertionError(f"pick_ref called for {key}")


class TestPlanSync(TestCase):
    def test_identical_clusters_plan_nothing(self) -> None:
        same = {REF: (40, '"abc"', 1.0), BLOB: 7, "datasets/x/y.arrow": 3}
        listings = {"a": entries(same), "b": entries(same), "c": entries(same)}
        self.assertEqual(m.plan_sync(listings, never_called), [])

    def test_missing_key_is_copied_to_every_cluster_lacking_it(self) -> None:
        listings = {"a": entries({BLOB: 7}), "b": entries({}), "c": entries({})}
        self.assertEqual(
            m.plan_sync(listings, never_called),
            [m.Copy(BLOB, "a", "b", 7), m.Copy(BLOB, "a", "c", 7)],
        )

    def test_union_runs_in_every_direction(self) -> None:
        listings = {
            "a": entries({BLOB: 7}),
            "b": entries({"datasets/x/y.arrow": 3}),
        }
        self.assertEqual(
            sorted(m.plan_sync(listings, never_called)),
            sorted(
                [
                    m.Copy(BLOB, "a", "b", 7),
                    m.Copy("datasets/x/y.arrow", "b", "a", 3),
                ]
            ),
        )

    def test_refs_compare_by_etag_not_size(self) -> None:
        """Every ref is 40 bytes, so size alone would call two commits equal."""
        listings = {
            "a": entries({REF: (40, '"old"', 1.0)}),
            "b": entries({REF: (40, '"new"', 2.0)}),
        }
        asked = []

        def pick(key: str, have: Dict[str, Any]) -> str:
            asked.append((key, sorted(have)))
            return "a"

        self.assertEqual(m.plan_sync(listings, pick), [m.Copy(REF, "a", "b", 40)])
        self.assertEqual(asked, [(REF, ["a", "b"])])

    def test_agreeing_ref_missing_somewhere_skips_pick_ref(self) -> None:
        listings = {
            "a": entries({REF: (40, '"x"', 1.0)}),
            "b": entries({REF: (40, '"x"', 2.0)}),
            "c": entries({}),
        }
        self.assertEqual(
            m.plan_sync(listings, never_called), [m.Copy(REF, "a", "c", 40)]
        )

    def test_differing_non_ref_takes_the_newest(self) -> None:
        listings = {
            "a": entries({"datasets/x/lock": (0, '"e"', 5.0)}),
            "b": entries({"datasets/x/lock": (9, '"f"', 1.0)}),
        }
        self.assertEqual(
            m.plan_sync(listings, never_called),
            [m.Copy("datasets/x/lock", "a", "b", 0)],
        )

    def test_same_size_blob_with_other_etag_is_equal(self) -> None:
        """A multipart copy changes the ETag of identical content."""
        listings = {
            "a": entries({BLOB: (7, '"md5"', 1.0)}),
            "b": entries({BLOB: (7, '"md5-2"', 2.0)}),
        }
        self.assertEqual(m.plan_sync(listings, never_called), [])

    def test_strays_outside_the_cache_layout_are_ignored(self) -> None:
        listings = {
            "a": entries({"hub/blobs/deadbeef": 1, "hub/.locks/x/y.lock": 0}),
            "b": entries({}),
        }
        self.assertEqual(m.plan_sync(listings, never_called), [])


class TestPickRef(TestCase):
    def test_keeps_the_copy_matching_huggingface_even_if_older(self) -> None:
        old = FakeS3({REF: 40}, bodies={REF: b"a" * 40})
        new = FakeS3({REF: 40}, bodies={REF: b"b" * 40})
        have = {
            "old": m.Entry(40, '"o"', 1.0),
            "new": m.Entry(40, '"n"', 2.0),
        }
        with fake_clients({"old": old, "new": new}), mock.patch.object(
            m, "hf_revision", return_value="a" * 40
        ) as rev:
            self.assertEqual(m.pick_ref(REF, have), "old")
        rev.assert_called_once_with("models--a--b", "main")

    def test_newest_wins_when_huggingface_cannot_say(self) -> None:
        have = {"x": m.Entry(40, '"o"', 1.0), "y": m.Entry(40, '"n"', 2.0)}
        with fake_clients({}), mock.patch.object(m, "hf_revision", return_value=None):
            self.assertEqual(m.pick_ref(REF, have), "y")

    def test_newest_wins_when_nobody_matches_huggingface(self) -> None:
        x = FakeS3({REF: 40}, bodies={REF: b"a" * 40})
        y = FakeS3({REF: 40}, bodies={REF: b"b" * 40})
        have = {"x": m.Entry(40, '"o"', 1.0), "y": m.Entry(40, '"n"', 2.0)}
        with fake_clients({"x": x, "y": y}), mock.patch.object(
            m, "hf_revision", return_value="c" * 40
        ):
            self.assertEqual(m.pick_ref(REF, have), "y")

    def test_branch_names_with_slashes_survive(self) -> None:
        key = "hub/models--a--b/refs/pr/1"
        with mock.patch.object(m, "hf_revision", return_value=None) as rev:
            m.pick_ref(key, {"x": m.Entry(40, '"o"', 1.0)})
        rev.assert_called_once_with("models--a--b", "pr/1")


class TestHfRevision(TestCase):
    def fetch(self, repo_dir: str, ref: str) -> str:
        seen = []

        class Resp(io.BytesIO):
            def __enter__(self) -> "Resp":
                return self

            def __exit__(self, *_: Any) -> None:
                pass

        def urlopen(req: Any, timeout: float) -> Resp:
            seen.append(req.full_url)
            return Resp(b'{"sha": "cafe"}')

        with mock.patch.object(m.urllib.request, "urlopen", urlopen):
            self.assertEqual(m.hf_revision(repo_dir, ref), "cafe")
        return seen[0]

    def test_urls(self) -> None:
        base = "https://huggingface.co/api/"
        self.assertEqual(
            self.fetch("models--Qwen--Qwen3-0.6B", "main"),
            base + "models/Qwen/Qwen3-0.6B/revision/main",
        )
        self.assertEqual(
            self.fetch("models--gpt2", "main"), base + "models/gpt2/revision/main"
        )
        self.assertEqual(
            self.fetch("datasets--org--name", "pr/1"),
            base + "datasets/org/name/revision/pr%2F1",
        )

    def test_errors_mean_no_answer(self) -> None:
        with mock.patch.object(
            m.urllib.request, "urlopen", side_effect=OSError("offline")
        ):
            self.assertIsNone(m.hf_revision("models--a--b", "main"))


class TestRunSync(TestCase):
    def test_in_sync_run_is_listings_only(self) -> None:
        objs = {REF: 40, BLOB: 7}
        a, b = FakeS3(objs, bodies={REF: b"x"}), FakeS3(objs, bodies={REF: b"x"})
        with fake_clients({"a": a, "b": b}), mock.patch.object(
            m, "hf_revision", side_effect=AssertionError("no HF call")
        ):
            self.assertEqual(m.run_sync(["a", "b"], apply=True), 0)
        self.assertEqual((a.copied, b.copied, a.got, b.got), ([], [], [], []))

    def test_dry_run_copies_nothing(self) -> None:
        a, b = FakeS3({BLOB: 7}), FakeS3({})
        with fake_clients({"a": a, "b": b}):
            self.assertEqual(m.run_sync(["a", "b"], apply=False), 0)
        self.assertEqual(b.copied, [])

    def test_content_lands_before_refs(self) -> None:
        """A ref copied first points jobs at a snapshot the cluster lacks."""
        snap = "hub/models--a--b/snapshots/c0ffee/config.json"
        a, b = FakeS3({REF: 40, BLOB: 7, snap: 7}), FakeS3({})
        order = []
        with fake_clients({"a": a, "b": b}), mock.patch.object(
            m, "copy_object", lambda s, d, k: order.append(k)
        ):
            self.assertEqual(m.run_sync(["a", "b"], apply=True), 0)
        self.assertEqual(sorted(order[:2]), sorted([BLOB, snap]))
        self.assertEqual(order[2:], [REF])

    def test_failed_copies_are_counted_not_raised(self) -> None:
        a, b = FakeS3({BLOB: 7, "datasets/x": 1}), FakeS3({})

        def flaky(_s: str, _d: str, key: str) -> None:
            if key == BLOB:
                raise RuntimeError("boom")

        with fake_clients({"a": a, "b": b}), mock.patch.object(m, "copy_object", flaky):
            self.assertEqual(m.run_sync(["a", "b"], apply=True), 1)


class TestSyncArgs(TestCase):
    def run_main(self, *args: str) -> None:
        with mock.patch.object(sys, "argv", ["hf_cache_sync.py", *args]):
            m.main()

    def test_rejects_source(self) -> None:
        with self.assertRaises(SystemExit):
            self.run_main("--sync", "--source", "meta-prod-aws-ue1")

    def test_needs_two_clusters(self) -> None:
        with self.assertRaises(SystemExit):
            self.run_main(
                "--sync", "--to", "meta-prod-aws-ue1", "--to", "meta-prod-aws-ue1"
            )

    def test_defaults_to_prod_and_exits_nonzero_on_failure(self) -> None:
        with mock.patch.object(m, "run_sync", return_value=2) as run:
            with self.assertRaises(SystemExit) as cm:
                self.run_main("--sync", "--apply")
        run.assert_called_once_with(m.PROD, True)
        self.assertEqual(cm.exception.code, 1)


if __name__ == "__main__":
    main()
