output "launch_template_linux" {
  value = aws_launch_template.linux_runner
}

output "launch_template_windows" {
  value = aws_launch_template.windows_runner
}

output "role_runner" {
  value = aws_iam_role.runner
}

output "role_runner_arn" {
  value = aws_iam_role.runner.arn
}

output "iam_profile_name_runner" {
  value = aws_iam_instance_profile.runner.name
}

output "security_groups_ids_vpcs" {
  value = aws_security_group.runners_sg[*].id
}

output "github_app_client_secret" {
  value = local.github_app_client_secret
}

output "github_app_key_base64" {
  value = local.github_app_key_base64
}

output "launch_template_name_linux" {
  value = aws_launch_template.linux_runner.name
}

output "launch_template_name_linux_nvidia" {
  value = aws_launch_template.linux_runner_nvidia.name
}

output "launch_template_name_windows" {
  value = aws_launch_template.windows_runner.name
}

output "launch_template_version_linux" {
  value = aws_launch_template.linux_runner.latest_version
}

output "launch_template_version_linux_nvidia" {
  value = aws_launch_template.linux_runner_nvidia.latest_version
}

output "launch_template_version_windows" {
  value = aws_launch_template.windows_runner.latest_version
}
