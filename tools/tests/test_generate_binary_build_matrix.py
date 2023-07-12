import os
import json

from unittest import TestCase, main

from tools.scripts.generate_binary_build_matrix import generate_build_matrix

ASSETS_DIR = "tools/tests/assets"

class GenerateBuildMatrixTest(TestCase):
    def matrix_compare_helper(
            self,
            package_type,
            operating_system,
            cuda,
            reference_output_file):
        out = generate_build_matrix(
                package_type,
                operating_system,
                "nightly",
                "enable" if cuda else "disable",
                "false",
        )

        expected_json_filename = os.path.join(
            ASSETS_DIR, reference_output_file)

        with open(expected_json_filename) as f:
            expected = json.load(f)

        self.maxDiff = None
        self.assertEqual(out, expected)

    def test_linux_wheel_cuda(self):
        self.matrix_compare_helper(
            package_type="wheel",
            operating_system="linux",
            cuda=True,
            reference_output_file="build_matrix_linux_wheel_cuda.json")

    def test_linux_conda_cuda(self):
        self.matrix_compare_helper(
            package_type="conda",
            operating_system="linux",
            cuda=True,
            reference_output_file="build_matrix_linux_conda_cuda.json")

    def test_macos_wheel(self):
        self.matrix_compare_helper(
            package_type="wheel",
            operating_system="macos",
            cuda=False,
            reference_output_file="build_matrix_macos_wheel.json")

    def test_macos_conda(self):
        self.matrix_compare_helper(
            package_type="conda",
            operating_system="macos",
            cuda=False,
            reference_output_file="build_matrix_macos_conda.json")

    def test_windows_wheel_cuda(self):
        self.matrix_compare_helper(
            package_type="wheel",
            operating_system="windows",
            cuda=True,
            reference_output_file="build_matrix_windows_wheel_cuda.json")

    def test_windows_conda_cuda(self):
        self.matrix_compare_helper(
            package_type="conda",
            operating_system="windows",
            cuda=True,
            reference_output_file="build_matrix_windows_conda_cuda.json")
