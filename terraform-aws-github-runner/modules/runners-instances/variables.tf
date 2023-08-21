variable "aws_region" {
  description = "AWS region."
  type        = string
}

variable "vpc_ids" {
  description = "The list of vpc_id for aws_region. keys; 'vpc' 'region'"
  type        = list(map(string))
}

variable "overrides" {
  description = "This maps provides the possibility to override some defaults. The following attributes are supported: `name_sg` overwrite the `Name` tag for all security groups created by this module. `name_runner_agent_instance` override the `Name` tag for the ec2 instance defined in the auto launch configuration. `name_docker_machine_runners` override the `Name` tag spot instances created by the runner agent."
  type        = map(string)

  default = {
    name_runner = ""
    name_sg     = ""
  }
}

variable "tags" {
  description = "Map of tags that will be added to created resources. By default resources will be tagged with name and environment."
  type        = map(string)
  default     = {}
}

variable "environment" {
  description = "A name that identifies the environment, used as prefix and for tagging."
  type        = string
}

variable "s3_bucket_runner_binaries" {
  type = object({
    arn = string
  })
}

variable "s3_location_runner_binaries_linux" {
  description = "S3 location of runner distribution."
  type        = string
}

variable "s3_location_runner_binaries_linux_arm64" {
  description = "S3 location of runner distribution."
  type        = string
}

variable "s3_location_runner_binaries_windows" {
  description = "S3 location of runner distribution."
  type        = string
}

variable "block_device_mappings" {
  description = "The EC2 instance block device configuration. Takes the following keys: `device_name`, `delete_on_termination`, `volume_type`, `volume_size`, `encrypted`, `iops`"
  type        = map(string)
  default     = {}
}

variable "instance_type" {
  description = "Default instance type for the action runner."
  type        = string
  default     = "m5.large"
}

variable "ami_filter_linux" {
  description = "List of maps used to create the AMI filter for the action runner AMI."
  type        = map(list(string))

  default = {
    name = ["amzn2-ami-hvm-2.*-x86_64-ebs"]
  }
}

variable "ami_filter_linux_arm64" {
  description = "List of maps used to create the AMI filter for the action runner AMI."
  type        = map(list(string))

  default = {
    name = ["amzn2-ami-hvm-2.*-arm64-gp2"]
  }
}

variable "ami_owners_linux_arm64" {
  description = "The list of owners used to select the AMI of linux action runner instances."
  type        = list(string)
  default     = ["amazon"]
}

variable "ami_filter_windows" {
  description = "List of maps used to create the AMI filter for the action runner AMI."
  type        = map(list(string))

  default = {
    name = ["Windows_Server-2019-English-Full-ContainersLatest-*"]
  }
}

variable "ami_owners_linux" {
  description = "The list of owners used to select the AMI of linux action runner instances."
  type        = list(string)
  default     = ["amazon"]
}

variable "ami_owners_windows" {
  description = "The list of owners used to select the AMI of windows action runner instances."
  type        = list(string)
  default     = ["amazon"]
}

variable "userdata_template" {
  description = "Alternative user-data template, replacing the default template. By providing your own user_data you have to take care of installing all required software, including the action runner. Variables userdata_pre/post_install are ignored."
  type        = string
  default     = null
}

variable "userdata_pre_install" {
  description = "User-data script snippet to insert before GitHub acton runner install"
  type        = string
  default     = ""
}

variable "userdata_post_install" {
  description = "User-data script snippet to insert after GitHub acton runner install"
  type        = string
  default     = ""
}

variable "github_app" {
  description = "GitHub app parameters, see your github app. Ensure the key is the base64-encoded `.pem` file (the output of `base64 app.private-key.pem`, not the content of `private-key.pem`)."
  type = object({
    key_base64    = string
    id            = string
    client_id     = string
    client_secret = string
  })
}

variable "role_permissions_boundary" {
  description = "Permissions boundary that will be added to the created role for the lambda."
  type        = string
  default     = null
}

variable "role_path" {
  description = "The path that will be added to the role, if not set the environment name will be used."
  type        = string
  default     = null
}

variable "instance_profile_path" {
  description = "The path that will be added to the instance_profile, if not set the environment name will be used."
  type        = string
  default     = null
}

variable "runner_as_root" {
  description = "Run the action runner under the root user."
  type        = bool
  default     = false
}

variable "encryption" {
  description = "KMS key to encrypted lambda environment secrets. Either provide a key and `encrypt` set to `true`. Or set the key to `null` and encrypt to `false`."
  type = object({
    kms_key_id = string
    encrypt    = bool
  })
}

variable "runner_architecture" {
  description = "The platform architecture of the runner instance_type."
  type        = string
  default     = "x64"
}

variable "logging_retention_in_days" {
  description = "Specifies the number of days you want to retain log events for the lambda log group. Possible values are: 0, 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, and 3653."
  type        = number
  default     = 180
}

variable "enable_ssm_on_runners" {
  description = "Enable to allow access the runner instances for debugging purposes via SSM. Note that this adds additional permissions to the runner instances."
  type        = bool
}

variable "runner_iam_role_managed_policy_arns" {
  description = "Attach AWS or customer-managed IAM policies (by ARN) to the runner IAM role"
  type        = list(string)
  default     = []
}

variable "enable_cloudwatch_agent" {
  description = "Enabling the cloudwatch agent on the ec2 runner instances, the runner contains default config."
  type        = bool
  default     = true
}

variable "ghes_url" {
  description = "GitHub Enterprise Server URL. DO NOT SET IF USING PUBLIC GITHUB"
  type        = string
  default     = null
}

variable "key_name" {
  description = "Key pair name"
  type        = string
  default     = null
}
