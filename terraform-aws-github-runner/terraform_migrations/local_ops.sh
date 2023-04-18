#!/bin/bash

function move_state() {
    local -r old_module="${1}"
    local -r new_module="${2:-${old_module}}"

    terraform state mv \
        "module.runners.module.runners.${old_module}" \
        "module.runners.module.runners-instances.${new_module}"
}

function validate_module() {
    cd "${1}"
    terraform init
    tflint --module
    terraform validate
    cd -
}

set -ex

# Download the state file from S3 and keep a backup
aws s3 cp s3://pytorch-gha-infra-terraform/runners/terraform.tfstate ./terraform.tfstate
cp -a terraform.tfstate terraform.tfstate.bak.$(date +"%y%m%d%H%M%S")

# Init terraform
terraform init

# Move the state [still in WIP]
move_state aws_kms_ciphertext.github_app_key_base64
move_state aws_kms_ciphertext.github_app_client_secret
move_state aws_cloudwatch_log_group.gh_runners_linux
move_state aws_cloudwatch_log_group.gh_runners_windows
move_state aws_iam_instance_profile.runner
move_state aws_iam_role.runner
move_state aws_iam_role_policy.cloudwatch_linux
move_state aws_iam_role_policy.cloudwatch_linux_nvidia
move_state aws_iam_role_policy.cloudwatch_windows
move_state aws_iam_role_policy.create_tags
move_state aws_iam_role_policy.dist_bucket
move_state aws_iam_role_policy.scale_up
move_state aws_iam_role_policy.ssm_parameters
move_state aws_iam_role_policy_attachment.managed_policies
move_state aws_iam_role_policy_attachment.runner_session_manager_aws_managed
move_state aws_lambda_alias.scale_up_lambda_alias
move_state aws_iam_role.runner
move_state aws_iam_role.runner
move_state aws_iam_role.runner
move_state aws_iam_role.runner
move_state aws_iam_role.runner
move_state aws_iam_role.runner
move_state aws_iam_role.runner
move_state aws_iam_role.runner
move_state aws_iam_role.runner
move_state aws_iam_role.runner
move_state aws_iam_role.runner

# Validate the modules
validate_module "tf-modules/terraform-aws-github-runner/modules/runners/"
validate_module tf-modules/terraform-aws-github-runner/modules/runners-instances/
validate_module tf-modules/terraform-aws-github-runner

# Validate the main module
terraform validate

# Plan changes
terraform plan
