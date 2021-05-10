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
  logfiles_linux = var.enable_cloudwatch_agent ? [for l in var.runner_log_files : {
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
  logfiles_windows = var.enable_cloudwatch_agent ? [for l in var.runner_log_files : {
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
  value = var.cloudwatch_config != null ? var.cloudwatch_config : templatefile("${path.module}/templates/cloudwatch_config.json", {
    logfiles = jsonencode(local.logfiles_linux)
  })
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
  name  = "CloudWatchLogginAndMetrics"
  role  = aws_iam_role.runner.name
  policy = templatefile("${path.module}/policies/instance-cloudwatch-policy.json",
    {
      ssm_parameter_arn = aws_ssm_parameter.cloudwatch_agent_config_runner_linux[0].arn
    }
  )
}


resource "aws_ssm_parameter" "cloudwatch_agent_config_runner_windows" {
  count = var.enable_cloudwatch_agent ? 1 : 0
  name  = "${var.environment}-cloudwatch_agent_config_runner_windows"
  type  = "String"
  value = var.cloudwatch_config != null ? var.cloudwatch_config : templatefile("${path.module}/templates/cloudwatch_config.json", {
    logfiles = jsonencode(local.logfiles_windows)
  })
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
  name  = "CloudWatchLogginAndMetrics"
  role  = aws_iam_role.runner.name
  policy = templatefile("${path.module}/policies/instance-cloudwatch-policy.json",
    {
      ssm_parameter_arn = aws_ssm_parameter.cloudwatch_agent_config_runner_windows[0].arn
    }
  )
}
