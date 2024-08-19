#!/usr/bin/env bash

set -eou pipefail

# Should return the top directory for our git repository
TOP_DIR=$(git rev-parse --show-toplevel)
TEMP_LINT_DIR=${TOP_DIR}/.linttemp

rm -rf "${TEMP_LINT_DIR}"
mkdir -p "${TEMP_LINT_DIR}"

# We can optionally specify a separate clickhouse binary here
CLICKHOUSE_BINARY=${CLICKHOUSE_BINARY:-clickhouse}
CLICKHOUSE_QUERIES_DIR=${CLICKHOUSE_QUERIES_DIR:-${TOP_DIR}/torchci/clickhouse_queries}

# Check if clickhouse binary is actually installed
if ! ${CLICKHOUSE_BINARY} --version >/dev/null 2>/dev/null; then
  echo "ERROR: clickhouse binary '${CLICKHOUSE_BINARY}' not installed"
  echo "       Refer to docs on how to install clickhouse, https://clickhouse.com/docs/en/install"
  echo "       exiting..."
  exit 1
fi

while read -r file; do
  # Get the relative path since we don't want to copy over all of our filesystem structure
  rel_path=${file#${TOP_DIR}/}
  # Make the directory just in case it doesn't exist
  mkdir -p $(dirname "${TEMP_LINT_DIR}/${rel_path}")
  # Do the formatting, output it to a temporary directory first
  ${CLICKHOUSE_BINARY} format < "${rel_path}" > "${TEMP_LINT_DIR}/${rel_path}"
  # Replace the local copy that we have with the one that's been formatted
  mv "${TEMP_LINT_DIR}/${rel_path}" "${rel_path}"
done < <(find ${CLICKHOUSE_QUERIES_DIR} -name "*.sql")

# Check if there's any changes in our queries directory
CHANGES=$(git status --porcelain "${CLICKHOUSE_QUERIES_DIR}")

if [[ -n ${CHANGES} ]]; then
  echo "INFO: The following files have been modified:"
  echo "${CHANGES}"
  exit 2
fi
