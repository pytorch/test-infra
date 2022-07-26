from typing import List


def get_python_path_variables(python_version: str) -> List[str]:
    m = ""
    # For some reason python versions <= 3.7 require an m
    # probably better not to ask why
    if float(python_version) <= 3.7:
        m = "m"
    python_nodot = python_version.replace(".", "")
    python_abi = f"cp{python_nodot}-cp{python_nodot}{m}"
    return [f'export PATH="/opt/python/{python_abi}/bin:${{PATH}}"']


def get_pytorch_pip_install_command(
    platform: str,
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


def get_wheel_variables(
    platform: str,
    gpu_arch_version: str,
    python_version: str,
    pytorch_version: str,
    channel: str,
) -> List[str]:
    ret = []
    if platform.startswith("linux"):
        ret.extend(get_python_path_variables(python_version=python_version))
    ret.extend(
        get_pytorch_pip_install_command(
            platform=platform,
            gpu_arch_version=gpu_arch_version,
            pytorch_version=pytorch_version,
            channel=channel,
        )
    )
    return ret
