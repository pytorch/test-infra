#!/bin/bash
# Helpers shared by the binary validation scripts (validate_binaries.sh,
# validate_poetry.sh, install_torch.sh) to create the Python environment they
# validate in with uv, instead of conda.
#
# Meant to be sourced. It sets no shell options, and it needs TARGET_OS to be
# 'windows' on Windows runners (git bash); any other value is treated as POSIX.

# Version of uv to install. Pinned so a uv release cannot change the results of a
# nightly validation run; bump it deliberately. It must know the newest CPython
# in the validation matrix (3.15 needs uv >= 0.13).
UV_VERSION="${UV_VERSION:-0.13.7}"

# Only use the python-build-standalone interpreters uv downloads. Without this uv
# can pick a system python of the requested version, whose ABI, libraries and
# free-threading support vary between runner images.
export UV_PYTHON_PREFERENCE="only-managed"

# Install uv $UV_VERSION unless that version is already on PATH.
install_uv() {
    if command -v uv > /dev/null && [[ "$(uv --version)" == "uv ${UV_VERSION}"* ]]; then
        return 0
    fi

    if [[ ${TARGET_OS:-} == 'windows' ]]; then
        powershell -ExecutionPolicy Bypass -c "irm https://astral.sh/uv/${UV_VERSION}/install.ps1 | iex"
        export PATH="${HOME}/.local/bin/:${PATH}"
    else
        curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh
        source "${HOME}/.local/bin/env"
    fi
    uv --version
}

# create_uv_venv DIR PYTHON
#
# Create a venv in DIR with the given Python (e.g. "3.12", "3.14t") and activate
# it. --seed puts pip in it, so `pip3 install` works as it did in a conda env.
create_uv_venv() {
    local venv_dir="$1" python_version="$2"

    uv venv --seed --python "${python_version}" "${venv_dir}"
    # uv lays the venv out the platform way: Scripts/ on Windows, bin/ elsewhere.
    if [[ ${TARGET_OS:-} == 'windows' ]]; then
        source "${venv_dir}/Scripts/activate"
    else
        source "${venv_dir}/bin/activate"
    fi
}

# remove_uv_venv DIR
#
# Deactivate the active venv, if any, and delete DIR.
remove_uv_venv() {
    local venv_dir="$1"

    # `deactivate` is a function defined by the venv's activate script.
    if declare -F deactivate > /dev/null; then
        deactivate
    fi
    rm -rf "${venv_dir}"
}
