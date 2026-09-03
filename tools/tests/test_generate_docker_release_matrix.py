"""Tests for the docker release matrix.

The build side of this matrix lives in pytorch/pytorch
(.github/scripts/generate_docker_release_matrix.py) and the validate side here.
They are independent copies, so they drift: a CUDA version this repo emits a
`devel` entry for, but pytorch/pytorch does not build, fails the nightly
"Build Official Docker Images" workflow with `manifest unknown`. These tests pin
the part of the contract that drifted.
"""

import unittest

import generate_binary_build_matrix
from generate_docker_release_matrix import generate_docker_matrix


class TestDockerReleaseMatrix(unittest.TestCase):
    def _entries(self, channel="nightly"):
        return generate_docker_matrix(channel, "false")["include"]

    def test_runtime_image_only_arches_get_no_devel_entry(self):
        for channel in ("nightly", "test", "release"):
            entries = self._entries(channel)
            for cuda in generate_binary_build_matrix.CUDA_ARCHES_RUNTIME_IMAGE_ONLY:
                devel = [
                    e
                    for e in entries
                    if e["cuda"] == cuda and e["image_type"] == "devel"
                ]
                self.assertEqual(
                    devel,
                    [],
                    f"{channel}: CUDA {cuda} is runtime-image-only, so no devel "
                    "entry may be emitted -- pytorch/pytorch does not build it",
                )

    def test_runtime_image_only_arches_still_get_runtime(self):
        # The point of runtime-image-only is that the runtime image still ships.
        entries = self._entries("nightly")
        for cuda in generate_binary_build_matrix.CUDA_ARCHES_RUNTIME_IMAGE_ONLY:
            if cuda not in generate_binary_build_matrix.CUDA_ARCHES_DICT["nightly"]:
                continue
            runtime = [
                e for e in entries if e["cuda"] == cuda and e["image_type"] == "runtime"
            ]
            self.assertEqual(len(runtime), 1, f"CUDA {cuda} lost its runtime entry")

    def test_other_arches_get_both_image_types(self):
        entries = self._entries("nightly")
        for cuda in generate_binary_build_matrix.CUDA_ARCHES_DICT["nightly"]:
            if cuda in generate_binary_build_matrix.CUDA_ARCHES_RUNTIME_IMAGE_ONLY:
                continue
            types = sorted(e["image_type"] for e in entries if e["cuda"] == cuda)
            self.assertEqual(
                types, ["devel", "runtime"], f"CUDA {cuda} should emit both"
            )

    def test_cpu_arm64_runtime_entry_is_unchanged(self):
        entries = self._entries("nightly")
        cpu = [e for e in entries if e["cuda"] == "cpu"]
        self.assertEqual(len(cpu), 1)
        self.assertEqual(cpu[0]["image_type"], "runtime")
        self.assertEqual(cpu[0]["platform"], "linux/arm64")


if __name__ == "__main__":
    unittest.main()
