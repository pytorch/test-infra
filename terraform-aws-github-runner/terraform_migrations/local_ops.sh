#!/bin/bash

function move_state() {
    local -r old_module="${1}"
    local -r new_module="${2:-${old_module}}"

    terraform state mv \
        "module.runners.module.runners.${old_module}" \
        "module.runners.module.runners_instances.${new_module}"

    terraform state mv \
        "module.canary_runners.module.runners.${old_module}" \
        "module.canary_runners.module.runners_instances.${new_module}"
}

function validate_module() {
    cd "${1}"
    terraform init
    tflint --module
    terraform validate
    cd -
}

set -ex

# Disables backend
cat <<EOF >backend.tf
# terraform {
#   backend "s3" {
#     bucket = "pytorch-gha-infra-terraform"
#     key    = "runners/terraform.tfstate"
#     region = "us-east-1"
#   }
# }
EOF

# Download the state file from S3 and keep a backup
aws s3 cp s3://pytorch-gha-infra-terraform/runners/terraform.tfstate ./terraform.tfstate
cp -a terraform.tfstate terraform.tfstate.bak.$(date +"%y%m%d%H%M%S")

# Init terraform
terraform init -reconfigure

# Ignore a legacy change that I have no idea if it's safe to destroy
terraform state rm "module.old_runners.module.runners.aws_security_group.runner_sg"

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
move_state aws_iam_role_policy.ssm_parameters
move_state aws_iam_role_policy_attachment.managed_policies
move_state aws_iam_role_policy_attachment.runner_session_manager_aws_managed
move_state aws_launch_template.linux_runner
move_state aws_launch_template.linux_runner_nvidia
move_state aws_launch_template.windows_runner
move_state aws_security_group.runners_sg
move_state aws_ssm_parameter.cloudwatch_agent_config_runner_linux
move_state aws_ssm_parameter.cloudwatch_agent_config_runner_linux_nvidia
move_state aws_ssm_parameter.cloudwatch_agent_config_runner_windows

# Remove the useless intermediate states created by the move
rm -f terraform.tfstate.*.backup

# Validate the modules
validate_module "tf-modules/terraform-aws-github-runner/modules/runners/"
validate_module tf-modules/terraform-aws-github-runner/modules/runners-instances/
validate_module tf-modules/terraform-aws-github-runner

# Validate the main module
terraform validate

# Plan changes
terraform plan
