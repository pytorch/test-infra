output "launch_template_linux" {
  value = aws_launch_template.runner_linux
}

output "launch_template_windows" {
  value = aws_launch_template.runner_windows
}

output "role_runner" {
  value = aws_iam_role.runner
}

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
