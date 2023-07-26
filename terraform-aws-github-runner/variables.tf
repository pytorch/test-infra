variable "aws_region" {
  description = "AWS region."
  type        = string
}

variable "aws_region_instances" {
  description = "AWS region to run EC2 runners."
  default     = []
  type        = list(string)
}

variable "vpc_ids" {
  description = "The list of vpc_id for aws_region. keys: 'vpc' 'region'"
  type        = list(map(string))
}

variable "vpc_cidrs" {
  description = "The list of CIDR for vpcs. Keys 'vpc', 'cidr'"
  type        = list(map(string))
}

variable "vpc_sgs" {
  description = "The list of security group ids for vpc ids. keys: 'vpc', 'sg'"
  type        = list(map(string))
}

variable "subnet_vpc_ids" {
  description = "The relation between subnet and vpcs. keys; 'vpc' 'subnet'"
  type        = list(map(string))
  default     = []
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

variable "enable_organization_runners" {
  type = bool
}

variable "github_app" {
  description = "GitHub app parameters, see your github app. Ensure the key is the base64-encoded `.pem` file (the output of `base64 app.private-key.pem`, not the content of `private-key.pem`)."
  type = object({
    key_base64     = string
    id             = string
    client_id      = string
    client_secret  = string
    webhook_secret = string
  })
}

variable "scale_down_schedule_expression" {
  description = "Scheduler expression to check every x for scale down."
  type        = string
  default     = "cron(*/5 * * * ? *)"
}

variable "minimum_running_time_in_minutes" {
  description = "The time an ec2 action runner should be running at minimum before terminated if non busy."
  type        = number
  default     = 5
}

variable "runner_extra_labels" {
  description = "Extra labels for the runners (GitHub). Separate each label by a comma"
  type        = string
  default     = ""
}

variable "webhook_lambda_zip" {
  description = "File location of the webhook lambda zip file."
  type        = string
  default     = null
}

variable "webhook_lambda_timeout" {
  description = "Time out of the webhook lambda in seconds."
  type        = number
  default     = 10
}

variable "runners_lambda_zip" {
  description = "File location of the lambda zip file for scaling runners."
  type        = string
  default     = null
}

variable "runners_scale_up_sqs_max_retry" {
  description = "max retry count for messages in the scale up sqs."
  type        = number
  default     = 1
}

variable "runners_scale_up_sqs_message_ret_s" {
  description = "scale up SQS message retention timeout (seconds)"
  type        = number
  default     = 7200
}

variable "runners_scale_up_sqs_visibility_timeout" {
  description = "Time out for visibility of messages in the scale up sqs."
  type        = number
  default     = 600
}

variable "runners_scale_up_lambda_timeout" {
  description = "Time out for the scale up lambda in seconds."
  type        = number
  default     = 600
}

variable "runners_scale_down_lambda_timeout" {
  description = "Time out for the scale down lambda in seconds."
  type        = number
  default     = 60
}

variable "runner_binaries_syncer_lambda_zip" {
  description = "File location of the binaries sync lambda zip file."
  type        = string
  default     = null
}

variable "runner_binaries_syncer_lambda_timeout" {
  description = "Time out of the binaries sync lambda in seconds."
  type        = number
  default     = 900
}

variable "role_permissions_boundary" {
  description = "Permissions boundary that will be added to the created roles."
  type        = string
  default     = null
}

variable "role_path" {
  description = "The path that will be added to role path for created roles, if not set the environment name will be used."
  type        = string
  default     = null
}

variable "instance_profile_path" {
  description = "The path that will be added to the instance_profile, if not set the environment name will be used."
  type        = string
  default     = null
}

variable "instance_type" {
  description = "Instance type for the action runner."
  type        = string
  default     = "m5.large"
}

variable "runner_as_root" {
  description = "Run the action runner under the root user."
  type        = bool
  default     = false
}

variable "encrypt_secrets" {
  description = "Encrypt secret variables for lambda's such as secrets and private keys."
  type        = bool
  default     = true
}

variable "manage_kms_key" {
  description = "Let the module manage the KMS key."
  type        = bool
  default     = true
}

variable "kms_key_id" {
  description = "Custom KMS key to encrypted lambda secrets, if not provided and `encrypt_secrets` = `true` a KMS key will be created by the module. Secrets will be encrypted with a context `Environment = var.environment`."
  type        = string
  default     = null
}

variable "userdata_template" {
  description = "Alternative user-data template, replacing the default template. By providing your own user_data you have to take care of installing all required software, including the action runner. Variables userdata_pre/post_install are ignored."
  type        = string
  default     = null
}

variable "userdata_pre_install" {
  type        = string
  default     = ""
  description = "Script to be ran before the GitHub Actions runner is installed on the EC2 instances"
}

variable "userdata_post_install" {
  type        = string
  default     = ""
  description = "Script to be ran after the GitHub Actions runner is installed on the EC2 instances"
}

variable "idle_config" {
  description = "List of time period that can be defined as cron expression to keep a minimum amount of runners active instead of scaling down to 0. By defining this list you can ensure that in time periods that match the cron expression within 5 seconds a runner is kept idle."
  type = list(object({
    cron      = string
    timeZone  = string
    idleCount = number
  }))
  default = []
}

variable "enable_ssm_on_runners" {
  description = "Enable to allow access the runner instances for debugging purposes via SSM. Note that this adds additional permissions to the runner instances."
  type        = bool
  default     = false
}

variable "logging_retention_in_days" {
  description = "Specifies the number of days you want to retain log events for the lambda log group. Possible values are: 0, 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, and 3653."
  type        = number
  default     = 180
}

variable "runner_allow_prerelease_binaries" {
  description = "Allow the runners to update to prerelease binaries."
  type        = bool
  default     = false
}

variable "block_device_mappings" {
  description = "The EC2 instance block device configuration. Takes the following keys: `device_name`, `delete_on_termination`, `volume_type`, `volume_size`, `encrypted`, `iops`"
  type        = map(string)
  default     = {}
}

variable "ami_filter_linux" {
  description = "List of maps used to create the AMI filter for the action runner AMI."
  type        = map(list(string))

  default = {
    name = ["amzn2-ami-hvm-2.*-x86_64-ebs"]
  }
}

variable "ami_filter_windows" {
  description = "List of maps used to create the AMI filter for the action runner AMI."
  type        = map(list(string))

  default = {
    name = ["Windows*2019*"]
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

variable "create_service_linked_role_spot" {
  description = "(optional) create the serviced linked role for spot instances that is required by the scale-up lambda."
  type        = bool
  default     = false
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

variable "nvidia_driveer_install" {
  description = "Preinstall nvidia driver on GPU machines."
  type        = bool
  default     = false
}

variable "ghes_url" {
  description = "GitHub Enterprise Server URL. Example: https://github.internal.co - DO NOT SET IF USING PUBLIC GITHUB"
  type        = string
  default     = null
}

variable "lambda_subnet_ids" {
  description = "List of subnets in which the action runners will be launched, the subnets needs to be subnets in the `vpc_ids`."
  type        = list(string)
  default     = []
}

variable "lambda_security_group_ids" {
  description = "List of subnets in which the action runners will be launched, the subnets needs to be subnets in the `vpc_ids`."
  type        = list(string)
  default     = []
}

variable "key_name" {
  description = "Key pair name"
  type        = string
  default     = null
}

variable "secretsmanager_secrets_id" {
  description = "(optional) ID for secretsmanager secret to use for Github App credentials"
  type        = string
  default     = null
}

variable "scale_up_lambda_concurrency" {
  description = "Number of concurrent instances to run for the scale up lambda"
  type        = number
  default     = 10
}

variable "scale_up_provisioned_concurrent_executions" {
  description = "Number of provisioned concurrent instances to run for the scale up lambda"
  type        = number
  default     = 0
}

variable "must_have_issues_labels" {
  description = "Open issues tagged with labels that must be present so scaleUp will run"
  type        = list(string)
  default     = []
}

variable "cant_have_issues_labels" {
  description = "Open issues tagged with labels that should not be present so scaleUp will run"
  type        = list(string)
  default     = []
}
