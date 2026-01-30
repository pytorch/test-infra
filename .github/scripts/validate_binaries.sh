#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
export DESIRED_DEVTOOLSET="cxx11-abi"

#######################################
# Helper Functions
#######################################

# Handle aarch64 CUDA builds by overriding to CPU mode for validation
handle_aarch64_cuda_override() {
    if [[ ${TARGET_OS} == 'linux-aarch64' && (${MATRIX_GPU_ARCH_TYPE} == 'cuda-aarch64' || ${MATRIX_GPU_ARCH_TYPE} == 'cuda') ]]; then
        echo "Detected aarch64 CUDA build (${MATRIX_GPU_ARCH_TYPE}) - overriding to test CPU fallback mode"
        export MATRIX_GPU_ARCH_TYPE="cpu"
    fi
}

# Get Python version and conda extra parameters based on MATRIX_PYTHON_VERSION
get_python_config() {
    case ${MATRIX_PYTHON_VERSION} in
        3.14t)
            PYTHON_V=3.14.0rc1
            CONDA_EXTRA_PARAM=" python-freethreading -c conda-forge/label/python_rc -c conda-forge"
            ;;
        3.14)
            PYTHON_V=3.14.0rc1
            CONDA_EXTRA_PARAM=" -c conda-forge/label/python_rc -c conda-forge"
            ;;
        3.13t)
            PYTHON_V=3.13
            CONDA_EXTRA_PARAM=" python-freethreading -c conda-forge"
            ;;
        *)
            PYTHON_V=${MATRIX_PYTHON_VERSION}
            CONDA_EXTRA_PARAM=""
            ;;
    esac
    export PYTHON_V CONDA_EXTRA_PARAM
}

# Update conda based on target OS
update_conda() {
    if [[ ${TARGET_OS} == 'macos-arm64' ]]; then
        conda update -y -n base -c defaults conda
    elif [[ ${TARGET_OS} != 'linux-aarch64' ]]; then
        # Conda pinned see issue: https://github.com/ContinuumIO/anaconda-issues/issues/13350
        conda install -y conda=23.11.0
    fi
}

# Modify installation command based on various flags
build_installation_command() {
    local installation="${MATRIX_INSTALLATION}"
    installation=${installation/"conda install"/"conda install -y"}

    # force-reinstall: latest version of packages are reinstalled
    if [[ ${USE_FORCE_REINSTALL:-} == 'true' ]]; then
        installation=${installation/"pip3 install"/"pip3 install --force-reinstall"}
    fi

    # extra-index-url: extra dependencies are downloaded from pypi
    if [[ ${USE_EXTRA_INDEX_URL:-} == 'true' ]]; then
        installation=${installation/"--index-url"/"--extra-index-url"}
    fi

    # use-cloudflare-cdn: use cloudflare cdn for pypi download
    if [[ ${USE_CLOUDFLARE_CDN:-} == 'true' ]]; then
        installation=${installation/"download.pytorch.org"/"download-r2.pytorch.org"}
    fi

    # torch-only option: remove vision and audio
    if [[ ${TORCH_ONLY:-} == 'true' ]]; then
        installation=${installation/"torchvision torchaudio"/""}
    fi

    # if RELEASE version is passed as parameter - install specific version
    if [[ -n ${RELEASE_VERSION:-} ]]; then
        installation=${installation/"torch "/"torch==${RELEASE_VERSION} "}
        installation=${installation/"-y pytorch "/"-y pytorch==${RELEASE_VERSION} "}
        installation=${installation/"::pytorch "/"::pytorch==${RELEASE_VERSION} "}

        if [[ ${USE_VERSION_SET:-} == 'true' ]]; then
            installation=${installation/"torchvision "/"torchvision==${VISION_RELEASE_VERSION} "}
            installation=${installation/"torchaudio "/"torchaudio==${AUDIO_RELEASE_VERSION} "}
        fi
    fi

    echo "${installation}"
}

# Get test suffix based on flags
get_test_suffix() {
    if [[ ${TORCH_ONLY:-} == 'true' ]]; then
        echo "--package torchonly"
    else
        echo ""
    fi
}

# Configure environment variables for wheel variants based on GPU type
configure_wheel_variant_env() {
    case ${MATRIX_GPU_ARCH_VERSION:-} in
        12.6*)
            export NV_VARIANT_PROVIDER_FORCE_CUDA_DRIVER_VERSION='12.6'
            export NV_VARIANT_PROVIDER_FORCE_SM_ARCH='6.0'
            ;;
        12.8*)
            export NV_VARIANT_PROVIDER_FORCE_CUDA_DRIVER_VERSION='12.8'
            export NV_VARIANT_PROVIDER_FORCE_SM_ARCH='9.0'
            ;;
        13.0*)
            export NV_VARIANT_PROVIDER_FORCE_CUDA_DRIVER_VERSION='13.0'
            export NV_VARIANT_PROVIDER_FORCE_SM_ARCH='9.0'
            ;;
    esac

    if [[ ${MATRIX_GPU_ARCH_TYPE:-} == 'xpu' ]]; then
        export INTEL_VARIANT_PROVIDER_FORCE_DEVICE_IP='30.0.4'
    fi

    if [[ ${MATRIX_GPU_ARCH_TYPE:-} == 'rocm' ]]; then
        export AMD_VARIANT_PROVIDER_FORCE_GFX_ARCH="gfx1100"
        export AMD_VARIANT_PROVIDER_FORCE_ROCM_VERSION="${MATRIX_GPU_ARCH_VERSION}.0"
    fi
}

