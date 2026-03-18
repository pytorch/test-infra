def get_macos_variables(arch_name: str, python_version: str = "3.8") -> list:
    # Python 3.13+ requires macOS 12.0
    # Handle full point versions like "3.11.14" and freethreaded like "3.13t"
    parts = python_version.rstrip("t").split(".")
    base_version = float(f"{parts[0]}.{parts[1]}")
    deployment_target = "12.0" if base_version >= 3.13 else "11.0"
    variables = [
        f"export MACOSX_DEPLOYMENT_TARGET={deployment_target}",
        "export CC=clang",
        "export CXX=clang++",
    ]

    return variables
