locals {
  action_runner_distribution_object_key_linux   = "actions-runner-linux-x64.tar.gz"
  action_runner_distribution_object_key_windows = "actions-runner-windows-x64.zip"
}

resource "aws_s3_bucket" "action_dist" {
  bucket        = var.distribution_bucket_name
  acl           = "private"
  force_destroy = true
  tags          = var.tags

  lifecycle_rule {
    enabled                                = true
    abort_incomplete_multipart_upload_days = 7

    transition {
      days          = 35
      storage_class = "INTELLIGENT_TIERING"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "action_dist" {
  bucket                  = aws_s3_bucket.action_dist.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
