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
    (
        set -x
        ${AWS} s3 cp ${DRY_RUN_FLAG} \
            --acl public-read \
            --recursive \
            --metadata-directive COPY \
            --exclude '*' \
            --include "*${package_name}-${pytorch_version}${PACKAGE_INCLUDE_SUFFIX:-*}" \
            "${PYTORCH_S3_FROM/\/$//}" \
            "${PYTORCH_S3_TO/\/$//}"
    )
    # ^ We grep for package_name-.*pytorch_version to avoid any situations where domain libraries have
    #   the same version on our S3 buckets

    # After copying, explicitly set SHA256 checksums for wheels that don't have them
    # This ensures checksums are preserved even if --metadata-directive COPY fails to copy them
    if [[ $DRY_RUN = "disabled" ]]; then
        echo "+ Setting SHA256 checksums for copied wheels..."
        dest_prefix="${PYTORCH_S3_TO#s3://pytorch/}"
        dest_prefix="${dest_prefix%/}"

        script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        manage_v2_script="${script_dir}/../../s3_management/manage_v2.py"

        if [[ -f "${manage_v2_script}" ]]; then
            echo "+ Running: python ${manage_v2_script} ${dest_prefix} --set-checksum --package-name ${package_name} --package-version ${pytorch_version}"
            python "${manage_v2_script}" "${dest_prefix}" \
                --set-checksum \
                --package-name "${package_name}" \
                --package-version "${pytorch_version}" || {
                echo "- WARNING: Failed to set SHA256 checksums, but copy succeeded"
            }
        else
            echo "- WARNING: manage_v2.py not found at ${manage_v2_script}, skipping checksum computation"
        fi
    fi
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

    if [[ $DRY_RUN = "enabled" ]]; then
        echo "+ DRY RUN: Would copy matching files from ${PYTORCH_S3_FROM} to R2 ${r2_dest}"
        # List what would be copied
        ${AWS} s3 ls "${PYTORCH_S3_FROM/\/$//}/" --recursive \
            | grep "${package_name}-${pytorch_version}${PACKAGE_INCLUDE_SUFFIX:-}" || true
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

    # List matching files from S3 first (using current OIDC credentials)
    echo "+ Listing matching files from S3..."
    local s3_from_path="${PYTORCH_S3_FROM/\/$//}"
    local file_list="${tmp_dir}/file_list.txt"
    ${AWS} s3 ls "${s3_from_path}/" --recursive \
        | grep "${package_name}-${pytorch_version}${PACKAGE_INCLUDE_SUFFIX:-}" \
        | awk '{print $NF}' > "${file_list}" || true

    local total_files
    total_files=$(wc -l < "${file_list}")
    echo "+ Found ${total_files} files to promote to R2"

    if [[ ${total_files} -eq 0 ]]; then
        echo "+ No matching files found, skipping R2 promotion"
        return 0
    fi

    # Helper to restore S3 credentials
    _restore_s3_creds() {
        export AWS_ACCESS_KEY_ID="${saved_aws_access_key_id}"
        export AWS_SECRET_ACCESS_KEY="${saved_aws_secret_access_key}"
        if [[ -n "${saved_aws_session_token}" ]]; then
            export AWS_SESSION_TOKEN="${saved_aws_session_token}"
        else
            unset AWS_SESSION_TOKEN 2>/dev/null || true
        fi
        if [[ -n "${saved_aws_default_region}" ]]; then
            export AWS_DEFAULT_REGION="${saved_aws_default_region}"
        else
            unset AWS_DEFAULT_REGION 2>/dev/null || true
        fi
    }

    # Helper to switch to R2 credentials
    _set_r2_creds() {
        export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
        export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
        unset AWS_SESSION_TOKEN 2>/dev/null || true
        export AWS_DEFAULT_REGION="auto"
    }

    # Download and upload files one at a time to avoid running out of disk space
    echo "+ Downloading and uploading files to R2 one by one..."
    local file_count=0
    while IFS= read -r s3_key; do
        local filename
        filename=$(basename "${s3_key}")
        local local_file="${tmp_dir}/${filename}"

        # Download single file from S3 (using S3 credentials)
        _restore_s3_creds
        (
            set -x
            ${AWS} s3 cp "${PYTORCH_S3_BUCKET}/${s3_key}" "${local_file}"
        )

        # Compute sha256 checksum
        local sha256
        sha256=$(sha256sum "${local_file}" | awk '{print $1}')

        # Upload to R2
        _set_r2_creds
        (
            set -x
            ${AWS} s3 cp "${local_file}" "${r2_dest/\/$//}/${filename}" \
                --metadata "checksum-sha256=${sha256}" \
                --endpoint-url "${R2_ENDPOINT_URL}"
        )

        # Remove local file to free disk space
        rm -f "${local_file}"

        file_count=$((file_count + 1))
        echo "+ Progress: ${file_count}/${total_files} files uploaded"
    done < "${file_list}"

    echo "+ Uploaded ${file_count} files to R2"

    # Restore original AWS credentials
    _restore_s3_creds
}
