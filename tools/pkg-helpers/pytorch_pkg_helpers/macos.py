def get_macos_variables(arch_name: str, python_version: str = "3.8") -> list:
    variables = [
        "export MACOSX_DEPLOYMENT_TARGET=10.13",
        "export CC=clang",
        "export CXX=clang++",
    ]

    return variables
