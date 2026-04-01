#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# repair_manylinux_2_28.sh
#
# Rewrite a wheel's platform tag from linux_* to manylinux_2_28_*, updating
# both the WHEEL metadata file and the RECORD manifest inside the zip.
# The repaired wheel replaces the original on disk.
# ---------------------------------------------------------------------------

make_wheel_record() {
    local fpath="$1"
    if [[ "$fpath" == *RECORD ]]; then
        echo "\"$fpath\",,"
    else
        local hash size
        hash=$(openssl dgst -sha256 -binary "$fpath" | openssl base64 | sed -e 's/+/-/g' -e 's/\//_/g' -e 's/=//g')
        size=$(ls -nl "$fpath" | awk '{print $5}')
        echo "\"$fpath\",sha256=$hash,$size"
    fi
}

if [[ -z "${1:-}" ]]; then
    echo "Usage: $0 <wheel-file>"
    exit 1
fi

pkg="$1"

# Use a proper temp directory with automatic cleanup
work_dir=$(mktemp -d)
cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT

cd "$work_dir"
cp "$pkg" .

local_whl=$(basename "$pkg")
unzip -q "$local_whl"
rm -f "$local_whl"

# Find the .dist-info directory from the extracted contents rather than
# deriving it from the filename (which breaks for non-CPython interpreters
# or packages whose name contains "-cp").
dist_info=$(find . -maxdepth 1 -type d -name '*.dist-info' | head -1)
if [[ -z "$dist_info" ]]; then
    echo "::error::No .dist-info directory found in $pkg"
    exit 1
fi

echo "Changing WHEEL tag"
wheel_file="${dist_info}/WHEEL"
if [[ -f "$wheel_file" ]]; then
    sed -i -e 's#-linux_#-manylinux_2_28_#' "$wheel_file"
fi

# Regenerate the RECORD file with new hashes
record_file="${dist_info}/RECORD"
if [[ -e "$record_file" ]]; then
    echo "Generating new record file $record_file"
    : > "$record_file"
    find . -type f -not -path './.git/*' | sed 's#^\./##' | while read -r fname; do
        make_wheel_record "$fname" >> "$record_file"
    done
fi

pkg_name="${local_whl/-linux_/-manylinux_2_28_}"
zip -qr9 "$pkg_name" .
rm -f "$pkg"
mv "$pkg_name" "$(dirname "$pkg")/$pkg_name"
