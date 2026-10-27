#!/usr/bin/env bash

exit_if_not_on_git_tag() {
    # Have an override for debugging purposes
    if [[ -n "${TEST_WITHOUT_GIT_TAG-}" ]] ;then
        >&2 echo "+ WARN: Continuing without being on a git tag"
        exit 0
    fi
    # Exit if we're not currently on a git tag
    if ! git describe --tags --exact >/dev/null 2>/dev/null; then
        >&2 echo "- ERROR: Attempting to promote on a non-git tag, must have tagged current commit locally first"
        exit 1
    fi
    # Exit if we're currently on an RC
    if git describe --tags | grep "-rc" >/dev/null 2>/dev/null; then
        >&2 echo "- ERROR: Attempting to promote on a non GA git tag, current tag must be a GA tag"
        >&2 echo "         Example: v1.5.0"
        exit 1
    fi
}

get_pytorch_version() {
    if [[ -n "${TEST_WITHOUT_GIT_TAG-}" ]];then
        if  [[ -z "${TEST_PYTORCH_PROMOTE_VERSION-}" ]]; then
            >&2 echo "- ERROR: Specified TEST_WITHOUT_GIT_TAG without specifying TEST_PYTORCH_PROMOTE_VERSION"
            >&2 echo "-        TEST_PYTORCH_PROMOTE_VERSION must be specified"
            exit 1
        else
            echo "${TEST_PYTORCH_PROMOTE_VERSION}"
            exit 0
        fi
    fi
    exit_if_not_on_git_tag
    # Echo git tag, strip leading v
    git describe --tags | sed -e 's/^v//'
}

# PACKAGE_EXCLUDE_TARGETS: comma-separated accelerator folders to leave out of a
# promotion, e.g. "cu130". A target is skipped both as the <target>/ folder and as
# the "+<target>" local version in a file name (torch-2.15.0+cu130-... or
# libtorch-shared-with-deps-2.15.0+cu130.zip). Prints one
# target per line; exits on a name that is not a plain folder name, so a typo cannot
# turn into a pattern that silently matches nothing or too much.
exclude_targets() {
    local raw="${PACKAGE_EXCLUDE_TARGETS:-}"
    # Split on commas with read, not an unquoted expansion: a stray * would be
    # expanded to file names before the check below could reject it.
    local targets=()
    IFS=, read -ra targets <<<"${raw}"
    local target
    for target in ${targets[@]+"${targets[@]}"}; do
        target="${target// /}"
        [[ -z "${target}" ]] && continue
        if [[ ! "${target}" =~ ^[a-z0-9.]+$ ]]; then
            >&2 echo "- ERROR: invalid PACKAGE_EXCLUDE_TARGETS entry '${target}' (expected e.g. cu130)"
            exit 1
        fi
        echo "${target}"
    done
}

aws_promote() {
    package_name=$1
    pytorch_version=$(get_pytorch_version)
    # Dry run by default
    DRY_RUN=${DRY_RUN:-enabled}
    DRY_RUN_FLAG="--dryrun"
    if [[ $DRY_RUN = "disabled" ]]; then
        DRY_RUN_FLAG=""
    fi
    AWS=${AWS:-aws}

    # Validate before anything is copied. Not inside $(...), where exit would only
    # leave the subshell.
    exclude_targets >/dev/null
    local excluded_targets
    excluded_targets=$(exclude_targets | paste -sd, -)
    # Filters apply in order and the last match wins, so these must come after
    # --include to take back what it matched.
    local exclude_args=()
    local target
    for target in $(exclude_targets); do
        exclude_args+=(--exclude "${target}/*" --exclude "*+${target}-*" --exclude "*+${target}.*")
    done

    local cp_args=(
        --acl public-read
        --recursive
        --metadata-directive COPY
        --exclude '*'
        --include "*${package_name}-${pytorch_version}${PACKAGE_INCLUDE_SUFFIX:-*}"
        ${exclude_args[@]+"${exclude_args[@]}"}
        "${PYTORCH_S3_FROM/\/$//}"
        "${PYTORCH_S3_TO/\/$//}"
    )

    # A real run lists every binary first. The dry run below already is that list,
    # so only a real run needs the extra pass. The lines are reworded so the job
    # summary, which counts "copy:" lines, still reports only what was transferred.
    if [[ $DRY_RUN = "disabled" ]]; then
        echo "=== Binaries to promote: ${package_name} ${pytorch_version} (excluded targets: ${excluded_targets:-none}) ==="
        local planned
        planned=$(${AWS} s3 cp --dryrun "${cp_args[@]}" \
            | sed -E 's/^\(dryrun\) copy: (.*) to (.*)$/+ to promote: \1 -> \2/')
        if [[ -n "${planned}" ]]; then
            echo "${planned}"
            echo "=== $(echo "${planned}" | grep -c '^+ to promote: ') binaries to promote ==="
        else
            echo "- WARNING: no binaries match ${package_name}-${pytorch_version}; nothing will be promoted"
        fi
    elif [[ -n "${excluded_targets}" ]]; then
        echo "+ Excluded targets: ${excluded_targets}"
    fi

    (
        set -x
        ${AWS} s3 cp ${DRY_RUN_FLAG} "${cp_args[@]}"
    )
    # ^ We grep for package_name-.*pytorch_version to avoid any situations where domain libraries have
    #   the same version on our S3 buckets
}

