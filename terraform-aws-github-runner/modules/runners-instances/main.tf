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
  tags = merge(
    {
      "Environment" = var.environment,
      "Name"        = format("%s-action-runner", var.environment),
    },
    var.tags,
  )
}