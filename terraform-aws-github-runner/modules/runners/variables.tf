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
  description = "The list of vpc_id for aws_region. keys; 'vpc' 'region'"
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

variable "subnet_azs" {
  description = "The relation between subnet and azs. keys; 'subnet' 'az'"
  type        = list(map(string))
  default     = []
}

variable "tags" {
  description = "Map of tags that will be added to created resources. By default resources will be tagged with name and environment."
  type        = map(string)
  default     = {}
}

variable "runner_extra_labels" {
  description = "Extra labels for the runners (GitHub). Separate each label by a comma"
  type        = string
  default     = ""
}

variable "environment" {
  description = "A name that identifies the environment, used as prefix and for tagging."
  type        = string
}

variable "sqs_build_queue" {
  description = "SQS queue to consume accepted build events."
  type = object({
    arn = string
    url = string
  })
}

variable "redis_endpoint" {
  description = "Redis endpoint"
  type        = string
}

variable "redis_login" {
  description = "Redis password"
  type        = string
}

variable "sqs_build_queue_retry" {
  description = "SQS queue to forward messages to retry requests"
  type = object({
    arn = string
    url = string
  })
}

variable "enable_organization_runners" {
  type = bool
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

variable "lambda_timeout_scale_down" {
  description = "Time out for the scale down lambda in seconds."
  type        = number
  default     = 60
}

variable "lambda_timeout_scale_up" {
  description = "Time out for the scale up lambda in seconds."
  type        = number
  default     = 60
}

variable "role_permissions_boundary" {
  description = "Permissions boundary that will be added to the created role for the lambda."
  type        = string
  default     = null
}

variable "encryption" {
  description = "KMS key to encrypted lambda environment secrets. Either provide a key and `encrypt` set to `true`. Or set the key to `null` and encrypt to `false`."
  type = object({
    kms_key_id = string
    encrypt    = bool
  })
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

variable "logging_retention_in_days" {
  description = "Specifies the number of days you want to retain log events for the lambda log group. Possible values are: 0, 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, and 3653."
  type        = number
  default     = 180
}

variable "lambda_s3_bucket" {
  description = "S3 bucket from which to specify lambda functions. This is an alternative to providing local files directly."
  type        = string
  default     = null
}

variable "runners_lambda_s3_key" {
  description = "S3 key for runners lambda function. Required if using S3 bucket to specify lambdas."
  type        = string
  default     = null
}

variable "runners_lambda_s3_object_version" {
  description = "S3 object version for runners lambda function. Useful if S3 versioning is enabled on source bucket."
  type        = string
  default     = null
}

variable "create_service_linked_role_spot" {
  description = "(optional) create the serviced linked role for spot instances that is required by the scale-up lambda."
  type        = bool
  default     = false
}

variable "ghes_url" {
  description = "GitHub Enterprise Server URL. DO NOT SET IF USING PUBLIC GITHUB"
  type        = string
  default     = null
}

variable "lambda_subnet_ids" {
  description = "List of subnets in which the lambda will be launched, the subnets needs to be subnets in the `vpc_ids`."
  type        = list(string)
  default     = []
}

variable "lambda_security_group_ids" {
  description = "List of subnets in which the lambda will be launched, the subnets needs to be subnets in the `vpc_ids`."
  type        = list(string)
  default     = []
}

variable "runners_security_group_ids" {
  description = "Security groups"
  type        = list(string)
  default     = []
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

variable "lambda_zip" {
  description = "File location of the lambda zip file."
  type        = string
}

variable "role_path" {
  description = "The path that will be added to the role, if not set the environment name will be used."
  type        = string
}

variable "github_app_client_secret" {
  description = "GitHub app client secret. Required if using secretsmanager_secrets_id."
  type        = string
}

variable "github_app_key_base64" {
  description = "GitHub app client secret. Required if using secretsmanager_secrets_id."
  type        = string
}

variable "launch_template_name_linux" {
  description = "Name of the launch template to use for linux runners. If not set a launch template will be created."
  type        = string
}

variable "launch_template_name_linux_nvidia" {
  description = "Name of the launch template to use for linux nvidia runners. If not set a launch template will be created."
  type        = string
}

variable "launch_template_name_linux_arm64" {
  description = "Name of the launch template to use for linux arm64 runners. If not set a launch template will be created."
  type        = string
}

variable "launch_template_name_windows" {
  description = "Name of the launch template to use for windows runners. If not set a launch template will be created."
  type        = string
}

variable "launch_template_version_linux" {
  description = "Version of the launch template to use for linux runners. If not set the latest version will be used."
  type        = string
}

variable "launch_template_version_linux_nvidia" {
  description = "Version of the launch template to use for linux nvidia runners. If not set the latest version will be used."
  type        = string
}

variable "launch_template_version_linux_arm64" {
  description = "Version of the launch template to use for linux arm64 runners. If not set the latest version will be used."
  type        = string
}

variable "launch_template_version_windows" {
  description = "Version of the launch template to use for windows runners. If not set the latest version will be used."
  type        = string
}

variable "role_runner_arn" {
  description = "Role to use for the runner. If not set a role will be created."
  type        = string
}
