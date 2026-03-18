def get_macos_variables(arch_name: str, python_version: str = "3.8") -> list:
    # Python 3.13+ requires macOS 12.0
    base_version = float(python_version.rstrip("t"))
    deployment_target = "12.0" if base_version >= 3.13 else "11.0"
    variables = [
        f"export MACOSX_DEPLOYMENT_TARGET={deployment_target}",
        "export CC=clang",
        "export CXX=clang++",
    ]

    return variables
