terraform {
  required_version = ">= 1.2"
  required_providers {
    aws = "~> 4.3"
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