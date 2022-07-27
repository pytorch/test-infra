import pytest

from pytorch_pkg_helpers.wheel import (
    get_pytorch_pip_install_command,
    get_wheel_variables,
)


@pytest.mark.parametrize(
    "python_version,expected_path",
    [
        ("3.7", "/opt/python/cp37-cp37m"),
        ("3.9", "/opt/python/cp39-cp39"),
    ],
)
def test_get_wheel_variables_linux_includes_path(python_version, expected_path):
    assert any(
        [
            expected_path in variable
            for variable in get_wheel_variables(
                platform="linux",
                gpu_arch_version="cpu",
                python_version=python_version,
                pytorch_version="",
                channel="nightly",
            )
        ]
    )


@pytest.mark.parametrize(
    "pytorch_version,channel,gpu_arch_version,includes_pre,expected_index",
    [
        ("", "nightly", "cpu", True, "https://download.pytorch.org/whl/nightly/cpu"),
        ("", "test", "cpu", False, "https://download.pytorch.org/whl/test/cpu"),
        (
            "",
            "nightly",
            "cu116",
            True,
            "https://download.pytorch.org/whl/nightly/cu116",
        ),
        ("", "test", "cu116", False, "https://download.pytorch.org/whl/test/cu116"),
        (
            "1.13.0",
            "nightly",
            "cpu",
            True,
            "https://download.pytorch.org/whl/nightly/cpu",
        ),
        ("1.13.0", "test", "cpu", False, "https://download.pytorch.org/whl/test/cpu"),
        (
            "1.13.0",
            "nightly",
            "cu116",
            True,
            "https://download.pytorch.org/whl/nightly/cu116",
        ),
        (
            "1.13.0",
            "test",
            "cu116",
            False,
            "https://download.pytorch.org/whl/test/cu116",
        ),
    ],
)
def test_get_wheel_variables_includes_extra_index(
    pytorch_version, channel, gpu_arch_version, includes_pre, expected_index
):
    def pass_test(variable):
        assert expected_index in variable
        if includes_pre:
            assert "--pre" in variable
        if pytorch_version != "":
            assert pytorch_version in variable

    for variable in get_pytorch_pip_install_command(
        gpu_arch_version=gpu_arch_version,
        pytorch_version=pytorch_version,
        channel=channel,
    ):
        pass_test(variable)
