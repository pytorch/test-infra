import json

import pytest

from pytorch_pkg_helpers.conda import (
    get_conda_version_variables,
    get_conda_cuda_variables,
)


@pytest.mark.parametrize(
    "args",
    [
        "cpu",
        "cu116",
    ]
)
def test_get_conda_version_variables(args):
    with open("tests/assets/conda_search.json", "r") as fp:
        pytorch_version = "1.13.0.dev20220725"
        assert get_conda_version_variables(
            json.loads(fp.read()), gpu_arch_version=args, python_version="3.8"
        ) == [
            f"export PYTORCH_VERSION='{pytorch_version}'",
            f"export CONDA_PYTORCH_BUILD_CONSTRAINT='- pytorch=={pytorch_version}'",
            f"export CONDA_PYTORCH_CONSTRAINT='- pytorch=={pytorch_version}'",
        ]


@pytest.mark.parametrize(
    "args,expected",
    [
        (
            ("darwin", "cpu"),
            [
                f"export CONDA_BUILD_VARIANT='cpu'",
                f"export CMAKE_USE_CUDA='0'",
                f"export CONDA_CUDATOOLKIT_CONSTRAINT=''",
            ],
        ),
        (
            ("linux", "cpu"),
            [
                f"export CONDA_BUILD_VARIANT='cpu'",
                f"export CMAKE_USE_CUDA='0'",
                f"export CONDA_CUDATOOLKIT_CONSTRAINT=''",
            ],
        ),
        (
            ("linux", "cu116"),
            [
                f"export CONDA_BUILD_VARIANT='cuda'",
                f"export CMAKE_USE_CUDA='1'",
                f"export CONDA_CUDATOOLKIT_CONSTRAINT='cuda=11.6'",
            ],
        ),
        (
            ("linux", "cu113"),
            [
                f"export CONDA_BUILD_VARIANT='cuda'",
                f"export CMAKE_USE_CUDA='1'",
                f"export CONDA_CUDATOOLKIT_CONSTRAINT='cudatoolkit=11.3'",
            ],
        ),
    ],
)
def test_get_conda_cuda_variables(args, expected):
    assert get_conda_cuda_variables(*args) == expected
