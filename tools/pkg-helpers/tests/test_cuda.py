import pytest

from pytorch_pkg_helpers.cuda import get_cuda_arch_list, get_cuda_variables
from pytorch_pkg_helpers.utils import transform_cuversion


@pytest.mark.parametrize("package_type", ["conda", "wheel"])
def test_cuda_variables_darwin(package_type):
    assert get_cuda_variables(package_type, "darwin", "cpu") == [
        "export VERSION_SUFFIX=''",
        "export PYTORCH_VERSION_SUFFIX=''",
        "export WHEEL_DIR=''",
    ]


@pytest.mark.parametrize("platform", ["linux", "win32"])
def test_cuda_variables_cpu_wheel(platform):
    assert get_cuda_variables("wheel", platform, "cpu") == [
        "export VERSION_SUFFIX='+cpu'",
        "export PYTORCH_VERSION_SUFFIX='+cpu'",
        "export WHEEL_DIR='cpu/'",
    ]


@pytest.mark.parametrize("platform", ["linux", "win32"])
def test_cuda_variables_cpu_conda(platform):
    assert get_cuda_variables("conda", platform, "cpu") == [
        "export VERSION_SUFFIX=''",
        "export PYTORCH_VERSION_SUFFIX=''",
        "export WHEEL_DIR=''",
    ]


def test_cuda_variables_wheel_rocm():
    gpu_arch_version = "rocm5.4.1"
    assert get_cuda_variables("wheel", "linux", gpu_arch_version) == [
        f"export VERSION_SUFFIX='+{gpu_arch_version}'",
        f"export PYTORCH_VERSION_SUFFIX='+{gpu_arch_version}'",
        f"export WHEEL_DIR='{gpu_arch_version}/'",
        "export FORCE_CUDA=1",
    ]


@pytest.mark.parametrize("gpu_arch_version", ["cu102", "cu116"])
def test_cuda_variables_cuda_linux_conda(gpu_arch_version):
    sanitized_version = transform_cuversion(gpu_arch_version)
    cuda_home = f"/usr/local/cuda-{sanitized_version}"
    assert get_cuda_variables("conda", "linux", gpu_arch_version) == [
        "export VERSION_SUFFIX=''",
        "export PYTORCH_VERSION_SUFFIX=''",
        "export WHEEL_DIR=''",
        f"export CUDA_HOME='{cuda_home}'",
        f"export TORCH_CUDA_ARCH_LIST='{get_cuda_arch_list(sanitized_version)}'",
        # Double quotes needed here to expand PATH var
        f'export PATH="{cuda_home}/bin:${{PATH}}"',
        "export FORCE_CUDA=1",
    ]


@pytest.mark.parametrize("gpu_arch_version", ["cu102", "cu116"])
def test_cuda_variables_cuda_linux_wheels(gpu_arch_version):
    sanitized_version = transform_cuversion(gpu_arch_version)
    cuda_home = f"/usr/local/cuda-{sanitized_version}"
    assert get_cuda_variables("wheel", "linux", gpu_arch_version) == [
        f"export VERSION_SUFFIX='+{gpu_arch_version}'",
        f"export PYTORCH_VERSION_SUFFIX='+{gpu_arch_version}'",
        f"export WHEEL_DIR='{gpu_arch_version}/'",
        f"export CUDA_HOME='{cuda_home}'",
        f"export TORCH_CUDA_ARCH_LIST='{get_cuda_arch_list(sanitized_version)}'",
        # Double quotes needed here to expand PATH var
        f'export PATH="{cuda_home}/bin:${{PATH}}"',
        "export FORCE_CUDA=1",
    ]


@pytest.mark.parametrize("gpu_arch_version", ["cu102", "cu116"])
def test_cuda_variables_cuda_windows_conda(gpu_arch_version):
    sanitized_version = transform_cuversion(gpu_arch_version)
    cuda_home = (
        f"C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v{sanitized_version}"
    )
    assert get_cuda_variables("conda", "win32", gpu_arch_version) == [
        "export VERSION_SUFFIX=''",
        "export PYTORCH_VERSION_SUFFIX=''",
        "export WHEEL_DIR=''",
        f"export CUDA_HOME='{cuda_home}'",
        f"export TORCH_CUDA_ARCH_LIST='{get_cuda_arch_list(sanitized_version)}'",
        # Double quotes needed here to expand PATH var
        f'export PATH="{cuda_home}/bin:${{PATH}}"',
        "export FORCE_CUDA=1",
    ]


@pytest.mark.parametrize("gpu_arch_version", ["cu102", "cu116"])
def test_cuda_variables_cuda_windows_wheels(gpu_arch_version):
    sanitized_version = transform_cuversion(gpu_arch_version)
    cuda_home = (
        f"C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v{sanitized_version}"
    )
    assert get_cuda_variables("wheel", "win32", gpu_arch_version) == [
        f"export VERSION_SUFFIX='+{gpu_arch_version}'",
        f"export PYTORCH_VERSION_SUFFIX='+{gpu_arch_version}'",
        f"export WHEEL_DIR='{gpu_arch_version}/'",
        f"export CUDA_HOME='{cuda_home}'",
        f"export TORCH_CUDA_ARCH_LIST='{get_cuda_arch_list(sanitized_version)}'",
        # Double quotes needed here to expand PATH var
        f'export PATH="{cuda_home}/bin:${{PATH}}"',
        "export FORCE_CUDA=1",
    ]
