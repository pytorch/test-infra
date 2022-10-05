def get_macos_variables(arch_name: str) -> list:
    variables = [
        "export MACOSX_DEPLOYMENT_TARGET=10.9",
        "export CC=clang",
        "export CXX=clang++",
    ]

    if arch_name != "arm64":
        variables.append("export CONDA_EXTRA_BUILD_CONSTRAINT='- mkl<=2021.2.0'")

    return variables
