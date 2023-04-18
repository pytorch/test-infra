locals {
  instance_profile_path                  = var.instance_profile_path == null ? "/${var.environment}/" : var.instance_profile_path
  name_runner                            = var.overrides["name_runner"] == "" ? local.tags["Name"] : var.overrides["name_runner"]
  role_path                              = var.role_path == null ? "/${var.environment}/" : var.role_path
  userdata_arm_patch                     = "${path.module}/templates/arm-runner-patch.tpl"
  userdata_install_config_runner_linux   = "${path.module}/templates/install-config-runner.sh"
  userdata_install_config_runner_windows = "${path.module}/templates/install-config-runner.ps1"
  userdata_template                      = var.userdata_template == null ? "${path.module}/templates/user-data.sh" : var.userdata_template
  userdata_template_windows              = "${path.module}/templates/user-data.ps1"

  arm_patch = var.runner_architecture == "arm64" ? templatefile(local.userdata_arm_patch, {}) : ""
  install_config_runner_linux = templatefile(local.userdata_install_config_runner_linux, {
    environment                     = var.environment
    s3_location_runner_distribution = var.s3_location_runner_binaries_linux
    run_as_root_user                = var.runner_as_root ? "root" : ""
    arm_patch                       = local.arm_patch
  })
  install_config_runner_windows = templatefile(local.userdata_install_config_runner_windows, {
    environment                     = var.environment
    s3_location_runner_distribution = var.s3_location_runner_binaries_windows
    run_as_root_user                = var.runner_as_root ? "root" : ""
    arm_patch                       = local.arm_patch
  })
}

data "aws_ami" "runner_ami_linux" {
  most_recent = "true"

  dynamic "filter" {
    for_each = var.ami_filter_linux
    content {
      name   = filter.key
      values = filter.value
    }
  }

  owners = var.ami_owners_linux
}

data "aws_ami" "runner_ami_windows" {
  most_recent = "true"

  dynamic "filter" {
    for_each = var.ami_filter_windows
    content {
      name   = filter.key
      values = filter.value
    }
  }

  owners = var.ami_owners_windows
}

resource "aws_launch_template" "linux_runner" {
  name = "${var.environment}-action-linux-runner"

  iam_instance_profile {
    name = aws_iam_instance_profile.runner.name
  }

  instance_initiated_shutdown_behavior = "terminate"

  image_id      = data.aws_ami.runner_ami_linux.id
  instance_type = var.instance_type
  key_name      = var.key_name

  tag_specifications {
    resource_type = "instance"
    tags = merge(
      local.tags,
      {
        "Name"               = format("%s", local.name_runner),
        "InstanceManagement" = "dynamic"
      },
    )
  }

  tag_specifications {
    resource_type = "volume"
    tags = merge(
      local.tags,
      {
        "Name"               = format("%s", local.name_runner)
        "InstanceManagement" = "dynamic"
      },
    )
  }

  user_data = base64encode(templatefile(local.userdata_template, {
    environment                     = var.environment
    pre_install                     = var.userdata_pre_install
    post_install                    = var.userdata_post_install
    enable_cloudwatch_agent         = var.enable_cloudwatch_agent
    ssm_key_cloudwatch_agent_config = var.enable_cloudwatch_agent ? aws_ssm_parameter.cloudwatch_agent_config_runner_linux[0].name : ""
    ghes_url                        = var.ghes_url
    install_config_runner           = local.install_config_runner_linux
  }))

  tags = local.tags
}

resource "aws_launch_template" "linux_runner_nvidia" {
  name = "${var.environment}-action-linux-runner-nvidia"

  iam_instance_profile {
    name = aws_iam_instance_profile.runner.name
  }

  instance_initiated_shutdown_behavior = "terminate"

  image_id      = data.aws_ami.runner_ami_linux.id
  instance_type = var.instance_type
  key_name      = var.key_name

  tag_specifications {
    resource_type = "instance"
    tags = merge(
      local.tags,
      {
        "Name"               = format("%s", local.name_runner)
        "InstanceManagement" = "dynamic"
      },
    )
  }

  tag_specifications {
    resource_type = "volume"
    tags = merge(
      local.tags,
      {
        "Name"               = format("%s", local.name_runner)
        "InstanceManagement" = "dynamic"
      },
    )
  }

  user_data = base64encode(templatefile(local.userdata_template, {
    environment                     = var.environment
    pre_install                     = var.userdata_pre_install
    post_install                    = var.userdata_post_install
    enable_cloudwatch_agent         = var.enable_cloudwatch_agent
    ssm_key_cloudwatch_agent_config = var.enable_cloudwatch_agent ? aws_ssm_parameter.cloudwatch_agent_config_runner_linux_nvidia[0].name : ""
    ghes_url                        = var.ghes_url
    install_config_runner           = local.install_config_runner_linux
  }))

  tags = local.tags
}

resource "aws_launch_template" "windows_runner" {
  name = "${var.environment}-action-windows-runner"

  dynamic "block_device_mappings" {
    for_each = [var.block_device_mappings]
    content {
      device_name = lookup(block_device_mappings.value, "device_name", "/dev/xvda")

      ebs {
        delete_on_termination = lookup(block_device_mappings.value, "delete_on_termination", true)
        volume_type           = lookup(block_device_mappings.value, "volume_type", "gp3")
        volume_size           = lookup(block_device_mappings.value, "volume_size", 30)
        encrypted             = lookup(block_device_mappings.value, "encrypted", true)
        iops                  = lookup(block_device_mappings.value, "iops", null)
      }
    }
  }

  iam_instance_profile {
    name = aws_iam_instance_profile.runner.name
  }

  instance_initiated_shutdown_behavior = "terminate"

  image_id      = data.aws_ami.runner_ami_windows.id
  instance_type = var.instance_type
  key_name      = var.key_name

  tag_specifications {
    resource_type = "instance"
    tags = merge(
      local.tags,
      {
        "Name"               = format("%s", local.name_runner)
        "InstanceManagement" = "dynamic"
      },
    )
  }

  tag_specifications {
    resource_type = "volume"
    tags = merge(
      local.tags,
      {
        "Name"               = format("%s", local.name_runner)
        "InstanceManagement" = "dynamic"
      },
    )
  }

  user_data = base64encode(templatefile(local.userdata_template_windows, {
    environment                     = var.environment
    pre_install                     = var.userdata_pre_install
    post_install                    = var.userdata_post_install
    enable_cloudwatch_agent         = var.enable_cloudwatch_agent
    ssm_key_cloudwatch_agent_config = var.enable_cloudwatch_agent ? aws_ssm_parameter.cloudwatch_agent_config_runner_windows[0].name : ""
    ghes_url                        = var.ghes_url
    install_config_runner           = local.install_config_runner_windows
  }))

  tags = local.tags
}
