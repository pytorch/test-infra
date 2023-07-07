terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.5"
    }
  }
}

locals {
  datetime_deploy = formatdate("YYYYMMDDhhmmss", timestamp())
  lambda_zip      = var.lambda_zip == null ? "${path.module}/lambdas/runners/runners.zip" : var.lambda_zip
  vpc_id_to_idx   = {for idx, vpc in var.vpc_ids: vpc.vpc => idx}
  role_path       = var.role_path == null ? "/${var.environment}/" : var.role_path
    tags = merge(
    {
      "Environment" = var.environment,
      "Name"        = format("%s-action-runner", var.environment),
    },
    var.tags,
  )
}

data "aws_secretsmanager_secret_version" "app_creds" {
  secret_id = var.secretsmanager_secrets_id
}

data "aws_caller_identity" "current" {}
