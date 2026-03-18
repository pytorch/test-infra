import pytest  # type: ignore[import-not-found]
from pytorch_pkg_helpers.macos import get_macos_variables


@pytest.mark.parametrize(
    "python_version,expected_target",
    [
        ("3.10", "11.0"),
        ("3.11", "11.0"),
        ("3.12", "11.0"),
        ("3.13", "12.0"),
        ("3.13t", "12.0"),
        ("3.14", "12.0"),
        ("3.14t", "12.0"),
    ],
)
def test_get_macos_variables(python_version, expected_target):
    result = get_macos_variables("arm64", python_version)
    assert result == [
        f"export MACOSX_DEPLOYMENT_TARGET={expected_target}",
        f"export _PYTHON_HOST_PLATFORM=macosx-{expected_target}-arm64",
        "export CC=clang",
        "export CXX=clang++",
    ]
