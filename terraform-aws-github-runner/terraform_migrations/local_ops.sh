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

aws s3 cp s3://pytorch-gha-infra-terraform/runners/terraform.tfstate ./terraform.tfstate

terraform init
move_state aws_kms_ciphertext.github_app_key_base64
move_state aws_kms_ciphertext.github_app_client_secret

validate_module "tf-modules/terraform-aws-github-runner/modules/runners/"
validate_module tf-modules/terraform-aws-github-runner/modules/runners-instances/
validate_module tf-modules/terraform-aws-github-runner

terraform validate
terraform plan