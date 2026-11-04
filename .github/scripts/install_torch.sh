_INSTALL_TORCH_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
source "${_INSTALL_TORCH_DIR}/uv_env.sh"
install_uv
create_uv_venv "${ENV_NAME}" "${MATRIX_PYTHON_VERSION}"
export MATRIX_INSTALLATION="${MATRIX_INSTALLATION/torchvision}"
export MATRIX_INSTALLATION="${MATRIX_INSTALLATION/torchaudio}"
# if RELESE version is passed as parameter - install speific version
if [[ ! -z ${RELEASE_VERSION} ]]; then
    MATRIX_INSTALLATION=${MATRIX_INSTALLATION/"torch "/"torch==${RELEASE_VERSION} "}
fi
eval $MATRIX_INSTALLATION

export PYTORCH_PIP_PREFIX=""

if [[ ${MATRIX_CHANNEL} = "nightly" ]]; then
    export PYTORCH_PIP_PREFIX="--pre"
fi

if [[ ${MATRIX_CHANNEL} = "nightly" || ${MATRIX_CHANNEL} = "test" ]]; then
    export PYTORCH_PIP_DOWNLOAD_URL="https://download.pytorch.org/whl/${MATRIX_CHANNEL}/${MATRIX_DESIRED_CUDA}"
else
    export PYTORCH_PIP_DOWNLOAD_URL="https://download.pytorch.org/whl/${MATRIX_DESIRED_CUDA}"
fi
