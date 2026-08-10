#!/usr/bin/env bash
# Write a GitHub Actions job summary listing the files a release step transferred.
#
# The release workflows all drive `aws s3 cp` / `aws s3 sync`, which print one line
# per object:
#
#   copy: s3://pytorch/whl/test/cu128/foo.whl to s3://pytorch/whl/cu128/foo.whl
#   (dryrun) copy: s3://... to s3://...
#   upload: ./foo.whl to s3://pytorch-backup/foo-1.0-pypi-staging/foo.whl
#   download: s3://pytorch-backup/... to dist/foo.whl
#
# Capture that output to a log and pass it here. Reading the transfer log rather
# than listing the destination afterwards means the summary reports what this run
# actually moved, not whatever already happened to be there.
#
# Usage: summarize_promoted_files.sh <logfile> <title> [dry_run]
#   dry_run: "enabled" (default) or "disabled" -- only controls the banner.

set -euo pipefail

LOG_FILE=${1:?usage: summarize_promoted_files.sh <logfile> <title> [dry_run]}
TITLE=${2:?usage: summarize_promoted_files.sh <logfile> <title> [dry_run]}
DRY_RUN=${3:-enabled}

# Fall back to stdout when run outside Actions, so the script stays testable.
SUMMARY_FILE=${GITHUB_STEP_SUMMARY:-/dev/stdout}

if [[ ! -s "${LOG_FILE}" ]]; then
    {
        echo "## ${TITLE}"
        echo
        echo "No transfer log was produced, so there is nothing to report."
    } >>"${SUMMARY_FILE}"
    exit 0
fi

# The destination of a transfer is whatever follows the last " to ". Progress
# output is carriage-return delimited, so turn CRs into newlines (rather than
# deleting them) to keep the "copy:" prefix at the start of its own line.
# sort -u because a retried transfer logs the same object twice.
DESTS=$(tr '\r' '\n' <"${LOG_FILE}" \
    | grep -E '^(\(dryrun\) )?(copy|upload|download|move): ' \
    | sed -E -e 's/.* to (.*)$/\1/' -e 's/[[:space:]]*$//' \
    | grep -v '^$' \
    | sort -u || true)

COUNT=$(printf '%s' "${DESTS}" | grep -c '^' || true)

{
    echo "## ${TITLE}"
    echo
    if [[ "${DRY_RUN}" != "disabled" ]]; then
        echo "> **Dry run** -- these transfers were simulated, nothing was published."
        echo
    fi

    if [[ "${COUNT}" -eq 0 ]]; then
        echo "**No files were transferred.**"
        echo
        echo "The commands ran but moved nothing, which usually means the source"
        echo "pattern matched no objects. Check the package version and channel"
        echo "before treating this run as a success."
    else
        echo "**${COUNT} file(s) transferred.**"
        echo

        # Group by destination directory: a multi-accelerator promotion then reads
        # as a handful of collapsed buckets rather than one flat list of ~200 wheels.
        printf '%s\n' "${DESTS}" | sed -E 's:/[^/]+$::' | sort -u | while read -r dir; do
            if [[ -z "${dir}" ]]; then
                continue
            fi
            files=$(printf '%s\n' "${DESTS}" | awk -v d="${dir}/" '
                index($0, d) == 1 {
                    rest = substr($0, length(d) + 1)
                    if (index(rest, "/") == 0) { print rest }
                }')
            n=$(printf '%s' "${files}" | grep -c '^' || true)
            echo "<details><summary><code>${dir}</code> -- ${n} file(s)</summary>"
            echo
            printf '%s\n' "${files}" | sed 's/^/- /'
            echo
            echo "</details>"
        done
    fi
} >>"${SUMMARY_FILE}"
