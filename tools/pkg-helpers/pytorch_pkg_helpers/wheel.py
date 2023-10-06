from typing import List
from packaging import version

def get_python_path_variables(python_version: str) -> List[str]:
    m = ""
    # For some reason python versions <= 3.7 require an m
    # probably better not to ask why
    if version.parse(python_version) <= version.parse(3.7):
        m = "m"
    python_nodot = python_version.replace(".", "")
    python_abi = f"cp{python_nodot}-cp{python_nodot}{m}"
    return [f'export PATH="/opt/python/{python_abi}/bin:${{PATH}}"']


def get_pytorch_pip_install_command(
    gpu_arch_version: str,
    pytorch_version: str,
    channel: str,
) -> List[str]:
    torch_pkg = "torch"
    if pytorch_version != "":
        torch_pkg += f"=={pytorch_version}"
    pip_install = f"pip install {torch_pkg}"
    if channel == "nightly":
        pip_install += " --pre"
    extra_index = f"https://download.pytorch.org/whl/{channel}/{gpu_arch_version}"
    return [f"export PIP_INSTALL_TORCH='{pip_install} --extra-index-url {extra_index}'"]


def get_pytorch_s3_bucket_path(
    gpu_arch_version: str,
    channel: str,
    upload_to_base_bucket: bool,
) -> List[str]:
    path = f"s3://pytorch/whl/{channel}/{gpu_arch_version}/"
    if upload_to_base_bucket:
        path = f"s3://pytorch/whl/{channel}/"
    return [f"export PYTORCH_S3_BUCKET_PATH='{path}'"]


def get_wheel_variables(
    platform: str,
    gpu_arch_version: str,
    python_version: str,
    pytorch_version: str,
    channel: str,
    upload_to_base_bucket: bool,
) -> List[str]:
    ret = []
    if platform.startswith("linux"):
        ret.extend(get_python_path_variables(python_version=python_version))
    ret.extend(
        get_pytorch_pip_install_command(
            gpu_arch_version=gpu_arch_version,
            pytorch_version=pytorch_version,
            channel=channel,
        )
    )
    ret.extend(
        get_pytorch_s3_bucket_path(
            gpu_arch_version=gpu_arch_version,
            channel=channel,
            upload_to_base_bucket=upload_to_base_bucket,
        )
    )
    return ret
