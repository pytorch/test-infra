import pytest  # type: ignore[import-not-found]
from pytorch_pkg_helpers.macos import get_macos_variables


@pytest.mark.parametrize(
    "arch_name,expected",
    [
        (
            ("arm64"),
            [
                "export MACOSX_DEPLOYMENT_TARGET=10.9",
                "export CC=clang",
                "export CXX=clang++",
            ],
        ),
        (
            ("x86_64"),
            [
                "export MACOSX_DEPLOYMENT_TARGET=10.9",
                "export CC=clang",
                "export CXX=clang++",
                "export CONDA_EXTRA_BUILD_CONSTRAINT='- mkl<=2021.2.0'",
            ],
        ),
    ],
)
def test_get_macos_variables(arch_name, expected):
    assert get_macos_variables(arch_name) == expected
