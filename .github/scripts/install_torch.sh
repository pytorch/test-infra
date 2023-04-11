conda create --yes --quiet -n ${ENV_NAME} python=${MATRIX_PYTHON_VERSION}
conda activate ${ENV_NAME}
export MATRIX_INSTALLATION="${MATRIX_INSTALLATION/torchvision}"
export MATRIX_INSTALLATION="${MATRIX_INSTALLATION/torchaudio}"
if [[ ${MATRIX_PACKAGE_TYPE} = "conda" ]]; then
    export MATRIX_INSTALLATION=${MATRIX_INSTALLATION/"conda install"/"conda install --yes --quiet"}
fi
eval $MATRIX_INSTALLATION

export PYTORCH_PIP_PREFIX=""

if [[ ${MATRIX_CHANNEL} = "nightly" ]]; then
    export PYTORCH_PIP_PREFIX="--pre"
fi

if [[ ${MATRIX_CHANNEL} = "nightly" || ${MATRIX_CHANNEL} = "test" ]]; then
    export PYTORCH_PIP_DOWNLOAD_URL="https://download.pytorch.org/whl/${MATRIX_CHANNEL}/${MATRIX_DESIRED_CUDA}"
    export PYTORCH_CONDA_CHANNEL="pytorch-${MATRIX_CHANNEL}"
else
    export PYTORCH_CONDA_CHANNEL="pytorch"
    export PYTORCH_PIP_DOWNLOAD_URL="https://download.pytorch.org/whl/${MATRIX_DESIRED_CUDA}"
fi