aws_set_checksums() {
    # Re-derive SHA256 checksum metadata on the S3 destination wheels.
    # Runs as the final step of promotion so faster operations (S3 copy, R2
    # upload) are not blocked waiting on this download-heavy loop.
    package_name=$1
    pytorch_version=$(get_pytorch_version)
    DRY_RUN=${DRY_RUN:-enabled}

    if [[ $DRY_RUN != "disabled" ]]; then
        echo "+ DRY RUN: skipping SHA256 recomputation for ${package_name}"
        return 0
    fi

    echo "=-=-=-= Setting SHA256 checksums for ${package_name} v${pytorch_version} on S3 =-=-=-="
    dest_prefix="${PYTORCH_S3_TO#s3://pytorch/}"
    dest_prefix="${dest_prefix%/}"

    # manage_v2.py --set-checksum only supports whl and whl/test prefixes
    # (it raises ValueError on anything else). Skip for libtorch/etc.
    case "${dest_prefix}" in
        whl|whl/test) ;;
        *)
            echo "+ Skipping SHA256 recomputation: dest prefix '${dest_prefix}' is not whl/whl-test; manage_v2.py only supports those."
            return 0
            ;;
    esac

    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    manage_v2_script="${script_dir}/../../s3_management/manage_v2.py"

    if [[ ! -f "${manage_v2_script}" ]]; then
        echo "- WARNING: manage_v2.py not found at ${manage_v2_script}, skipping checksum computation"
        return 0
    fi

    echo "+ Running: python ${manage_v2_script} ${dest_prefix} --set-checksum --package-name ${package_name} --package-version ${pytorch_version}"
    python "${manage_v2_script}" "${dest_prefix}" \
        --set-checksum \
        --package-name "${package_name}" \
        --package-version "${pytorch_version}" || {
        echo "- WARNING: Failed to set SHA256 checksums, but copy succeeded"
    }
}

