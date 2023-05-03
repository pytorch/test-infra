def get_macos_variables(arch_name: str, python_version: str = "3.8") -> list:
    variables = [
        "export MACOSX_DEPLOYMENT_TARGET=10.9",
        "export CC=clang",
        "export CXX=clang++",
    ]

    if arch_name != "arm64"
        variables.append("export CONDA_EXTRA_BUILD_CONSTRAINT='- mkl<=2021.4.0'")

    return variables
