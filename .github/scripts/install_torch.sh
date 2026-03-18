conda create --yes --quiet -n ${ENV_NAME} python=${MATRIX_PYTHON_VERSION}
conda activate ${ENV_NAME}
export MATRIX_INSTALLATION="${MATRIX_INSTALLATION/torchvision}"
export MATRIX_INSTALLATION="${MATRIX_INSTALLATION/torchaudio}"
if [[ ${MATRIX_PACKAGE_TYPE} = "conda" ]]; then
    export MATRIX_INSTALLATION=${MATRIX_INSTALLATION/"conda install"/"conda install --yes --quiet"}
fi
# if RELESE version is passed as parameter - install speific version
if [[ ! -z ${RELEASE_VERSION} ]]; then
    MATRIX_INSTALLATION=${MATRIX_INSTALLATION/"torch "/"torch==${RELEASE_VERSION} "}
    MATRIX_INSTALLATION=${MATRIX_INSTALLATION/"-y pytorch "/"-y pytorch==${RELEASE_VERSION} "}
    MATRIX_INSTALLATION=${MATRIX_INSTALLATION/"::pytorch "/"::pytorch==${RELEASE_VERSION} "}
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
