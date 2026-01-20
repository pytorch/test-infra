# S3 bucket for storing disk contents (ls -R output) at snapshot time
# This allows users to view disk contents without mounting the volume

# Random suffix for globally unique bucket name
resource "random_id" "disk_contents_bucket_suffix" {
  byte_length = 4
}

# S3 bucket for disk contents
resource "aws_s3_bucket" "disk_contents" {
  bucket = "${local.workspace_prefix}-disk-contents-${random_id.disk_contents_bucket_suffix.hex}"

  tags = {
    Name        = "${local.workspace_prefix}-disk-contents"
    Environment = local.current_config.environment
    Purpose     = "GPU dev server disk contents storage"
    ManagedBy   = "terraform"
  }
}

# Block public access to disk contents bucket
resource "aws_s3_bucket_public_access_block" "disk_contents" {
  bucket = aws_s3_bucket.disk_contents.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Enable versioning for disk contents (optional, but helpful for recovery)
resource "aws_s3_bucket_versioning" "disk_contents" {
  bucket = aws_s3_bucket.disk_contents.id

  versioning_configuration {
    status = "Enabled"
  }
}

# IAM policy for Lambda to access disk contents bucket
resource "aws_iam_role_policy" "lambda_s3_disk_contents_policy" {
  name = "${local.workspace_prefix}-lambda-s3-disk-contents-policy"
  role = aws_iam_role.reservation_processor_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.disk_contents.arn,
          "${aws_s3_bucket.disk_contents.arn}/*"
        ]
      }
    ]
  })
}

# Output bucket name for reference
output "disk_contents_bucket_name" {
  description = "S3 bucket name for disk contents storage"
  value       = aws_s3_bucket.disk_contents.bucket
}
