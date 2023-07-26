locals {
  runner_log_files_linux = [
    {
      "log_group_name" : "linux_messages",
      "prefix_log_group" : true,
      "file_path" : "/var/log/messages",
      "log_stream_name" : "{instance_id}"
    },
    {
      "log_group_name" : "linux_user_data",
      "prefix_log_group" : true,
      "file_path" : "/var/log/user-data.log",
      "log_stream_name" : "{instance_id}"
    },
    {
      "log_group_name" : "linux_runner",
      "prefix_log_group" : true,
      "file_path" : "/home/ec2-user/actions-runner/_diag/Runner_**.log",
      "log_stream_name" : "{instance_id}"
    }
  ]
  logfiles_linux = var.enable_cloudwatch_agent ? [for l in local.runner_log_files_linux : {
    "log_group_name" : l.prefix_log_group ? "/github-self-hosted-runners/${var.environment}/${l.log_group_name}" : "/${l.log_group_name}"
    "log_stream_name" : l.log_stream_name
    "file_path" : l.file_path
  }] : []

  loggroups_names_linux = distinct([for l in local.logfiles_linux : l.log_group_name])

  runner_log_files_windows = [
    {
      "log_group_name" : "windows_messages",
      "prefix_log_group" : true,
      "file_path" : "/var/log/messages",
      "log_stream_name" : "{instance_id}"
    },
    {
      "log_group_name" : "windows_user_data",
      "prefix_log_group" : true,
      "file_path" : "C:/UserData.log",
      "log_stream_name" : "{instance_id}"
    },
    {
      "log_group_name" : "windows_runner",
      "prefix_log_group" : true,
      "file_path" : "C:/actions-runner/_diag/Runner_*.log",
      "log_stream_name" : "{instance_id}"
    }
  ]
  logfiles_windows = var.enable_cloudwatch_agent ? [for l in local.runner_log_files_windows : {
    "log_group_name" : l.prefix_log_group ? "/github-self-hosted-runners/${var.environment}/${l.log_group_name}" : "/${l.log_group_name}"
    "log_stream_name" : l.log_stream_name
    "file_path" : l.file_path
  }] : []

  loggroups_names_windows = distinct([for l in local.logfiles_windows : l.log_group_name])
}


resource "aws_ssm_parameter" "cloudwatch_agent_config_runner_linux" {
  count = var.enable_cloudwatch_agent ? 1 : 0
  name  = "${var.environment}-cloudwatch_agent_config_runner_linux"
  type  = "String"
  value = jsonencode(
    jsondecode(
      templatefile(
        "${path.module}/templates/cloudwatch_config.json",
        {
          aws_region = var.aws_region
          environment = var.environment
          logfiles = jsonencode(local.logfiles_linux)
          metrics_collected = templatefile("${path.module}/templates/cloudwatch_config_linux.json", {})
        }
      )
    )
  )
  tags = local.tags
}

resource "aws_ssm_parameter" "cloudwatch_agent_config_runner_linux_nvidia" {
  count = var.enable_cloudwatch_agent ? 1 : 0
  name  = "${var.environment}-cloudwatch_agent_config_runner_linux_nvidia"
  type  = "String"
  value = jsonencode(
    jsondecode(
      templatefile(
        "${path.module}/templates/cloudwatch_config.json",
        {
          aws_region = var.aws_region
          environment = var.environment
          logfiles = jsonencode(local.logfiles_linux)
          metrics_collected = templatefile("${path.module}/templates/cloudwatch_config_linux_nvidia.json", {})
        }
      )
    )
  )
  tags = local.tags
}

resource "aws_ssm_parameter" "cloudwatch_agent_config_runner_linux_arm64" {
  count = var.enable_cloudwatch_agent ? 1 : 0
  name  = "${var.environment}-cloudwatch_agent_config_runner_linux_arm64"
  type  = "String"
  value = jsonencode(
    jsondecode(
      templatefile(
        "${path.module}/templates/cloudwatch_config.json",
        {
          aws_region = var.aws_region
          environment = var.environment
          logfiles = jsonencode(local.logfiles_linux)
          metrics_collected = templatefile("${path.module}/templates/cloudwatch_config_linux_arm64.json", {})
        }
      )
    )
  )
  tags = local.tags
}

resource "aws_cloudwatch_log_group" "gh_runners_linux" {
  count             = length(local.loggroups_names_linux)
  name              = local.loggroups_names_linux[count.index]
  retention_in_days = var.logging_retention_in_days
  tags              = local.tags
}

resource "aws_iam_role_policy" "cloudwatch_linux" {
  count = var.enable_ssm_on_runners ? 1 : 0
  name  = "CloudWatchLogginAndMetricsLinux"
  role  = aws_iam_role.runner.name
  policy = templatefile("${path.module}/policies/instance-cloudwatch-policy.json",
    {
      ssm_parameter_arn = aws_ssm_parameter.cloudwatch_agent_config_runner_linux[0].arn
    }
  )
}

resource "aws_iam_role_policy" "cloudwatch_linux_nvidia" {
  count = var.enable_ssm_on_runners ? 1 : 0
  name  = "CloudWatchLogginAndMetricsLinuxNvidia"
  role  = aws_iam_role.runner.name
  policy = templatefile("${path.module}/policies/instance-cloudwatch-policy.json",
    {
      ssm_parameter_arn = aws_ssm_parameter.cloudwatch_agent_config_runner_linux_nvidia[0].arn
    }
  )
}

resource "aws_iam_role_policy" "cloudwatch_linux_arm64" {
  count = var.enable_ssm_on_runners ? 1 : 0
  name  = "CloudWatchLogginAndMetricsLinuxARM64"
  role  = aws_iam_role.runner.name
  policy = templatefile("${path.module}/policies/instance-cloudwatch-policy.json",
    {
      ssm_parameter_arn = aws_ssm_parameter.cloudwatch_agent_config_runner_linux_arm64[0].arn
    }
  )
}

resource "aws_ssm_parameter" "cloudwatch_agent_config_runner_windows" {
  count = var.enable_cloudwatch_agent ? 1 : 0
  name  = "${var.environment}-cloudwatch_agent_config_runner_windows"
  type  = "String"
  value = jsonencode(
    jsondecode(
      templatefile(
        "${path.module}/templates/cloudwatch_config.json",
        {
          aws_region = var.aws_region
          environment = var.environment
          metrics_collected = templatefile("${path.module}/templates/cloudwatch_config_windows.json", {})
          logfiles = jsonencode(local.logfiles_linux)
        }
      )
    )
  )
  tags = local.tags
}

resource "aws_cloudwatch_log_group" "gh_runners_windows" {
  count             = length(local.loggroups_names_windows)
  name              = local.loggroups_names_windows[count.index]
  retention_in_days = var.logging_retention_in_days
  tags              = local.tags
}

resource "aws_iam_role_policy" "cloudwatch_windows" {
  count = var.enable_ssm_on_runners ? 1 : 0
  name  = "CloudWatchLogginAndMetricsWindows"
  role  = aws_iam_role.runner.name
  policy = templatefile("${path.module}/policies/instance-cloudwatch-policy.json",
    {
      ssm_parameter_arn = aws_ssm_parameter.cloudwatch_agent_config_runner_windows[0].arn
    }
  )
}
