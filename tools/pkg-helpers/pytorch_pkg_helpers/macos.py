def get_macos_variables(arch_name: str, python_version: str = "3.8") -> list:
    deployment_target = "14.0"
    variables = [
        f"export MACOSX_DEPLOYMENT_TARGET={deployment_target}",
        f"export _PYTHON_HOST_PLATFORM=macosx-{deployment_target}-arm64",
        "export CC=clang",
        "export CXX=clang++",
    ]

    return variables
