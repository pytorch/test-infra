#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# pypi_cache/build.sh
#
# Builds PyPI wheels for every requested package/Python-version combination
# and uploads them to an S3-backed wheel cache.  Wheels that already exist in
# S3 are skipped.
# ---------------------------------------------------------------------------

# Required environment variables
: "${S3_BUCKET:?S3_BUCKET must be set (e.g. pytorch-pypi-wheel-cache)}"
: "${VARIANT:?VARIANT must be set (e.g. cu128, cu130, cpu)}"
: "${ARCH:?ARCH must be set (x86_64 or aarch64)}"
: "${PYTHON_VERSIONS:?PYTHON_VERSIONS must be set (space-separated, e.g. '3.10 3.11 3.12')}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="/tmp/pypi-cache-build"
WANTS_DIR="${BUILD_DIR}/wants"
WHEEL_DIR="${BUILD_DIR}/wheels"
PACKAGES_FILE="${BUILD_DIR}/packages.txt"
SKIP_FILE="${SCRIPT_DIR}/skip_python_versions.txt"
EXPANDED_SKIP="${BUILD_DIR}/expanded_skip.txt"

mkdir -p "${BUILD_DIR}"
: > /tmp/pypi-cache-failure-summary.txt
cleanup() { rm -rf "${BUILD_DIR}"; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

python_path() {
    local ver="$1" digits suffix=""
    if [[ "${ver}" == *t ]]; then
        suffix="t"
        ver="${ver%t}"
    fi
    digits="${ver//./}"
    echo "/opt/python/cp${digits}-cp${digits}${suffix}/bin/python"
}

cp_tag() {
    local ver="$1" digits suffix=""
    if [[ "${ver}" == *t ]]; then
        suffix="t"
        ver="${ver%t}"
    fi
    digits="${ver//./}"
    echo "cp${digits}${suffix}"
}

normalize_name() {
    echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[-_.]+/_/g'
}

escape_ere() {
    # Escape ERE metacharacters so the string is matched literally in grep -E
    sed 's/[].\\*+?|(){}[^$]/\\&/g' <<< "$1"
}

wheel_exists() {
    local norm ver="$2" tag="$3" arch="$4" listing="$5"
    # Escape ERE metacharacters in name and version so they match literally in grep -E.
    # Name may contain "+" (e.g. c++utilities); version may contain "+" (PEP 440 local, e.g. 1.0+cu128).
    norm=$(escape_ere "$1")
    local escaped_ver
    escaped_ver=$(escape_ere "$ver")
    # Match abi tag precisely: {name}-{ver}(-{build})?-{python_tag}-{abi_tag}-{platform}.whl
    # The optional (-[^-]+)? handles PEP 427 build tags.
    # Using [^-]* for python_tag avoids cp313 matching cp313t and vice versa.
    # Case-insensitive (-i) because S3 listing preserves original casing (e.g. PyYAML)
    # but normalize_name lowercases.
    grep -qiE "^${norm}-${escaped_ver}(-[^-]+)?-[^-]*-${tag}-.*manylinux.*${arch}\.whl" "${listing}" 2>/dev/null && return 0
    # Match pure-Python wheels: py3-none-any or py2.py3-none-any
    grep -qiE "^${norm}-${escaped_ver}-py[23][^-]*-none-any\.whl" "${listing}" 2>/dev/null && return 0
    # Match platform-specific but Python-version-independent wheels: py3-none-manylinux_*
    # (e.g. Rust/Go binaries distributed as wheels like uv, ruff)
    grep -qiE "^${norm}-${escaped_ver}-py[23][^-]*-none-.*manylinux.*${arch}\.whl" "${listing}" 2>/dev/null && return 0
    return 1
}

# ---------------------------------------------------------------------------
# Step 1: Configure CUDA (if applicable)
# ---------------------------------------------------------------------------
if [[ -n "${CUDA_DIR:-}" ]]; then
    rm -f /usr/local/cuda
    ln -s "${CUDA_DIR}" /usr/local/cuda
    export PATH="/usr/local/cuda/bin:${PATH}"
    export LD_LIBRARY_PATH="/usr/local/cuda/lib64:${LD_LIBRARY_PATH:-}"
    export CUDA_HOME="/usr/local/cuda"
fi

# ---------------------------------------------------------------------------
# Step 2: Download wants/*.txt from S3, merge and deduplicate
# ---------------------------------------------------------------------------
mkdir -p "${WANTS_DIR}" "${WHEEL_DIR}"
aws s3 cp "s3://${S3_BUCKET}/wants/" "${WANTS_DIR}/" --recursive

if compgen -G "${WANTS_DIR}/*.txt" > /dev/null; then
    cat "${WANTS_DIR}"/*.txt \
        | sed 's/#.*//; s/^[[:space:]]*//; s/[[:space:]]*$//; /^$/d' \
        | sort -u > "${PACKAGES_FILE}"
else
    touch "${PACKAGES_FILE}"
fi

echo "==> Merged package list ($(wc -l < "${PACKAGES_FILE}") entries)"

# ---------------------------------------------------------------------------
# Step 2b: Preprocess skip list (highest precedence — not overridden by force)
# ---------------------------------------------------------------------------
: > "${EXPANDED_SKIP}"
if [[ -f "${SKIP_FILE}" ]]; then
    while IFS= read -r _line; do
        _line="${_line%%#*}"
        _line="$(echo "${_line}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
        [[ -z "${_line}" ]] && continue

        read -r _skip_pkg _skip_pyvers <<< "${_line}"
        [[ "${_skip_pkg}" != *==* ]] && continue
        _norm_name=$(normalize_name "${_skip_pkg%%==*}")
        _skip_ver="${_skip_pkg##*==}"
        for _sv in ${_skip_pyvers}; do
            echo "${_norm_name}==${_skip_ver}:${_sv}" >> "${EXPANDED_SKIP}"
        done
    done < "${SKIP_FILE}"
    echo "==> Skip list loaded ($(wc -l < "${EXPANDED_SKIP}") entries)"
fi

# ---------------------------------------------------------------------------
# Step 3: Cache existing S3 wheel listing
# ---------------------------------------------------------------------------
existing="${BUILD_DIR}/existing_wheels.txt"
aws s3 ls "s3://${S3_BUCKET}/${VARIANT}/" 2>/dev/null \
    | grep '\.whl$' \
    | awk '{print $NF}' \
    > "${existing}" || true

echo "==> Existing wheels in S3: $(wc -l < "${existing}")"

# ---------------------------------------------------------------------------
# Step 4: Build missing wheels for each Python version
# ---------------------------------------------------------------------------
built=0
skipped=0
excluded=0
failed=0
failures_log="${BUILD_DIR}/failures.log"
: > "${failures_log}"

for pyver in ${PYTHON_VERSIONS}; do
    py_bin=$(python_path "${pyver}")
    tag=$(cp_tag "${pyver}")

    if [[ ! -x "${py_bin}" ]]; then
        echo "::warning::Python ${pyver} not found at ${py_bin}, skipping"
        continue
    fi

    echo "==> Processing Python ${pyver}  (${py_bin})"

    while IFS= read -r entry; do
        [[ -z "${entry}" ]] && continue
        [[ "${entry}" != *==* ]] && continue

        pkg_name="${entry%%==*}"
        pkg_version="${entry##*==}"
        norm=$(normalize_name "${pkg_name}")
        out="${WHEEL_DIR}/${pyver}"
        mkdir -p "${out}"

        # Skip list has highest precedence (not overridden by force_rebuild)
        if grep -qFx "${norm}==${pkg_version}:${pyver}" "${EXPANDED_SKIP}" 2>/dev/null; then
            echo "    Excluding ${entry} for ${pyver} (unsupported)"
            ((excluded++)) || true
            continue
        fi

        if [[ "${FORCE_REBUILD:-}" != "*" && "${FORCE_REBUILD:-}" != "${entry}" ]]; then
            if wheel_exists "${norm}" "${pkg_version}" "${tag}" "${ARCH}" "${existing}"; then
                ((skipped++)) || true
                continue
            fi
        fi

        echo "    Building ${entry} for ${tag} ..."
        if ! "${py_bin}" -m pip wheel --no-deps --wheel-dir "${out}" "${entry}"; then
            echo "::warning::Failed to build ${entry} for Python ${pyver}"
            printf "%s\t%s\n" "${entry}" "${pyver}" >> "${failures_log}"
            ((failed++)) || true
            rm -rf "${out:?}"/*
            continue
        fi

        for whl in "${out}"/*.whl; do
            [[ -f "${whl}" ]] || continue
            whl_name=$(basename "${whl}")

            if [[ "${whl_name}" == *-linux_* ]]; then
                (cd "${BUILD_DIR}" && bash "${SCRIPT_DIR}/../repair_manylinux_2_28.sh" "${whl}")
                whl_name="${whl_name/-linux_/-manylinux_2_28_}"
                whl="${out}/${whl_name}"
            fi

            if aws s3 cp "${whl}" "s3://${S3_BUCKET}/${VARIANT}/${whl_name}"; then
                echo "${whl_name}" >> "${existing}"
                ((built++)) || true
            else
                echo "::warning::Upload failed: ${whl_name}"
                ((failed++)) || true
            fi
        done

        rm -rf "${out:?}"/*
    done < "${PACKAGES_FILE}"
done

# ---------------------------------------------------------------------------
# Step 5: Summary
# ---------------------------------------------------------------------------
echo ""
echo "==> Build complete:  built=${built}  skipped=${skipped}  excluded=${excluded}  failed=${failed}"

# Write formatted failure summary for the workflow summary step
if (( failed > 0 )); then
    sort "${failures_log}" | awk -F'\t' '
    {
        pkg = $1; pyver = $2
        if (pkg != prev) {
            if (prev != "") print ""
            print pkg ":"
            prev = pkg
        }
        print "  - " pyver
    }' > /tmp/pypi-cache-failure-summary.txt
fi
exit 0
