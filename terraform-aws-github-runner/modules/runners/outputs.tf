output "lambda_scale_up" {
  value = aws_lambda_function.scale_up
}

output "role_scale_up" {
  value = aws_iam_role.scale_up
}

output "lambda_scale_down" {
  value = aws_lambda_function.scale_down
}

output "role_scale_down" {
  value = aws_iam_role.scale_down
}
