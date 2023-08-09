output "bucket" {
  value = aws_s3_bucket.action_dist
}

output "runner_distribution_object_key_linux" {
  value = local.action_runner_distribution_object_key_linux
}

output "runner_distribution_object_key_linux_arm64" {
  value = local.action_runner_distribution_object_key_linux_arm64
}

output "runner_distribution_object_key_windows" {
  value = local.action_runner_distribution_object_key_windows
}

output "lambda" {
  value = aws_lambda_function.syncer
}

output "lambda_role" {
  value = aws_iam_role.syncer_lambda
}

output "distribution_bucket_name" {
  value = aws_s3_bucket.action_dist.bucket
}
