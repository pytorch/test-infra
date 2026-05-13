
conda create -y -n ${ENV_NAME}_poetry python=${MATRIX_PYTHON_VERSION} numpy ffmpeg
conda activate ${ENV_NAME}_poetry
# Pin Poetry to a released version. Installing from @main has caused
# recurring CI flakes whenever Poetry's dev branch regresses. Bump
# POETRY_VERSION deliberately when you want to upgrade.
POETRY_VERSION="${POETRY_VERSION:-2.4.1}"
curl -sSL https://install.python-poetry.org | python3 - --version "${POETRY_VERSION}"
export PATH="/root/.local/bin:$PATH"

poetry --version
poetry new test_poetry
cd test_poetry

TEST_SUFFIX=""
if [[ ${TORCH_ONLY} == 'true' ]]; then
    TEST_SUFFIX=" --package torchonly"
elif [[ ${INCLUDE_TORCHAUDIO:-} == 'true' ]]; then
    TEST_SUFFIX=""
else
    TEST_SUFFIX=" --package torch_torchvision"
fi

RELEASE_SUFFIX=""
# if RELESE version is passed as parameter - install speific version
if [[ ! -z ${RELEASE_VERSION} ]]; then
    RELEASE_SUFFIX="@${RELEASE_VERSION}"
fi

if [[ ${TORCH_ONLY} == 'true' ]]; then
    poetry add --no-interaction torch${RELEASE_SUFFIX}
elif [[ ${INCLUDE_TORCHAUDIO:-} == 'true' ]]; then
    poetry add --no-interaction torch${RELEASE_SUFFIX} torchaudio torchvision
else
    poetry add --no-interaction torch${RELEASE_SUFFIX} torchvision
fi

pushd ${PWD}/../.ci/pytorch/
python ./smoke_test/smoke_test.py ${TEST_SUFFIX} --runtime-error-check disabled
popd
conda deactivate
conda env remove -p ${ENV_NAME}_poetry
cd ..
