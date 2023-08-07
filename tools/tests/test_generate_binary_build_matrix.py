import os
import json

from unittest import TestCase, main

from tools.scripts.generate_binary_build_matrix import generate_build_matrix

ASSETS_DIR = "tools/tests/assets"


class GenerateBuildMatrixTest(TestCase):
    def matrix_compare_helper(
        self,
        package_type: str,
        operating_system: str,
        cuda: bool,
        rocm: bool,
        cpu: bool,
        reference_output_file: str,
    ) -> None:
        out = generate_build_matrix(
            package_type,
            operating_system,
            "nightly",
            "enable" if cuda else "disable",
            "enable" if rocm else "disable",
            "enable" if cpu else "disable",
            "false",
        )

        expected_json_filename = os.path.join(ASSETS_DIR, reference_output_file)

        with open(expected_json_filename) as f:
            expected = json.load(f)

        self.maxDiff = None
        self.assertEqual(out, expected)

    def test_linux_wheel_cuda(self):
        self.matrix_compare_helper(
            package_type="wheel",
            operating_system="linux",
            cuda=True,
            rocm=True,
            cpu=True,
            reference_output_file="build_matrix_linux_wheel_cuda.json",
        )

    def test_linux_conda_cuda(self):
        self.matrix_compare_helper(
            package_type="conda",
            operating_system="linux",
            cuda=True,
            rocm=True,
            cpu=True,
            reference_output_file="build_matrix_linux_conda_cuda.json",
        )

    def test_macos_wheel(self):
        self.matrix_compare_helper(
            package_type="wheel",
            operating_system="macos",
            cuda=False,
            rocm=False,
            cpu=True,
            reference_output_file="build_matrix_macos_wheel.json",
        )

    def test_macos_conda(self):
        self.matrix_compare_helper(
            package_type="conda",
            operating_system="macos",
            cuda=False,
            rocm=False,
            cpu=True,
            reference_output_file="build_matrix_macos_conda.json",
        )

    def test_windows_wheel_cuda(self):
        self.matrix_compare_helper(
            package_type="wheel",
            operating_system="windows",
            cuda=True,
            rocm=True,
            cpu=True,
            reference_output_file="build_matrix_windows_wheel_cuda.json",
        )

    def test_windows_conda_cuda(self):
        self.matrix_compare_helper(
            package_type="conda",
            operating_system="windows",
            cuda=True,
            rocm=True,
            cpu=True,
            reference_output_file="build_matrix_windows_conda_cuda.json",
        )

    def test_linux_wheel_cuda_norocm(self):
        self.matrix_compare_helper(
            package_type="wheel",
            operating_system="linux",
            cuda=True,
            rocm=False,
            cpu=True,
            reference_output_file="build_matrix_linux_wheel_cuda_norocm.json",
        )

    def test_linux_wheel_cuda_rocm_nocpu(self):
        self.matrix_compare_helper(
            package_type="wheel",
            operating_system="linux",
            cuda=True,
            rocm=True,
            cpu=False,
            reference_output_file="build_matrix_linux_wheel_nocpu.json",
        )


if __name__ == "__main__":
    main()
