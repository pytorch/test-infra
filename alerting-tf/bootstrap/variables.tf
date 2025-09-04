variable "aws_region" {
  description = "AWS region for backend resources (use us-east-1 for shared backend)"
  type        = string
}

variable "bucket_name" {
  description = "Globally unique S3 bucket name for Terraform state (shared)"
  type        = string
}

variable "env" {
  description = "Environment (dev/prod)"
  type        = string
}