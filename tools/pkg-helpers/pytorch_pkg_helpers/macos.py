def get_macos_variables():
    return [
        "export CONDA_EXTRA_BUILD_CONSTRAINT='- mkl<=2021.2.0'",
        "export MACOSX_DEPLOYMENT_TARGET=10.9",
        "export CC=clang",
        "export CXX=clang++",
    ]
