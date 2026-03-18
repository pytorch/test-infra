
output "role" {
  value = aws_iam_role.deploy.arn
}

output "boundary" {
  value = aws_iam_policy.boundary.arn
}
