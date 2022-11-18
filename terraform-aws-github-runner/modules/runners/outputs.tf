output "launch_template_linux" {
  value = aws_launch_template.linux_runner
}

output "launch_template_windows" {
  value = aws_launch_template.windows_runner
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

output "iam_profile_name_runner" {
  value = aws_iam_instance_profile.runner.name
}