r2_promote() {
    package_name=$1
    pytorch_version=$(get_pytorch_version)

    # Check if R2 credentials are available
    if [[ -z "${R2_ACCOUNT_ID:-}" || -z "${R2_ACCESS_KEY_ID:-}" || -z "${R2_SECRET_ACCESS_KEY:-}" ]]; then
        echo "- WARNING: R2 credentials not configured, skipping R2 promotion"
        return 0
    fi

    DRY_RUN=${DRY_RUN:-enabled}
    AWS=${AWS:-aws}
    R2_ENDPOINT_URL="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
    R2_BUCKET="s3://pytorch-downloads"

    # Map S3 destination path to R2 path
    # S3: s3://pytorch/whl/ -> R2: s3://pytorch-downloads/whl/
    r2_dest="${PYTORCH_S3_TO/s3:\/\/pytorch/${R2_BUCKET}}"

    echo "=-=-=-= Promoting ${package_name} v${pytorch_version} to R2 =-=-=-="
    echo "+ R2 destination: ${r2_dest}"

    # PACKAGE_NAME and PACKAGE_INCLUDE_SUFFIX are consumed as AWS S3 globs by
    # aws_promote (e.g. libtorch-*, *manylinux*). Convert their '*' wildcards
    # into '.*' so the same expressions work as a grep -E regex here.
    local pkg_regex="${package_name//\*/.*}"
    local include_glob="${PACKAGE_INCLUDE_SUFFIX:-*}"
    local include_regex="${include_glob//\*/.*}"
    # Escape the dots, or promoting 2.1 also matches 2.14.
    local version_regex="${pytorch_version//./\\.}"
    local match_pattern="${pkg_regex}-${version_regex}${include_regex}"

    local s3_from_path="${PYTORCH_S3_FROM%/}"
    # Bucket-relative source prefix (e.g. "libtorch/test"), used to preserve the
    # per-arch subfolder layout (cpu/, cu126/, ...) when mapping keys onto R2.
    local s3_from_prefix="${s3_from_path#"${PYTORCH_S3_BUCKET}"/}"
    # A channel directory holds the other channels: whl/ (stable, TO empty) is
    # the parent of whl/nightly/ and whl/test/, so a recursive listing sweeps
    # them in. Harmless with the default FROM=test, but R2_ONLY=true points the
    # source at the destination channel, which turned a 282-file promotion into
    # 15764 -- nearly all of them nightlies already mirrored on R2.
    local sub_channel_exclude="(^|[[:space:]])${s3_from_prefix}/(nightly|test)/"

    # Same exclusions as aws_promote: the <target>/ folder or the "+<target>-" or
    # "+<target>." local version in the file name. Validated here too, since R2_ONLY skips aws_promote.
    exclude_targets >/dev/null
    local target_exclude_regex=""
    local target
    for target in $(exclude_targets); do
        target="${target//./\\.}"
        target_exclude_regex+="${target_exclude_regex:+|}${target}"
    done
    local target_filter=(cat)
    if [[ -n "${target_exclude_regex}" ]]; then
        target_filter=(grep -Ev "(/|\\+)(${target_exclude_regex})(/|-|\\.)")
        echo "+ R2: excluding targets: $(exclude_targets | paste -sd, -)"
    fi

    if [[ $DRY_RUN = "enabled" ]]; then
        echo "+ DRY RUN: Would copy matching files from ${PYTORCH_S3_FROM} to R2 ${r2_dest}"
        # List what would be copied
        ${AWS} s3 ls "${s3_from_path}/" --recursive \
            | grep -E "${match_pattern}" \
            | grep -Ev "${sub_channel_exclude}" \
            | "${target_filter[@]}" || true
        return 0
    fi

    # Save current AWS credentials (OIDC-based for S3)
    local saved_aws_access_key_id="${AWS_ACCESS_KEY_ID:-}"
    local saved_aws_secret_access_key="${AWS_SECRET_ACCESS_KEY:-}"
    local saved_aws_session_token="${AWS_SESSION_TOKEN:-}"
    local saved_aws_default_region="${AWS_DEFAULT_REGION:-}"

    # Create a temporary directory for downloads
    local tmp_dir
    tmp_dir=$(mktemp -d)
    trap "rm -rf ${tmp_dir}" RETURN

    # R2 rate-limits concurrent writes to a single key, and the CLI's default of
    # 10 in-flight multipart parts trips it on the larger wheels. These are s3
    # transfer settings, which the CLI reads only from a config file.
    local r2_aws_config="${tmp_dir}/r2-aws-config"
    cat > "${r2_aws_config}" <<CFG
[default]
s3 =
    max_concurrent_requests = ${R2_MAX_CONCURRENT_REQUESTS:-1}
    multipart_chunksize = ${R2_MULTIPART_CHUNKSIZE:-64MB}
CFG

    # List matching files from S3 first (using current OIDC credentials)
    echo "+ Listing matching files from S3..."
    local file_list="${tmp_dir}/file_list.txt"
    # Largest first. The biggest artifacts (rocm wheels, multi-GB) are the ones
    # that exhaust disk or trip R2's per-object throttle, so promoting them up
    # front surfaces those failures in the first few files instead of after 240.
    # It also front-loads peak disk, so a temp volume that is too small fails
    # immediately rather than most of the way through.
    ${AWS} s3 ls "${s3_from_path}/" --recursive \
        | grep -E "${match_pattern}" \
        | grep -Ev "${sub_channel_exclude}" \
        | "${target_filter[@]}" \
        | sort -k3 -nr \
        | awk '{print $NF}' > "${file_list}" || true

    local total_files
    total_files=$(wc -l < "${file_list}")
    echo "+ Found ${total_files} files to promote to R2"

    if [[ ${total_files} -eq 0 ]]; then
        echo "+ No matching files found, skipping R2 promotion"
        return 0
    fi

    # Promote files concurrently. R2's throttle is per-object -- "reduce your
    # concurrent request rate for the same object" -- so parallelising across
    # distinct keys is safe and recovers the throughput the serialised multipart
    # above gives up. Disk stays bounded: each worker deletes its file as soon as
    # it is uploaded, so peak usage is ~R2_PARALLEL_FILES x the largest wheel.
    local parallel="${R2_PARALLEL_FILES:-4}"
    local fail_dir="${tmp_dir}/failures"
    mkdir -p "${fail_dir}"

    # After a failed upload, say what is at the R2 key now: whether the object
    # was already there, how big it is and when it was last written.
    _r2_object_state() {
        local bucket_key="${1#s3://}"
        (
            export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
            export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
            unset AWS_SESSION_TOKEN
            export AWS_DEFAULT_REGION="auto"
            ${AWS} s3api head-object \
                --bucket "${bucket_key%%/*}" --key "${bucket_key#*/}" \
                --endpoint-url "${R2_ENDPOINT_URL}" \
                --query '[ContentLength, LastModified, ETag]' --output text 2>&1 \
                | sed 's/^/    R2 object now: /'
        ) || true
    }

    # Report one failure as a single write: workers run in parallel, and separate
    # echoes interleave, which detaches the error text from the file it belongs
    # to. The aws CLI can also exit non-zero without writing anything, and an
    # empty block under "FAILED" looks like a lost log, so say so.
    _report_failure() {
        local kind="$1" target="$2" rc="$3" err_log="$4" extra="${5:-}"
        local msg="- FAILED ${kind} (exit ${rc}): ${target}"
        if [[ -s "${err_log}" ]]; then
            msg+=$'\n'"$(sed 's/^/    /' "${err_log}")"
        else
            msg+=$'\n'"    (the aws command printed nothing)"
        fi
        if [[ -n "${extra}" ]]; then
            msg+=$'\n'"${extra}"
        fi
        printf '%s\n' "${msg}" >&2
    }

    # Credentials are applied per subshell rather than exported, so concurrent
    # workers cannot race each other's S3/R2 swap.
    _promote_one_file() {
        local s3_key="$1"
        local filename local_file rel_path r2_target sha256 marker err_log
        # Keyed on the object, not $$ -- $$ is the script's pid and is identical
        # in every background job, so a shared marker collapsed N failures to 1.
        marker="${fail_dir}/${s3_key//\//_}"
        err_log="${marker}.err"
        filename=$(basename "${s3_key}")
        # One directory per key. A wheel is published under several arch folders
        # with the same file name (cu126/, cu128/, ...), so a path built from the
        # file name alone is shared by parallel workers, and the first one to
        # finish deletes the file the others are still uploading.
        mkdir -p "${tmp_dir}/${s3_key//\//_}"
        local_file="${tmp_dir}/${s3_key//\//_}/${filename}"
        rel_path="${s3_key#"${s3_from_prefix}"/}"
        r2_target="${r2_dest%/}/${rel_path}"

        (
            export AWS_ACCESS_KEY_ID="${saved_aws_access_key_id}"
            export AWS_SECRET_ACCESS_KEY="${saved_aws_secret_access_key}"
            if [[ -n "${saved_aws_session_token}" ]]; then
                export AWS_SESSION_TOKEN="${saved_aws_session_token}"
            else
                unset AWS_SESSION_TOKEN
            fi
            if [[ -n "${saved_aws_default_region}" ]]; then
                export AWS_DEFAULT_REGION="${saved_aws_default_region}"
            fi
            ${AWS} s3 cp --quiet "${PYTORCH_S3_BUCKET}/${s3_key}" "${local_file}"
        ) >"${err_log}" 2>&1 || {
            _report_failure download "${PYTORCH_S3_BUCKET}/${s3_key}" "$?" "${err_log}"
            rm -f "${local_file}" "${err_log}"
            touch "${marker}"
            return 1
        }

        sha256=$(sha256sum "${local_file}" | awk '{print $1}')

        (
            export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
            export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
            unset AWS_SESSION_TOKEN
            export AWS_DEFAULT_REGION="auto"
            export AWS_CONFIG_FILE="${r2_aws_config}"
            export AWS_RETRY_MODE=adaptive
            export AWS_MAX_ATTEMPTS="${R2_MAX_ATTEMPTS:-10}"
            ${AWS} s3 cp --quiet "${local_file}" "${r2_target}" \
                --metadata "checksum-sha256=${sha256}" \
                --endpoint-url "${R2_ENDPOINT_URL}"
        ) >"${err_log}" 2>&1 || {
            _report_failure upload "${r2_target}" "$?" "${err_log}" \
                "$(_r2_object_state "${r2_target}")"
            rm -f "${local_file}" "${err_log}"
            touch "${marker}"
            return 1
        }

        rm -f "${local_file}" "${err_log}"
        echo "+ ${PYTORCH_S3_BUCKET}/${s3_key} -> ${r2_target}"
    }

    echo "+ Promoting ${total_files} files to R2, ${parallel} at a time..."
    local file_count=0
    while IFS= read -r s3_key; do
        _promote_one_file "${s3_key}" &
        file_count=$((file_count + 1))
        if (( file_count % parallel == 0 )); then
            wait
            echo "+ Progress: ${file_count}/${total_files}"
        fi
    done < "${file_list}"
    wait

    local failures
    failures=$(find "${fail_dir}" -type f ! -name '*.err' | wc -l)
    if [[ ${failures} -gt 0 ]]; then
        echo "- ERROR: ${failures} file(s) failed to promote to R2"
        return 1
    fi

    echo "+ Uploaded ${file_count} files to R2"
}
