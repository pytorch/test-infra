#!/usr/bin/env python3
"""Nested wheel indexes must not repeat prefix-root wheels for packages
that already published into that directory."""

import unittest

from manage_v2 import S3Index, S3Object


def _wheel(key: str) -> S3Object:
    return S3Object(
        key=key,
        orig_key=key,
        checksum=None,
        size=1,
        pep658=None,
        last_modified=None,
    )


def _index() -> S3Index:
    return S3Index(
        [
            _wheel("whl/torch-0.1-cp27-cp27m-macosx_10_6_x86_64.whl"),
            _wheel("whl/triton-3.9.0-cp312-cp312-manylinux_2_28_x86_64.whl"),
            _wheel(
                "whl/rocm10.0/torch-2.15.0%2Brocm10.0-cp312-cp312-manylinux_2_28_x86_64.whl"
            ),
            _wheel(
                "whl/cu128/torch-2.10.0%2Bcu128-cp312-cp312-manylinux_2_28_x86_64.whl"
            ),
            _wheel(
                "whl/nightly/cu128/torch-2.11.0%2Bcu128-cp312-cp312-manylinux_2_28_x86_64.whl"
            ),
        ],
        "whl",
    )


class GenFileListTest(unittest.TestCase):
    def test_rocm_subdir_drops_legacy_torch_but_keeps_shared_triton(self):
        idx = _index()
        torch = [
            obj.key
            for obj in idx.gen_file_list("whl/rocm10.0", package_name="torch")
        ]
        triton = [
            obj.key
            for obj in idx.gen_file_list("whl/rocm10.0", package_name="triton")
        ]
        self.assertEqual(
            torch,
            [
                "whl/rocm10.0/torch-2.15.0%2Brocm10.0-cp312-cp312-manylinux_2_28_x86_64.whl"
            ],
        )
        self.assertEqual(
            triton,
            ["whl/triton-3.9.0-cp312-cp312-manylinux_2_28_x86_64.whl"],
        )
        self.assertNotIn(
            "whl/cu128/torch-2.10.0%2Bcu128-cp312-cp312-manylinux_2_28_x86_64.whl",
            torch,
        )

    def test_prefix_root_index_still_lists_every_channel(self):
        keys = [obj.key for obj in _index().gen_file_list("whl", package_name="torch")]
        self.assertEqual(
            keys,
            [
                "whl/torch-0.1-cp27-cp27m-macosx_10_6_x86_64.whl",
                "whl/rocm10.0/torch-2.15.0%2Brocm10.0-cp312-cp312-manylinux_2_28_x86_64.whl",
                "whl/cu128/torch-2.10.0%2Bcu128-cp312-cp312-manylinux_2_28_x86_64.whl",
                "whl/nightly/cu128/torch-2.11.0%2Bcu128-cp312-cp312-manylinux_2_28_x86_64.whl",
            ],
        )

    def test_package_names_keep_root_only_packages(self):
        names = _index().get_package_names("whl/rocm10.0")
        self.assertEqual(names, ["torch", "triton"])

    def test_html_omits_legacy_torch_link(self):
        html = _index().to_simple_package_html("whl/rocm10.0", "torch")
        self.assertIn("torch-2.15.0+rocm10.0", html)
        self.assertNotIn("torch-0.1", html)
        self.assertNotIn("cu128", html)


if __name__ == "__main__":
    unittest.main()