# Get variant index URL based on channel
get_variant_index_url() {
    if [[ ${MATRIX_CHANNEL:-} == 'release' ]]; then
        echo "https://wheelnext.github.io/variants-index/v0.0.3/"
    else
        echo "https://wheelnext.github.io/variants-index-test/v0.0.3/"
    fi
}

# Install packages using wheel variants with uv
# Sets TEST_SUFFIX global variable
install_wheel_variants() {
    local variant_packages="torch torchvision"
    local variant_index_url

    variant_index_url=$(get_variant_index_url)

    if [[ ${TORCH_ONLY:-} == 'true' ]]; then
        variant_packages="torch"
        TEST_SUFFIX="--package torchonly"
    else
        TEST_SUFFIX="--package torch_torchvision"
    fi

    configure_wheel_variant_env

    if [[ ${TARGET_OS} == 'windows' ]]; then
        powershell -ExecutionPolicy Bypass -c "\$env:INSTALLER_DOWNLOAD_URL='https://wheelnext.astral.sh/v0.0.3'; irm https://astral.sh/uv/install.ps1 | iex"
        export PATH="${HOME}/.local/bin/:${PATH}"
    else
        curl -LsSf https://astral.sh/uv/install.sh | \
            INSTALLER_DOWNLOAD_URL=https://wheelnext.astral.sh/v0.0.3 sh
        source "${HOME}/.local/bin/env"
        uv venv --python "${MATRIX_PYTHON_VERSION}"
        source .venv/bin/activate
    fi

    uv pip install --index "${variant_index_url}" ${variant_packages} --force-reinstall --verbose
}

# Install numpy 1.x for Python < 3.13
install_numpy_1x() {
    local minor_version
    minor_version=$(echo "${MATRIX_PYTHON_VERSION}" | cut -d . -f 2)

    if [[ ${minor_version} -lt 13 ]]; then
        pip3 install numpy==1.26.4 --force-reinstall
    fi
}

# Run smoke tests
run_smoke_tests() {
    local test_suffix="$1"

    pushd "${PWD}/.ci/pytorch/"

    if [[ ${TARGET_OS} == 'linux' ]]; then
        export CONDA_LIBRARY_PATH="$(dirname $(which python))/../lib"
        export LD_LIBRARY_PATH="${CONDA_LIBRARY_PATH}:${LD_LIBRARY_PATH:-}"
        source ./check_binary.sh
    fi

    # Run test ops if enabled (CUDA + Python < 3.13)
    if [[ ${INCLUDE_TEST_OPS:-} == 'true' && ${MATRIX_GPU_ARCH_TYPE:-} == 'cuda' && ${MATRIX_PYTHON_VERSION} != "3.13" ]]; then
        source "${SCRIPT_DIR}/validate_test_ops.sh"
    fi

    # Regular smoke test
    ${PYTHON_RUN} ./smoke_test/smoke_test.py ${test_suffix}

    # For pip install also test with latest numpy
    if [[ ${MATRIX_PACKAGE_TYPE} == 'wheel' ]]; then
        pip3 install numpy --upgrade --force-reinstall
        ${PYTHON_RUN} ./smoke_test/smoke_test.py ${test_suffix}
    fi

    popd
}

# Test CUDA device visibility
test_cuda_device() {
    if [[ ${MATRIX_GPU_ARCH_TYPE:-} == 'cuda' ]]; then
        # Run from /tmp to avoid importing torch source directory instead of installed package
        (cd /tmp && python -c "import torch;import os;print(torch.cuda.device_count(), torch.__version__);os.environ['CUDA_VISIBLE_DEVICES']='0';print(torch.empty(2, device='cuda'))")
    fi
}

# Cleanup conda environment
cleanup_conda_env() {
    if [[ ${TARGET_OS} != linux* ]]; then
        conda deactivate
        conda env remove -n "${ENV_NAME}"
    fi
}

#######################################
# Main Script
#######################################

handle_aarch64_cuda_override

if [[ ${MATRIX_PACKAGE_TYPE} == "libtorch" ]]; then
    curl "${MATRIX_INSTALLATION}" -o libtorch.zip
    unzip libtorch.zip
    exit 0
fi

# Set Python executable based on OS
export PYTHON_RUN="python3"
if [[ ${TARGET_OS} == 'windows' ]]; then
    export PYTHON_RUN="python"
fi

# Setup conda environment
update_conda
get_python_config
conda create -y -n "${ENV_NAME}" python="${PYTHON_V}" ${CONDA_EXTRA_PARAM}
conda activate "${ENV_NAME}"

# Save original PATH for macos-arm64 workaround
export OLD_PATH=${PATH}
if [[ ${TARGET_OS} == 'macos-arm64' ]]; then
    export PATH="${CONDA_PREFIX}/bin:${PATH}"
fi

# Remove previous installation if wheel package
if [[ ${MATRIX_PACKAGE_TYPE} == 'wheel' ]]; then
    pip3 uninstall -y torch torchaudio torchvision || true
fi

# Install packages
if [[ ${USE_WHEEL_VARIANTS:-} == 'true' ]]; then
    install_wheel_variants
else
    INSTALLATION=$(build_installation_command)
    TEST_SUFFIX=$(get_test_suffix)
    eval "${INSTALLATION}"
fi

# Install numpy 1.x after torch install
install_numpy_1x

# Run tests
run_smoke_tests "${TEST_SUFFIX}"

# Restore PATH for macos-arm64
if [[ ${TARGET_OS} == 'macos-arm64' ]]; then
    export PATH=${OLD_PATH}
fi

# Test CUDA device visibility
test_cuda_device

# Cleanup
cleanup_conda_env
