import json

import pytest

from pytorch_pkg_helpers.conda import (
    get_conda_cuda_variables,
    get_conda_version_variables,
)


@pytest.mark.parametrize(
    "gpu_arch_version,pytorch_version,expected",
    [
        ("cpu", "", "1.13.0.dev20220725"),
        ("cu116", "", "1.13.0.dev20220725"),
        ("cpu", "1.12.0", "1.12.0"),
        ("cu116", "1.12.0", "1.12.0"),
    ],
)
def test_get_conda_version_variables(gpu_arch_version, pytorch_version, expected):
    with open("tests/assets/conda_search.json", "r") as fp:
        assert get_conda_version_variables(
            json.loads(fp.read()),
            gpu_arch_version=gpu_arch_version,
            python_version="3.8",
            pytorch_version=pytorch_version,
        ) == [
            f"export PYTORCH_VERSION='{expected}'",
            f"export CONDA_PYTORCH_BUILD_CONSTRAINT='- pytorch=={expected}'",
            f"export CONDA_PYTORCH_CONSTRAINT='- pytorch=={expected}'",
        ]


@pytest.mark.parametrize(
    "args,expected",
    [
        (
            ("darwin", "cpu"),
            [
                "export CONDA_BUILD_VARIANT='cpu'",
                "export CMAKE_USE_CUDA='0'",
                "export CONDA_CUDATOOLKIT_CONSTRAINT=''",
                "export CUDATOOLKIT_CHANNEL=nvidia",
            ],
        ),
        (
            ("linux", "cpu"),
            [
                "export CONDA_BUILD_VARIANT='cpu'",
                "export CMAKE_USE_CUDA='0'",
                "export CONDA_CUDATOOLKIT_CONSTRAINT=''",
                "export CUDATOOLKIT_CHANNEL=nvidia",
            ],
        ),
        (
            ("linux", "cu116"),
            [
                "export CONDA_BUILD_VARIANT='cuda'",
                "export CMAKE_USE_CUDA='1'",
                "export CONDA_CUDATOOLKIT_CONSTRAINT='- pytorch-cuda=11.6 # [not osx]'",
                "export CUDATOOLKIT_CHANNEL=nvidia",
            ],
        ),
        (
            ("linux", "cu113"),
            [
                "export CONDA_BUILD_VARIANT='cuda'",
                "export CMAKE_USE_CUDA='1'",
                "export CONDA_CUDATOOLKIT_CONSTRAINT='- cudatoolkit >=11.3,<11.4 # [not osx]'",
                "export CUDATOOLKIT_CHANNEL=nvidia",
            ],
        ),
    ],
)
def test_get_conda_cuda_variables(args, expected):
    assert get_conda_cuda_variables(*args) == expected
