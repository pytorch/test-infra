resource "aws_kms_grant" "scale_up_chron" {
  count             = var.encryption.encrypt ? (var.retry_scale_up_chron_hud_query_url != "" ? 1 : 0) : 0
  name              = "${var.environment}-scale-up-chron"
  key_id            = var.encryption.kms_key_id
  grantee_principal = aws_iam_role.scale_up_chron[0].arn
  operations        = ["Decrypt"]

  constraints {
    encryption_context_equals = {
      Environment = var.environment
    }
  }
}

resource "aws_lambda_function" "scale_up_chron" {
  count             = var.retry_scale_up_chron_hud_query_url != "" ? 1 : 0
  s3_bucket         = var.lambda_s3_bucket != null ? var.lambda_s3_bucket : null
  s3_key            = var.runners_lambda_s3_key != null ? var.runners_lambda_s3_key : null
  s3_object_version = var.runners_lambda_s3_object_version != null ? var.runners_lambda_s3_object_version : null
  filename          = var.lambda_s3_bucket == null ? local.lambda_zip : null
  source_code_hash  = var.lambda_s3_bucket == null ? filebase64sha256(local.lambda_zip) : null
  function_name     = "${var.environment}-scale-up-chron"
  role              = aws_iam_role.scale_up_chron[0].arn
  handler           = "index.scaleUpChron"
  runtime           = "nodejs20.x"
  timeout           = var.lambda_timeout_scale_up_chron
  tags              = local.tags
  memory_size       = 2048

  # changes should reflect the changes in scale-up.tf
  environment {
    variables = {
      CANT_HAVE_ISSUES_LABELS              = join(",", var.cant_have_issues_labels)
      DATETIME_DEPLOY                      = local.datetime_deploy
      ENABLE_ORGANIZATION_RUNNERS          = var.enable_organization_runners
      ENVIRONMENT                          = var.environment
      GITHUB_APP_CLIENT_ID                 = var.github_app.client_id
      GITHUB_APP_CLIENT_SECRET             = var.github_app_client_secret
      GITHUB_APP_ID                        = var.github_app.id
      GITHUB_APP_KEY_BASE64                = var.github_app_key_base64
      KMS_KEY_ID                           = var.encryption.kms_key_id
      LAMBDA_TIMEOUT                       = var.lambda_timeout_scale_up
      LAUNCH_TEMPLATE_NAME_LINUX           = var.launch_template_name_linux
      LAUNCH_TEMPLATE_NAME_LINUX_ARM64     = var.launch_template_name_linux_arm64
      LAUNCH_TEMPLATE_NAME_LINUX_NVIDIA    = var.launch_template_name_linux_nvidia
      LAUNCH_TEMPLATE_NAME_WINDOWS         = var.launch_template_name_windows
      LAUNCH_TEMPLATE_VERSION_LINUX        = var.launch_template_version_linux
      LAUNCH_TEMPLATE_VERSION_LINUX_ARM64  = var.launch_template_version_linux_arm64
      LAUNCH_TEMPLATE_VERSION_LINUX_NVIDIA = var.launch_template_version_linux_nvidia
      LAUNCH_TEMPLATE_VERSION_WINDOWS      = var.launch_template_version_windows
      MAX_RETRY_SCALEUP_RECORD             = "10"
      MIN_AVAILABLE_RUNNERS                = var.min_available_runners
      MUST_HAVE_ISSUES_LABELS              = join(",", var.must_have_issues_labels)
      REDIS_ENDPOINT                       = var.redis_endpoint
      REDIS_LOGIN                          = var.redis_login
      RETRY_SCALE_UP_RECORD_DELAY_S        = "60"
      RETRY_SCALE_UP_RECORD_JITTER_PCT     = "0.5"
      RETRY_SCALE_UP_CHRON_RECORD_QUEUE_URL      = var.sqs_build_queue_retry.url
      RUNNER_EXTRA_LABELS                  = var.runner_extra_labels
      SCALE_CONFIG_ORG                     = var.scale_config_org
      SCALE_CONFIG_REPO                    = var.scale_config_repo
      SCALE_CONFIG_REPO_PATH               = var.scale_config_repo_path
      SECRETSMANAGER_SECRETS_ID            = var.secretsmanager_secrets_id
      SCALE_UP_CHRON_HUD_QUERY_URL         = var.retry_scale_up_chron_hud_query_url
      SCALE_UP_MIN_QUEUE_TIME_MINUTES      = 30

      AWS_REGIONS_TO_VPC_IDS = join(
        ",",
        sort(distinct([
          for region_vpc in var.vpc_ids :
          format("%s|%s", region_vpc.region, region_vpc.vpc)
        ]))
      )
      VPC_ID_TO_SECURITY_GROUP_IDS = join(
        ",",
        sort(distinct(concat(
          [
            for vpc in var.vpc_ids :
            format(
              "%s|%s",
              vpc.vpc,
              var.runners_security_group_ids[local.vpc_id_to_idx[vpc.vpc]]
            )
          ],
          [
            for vpc_subnet in var.vpc_sgs :
            format("%s|%s", vpc_subnet.vpc, vpc_subnet.sg)
          ]
        )))
      )
      VPC_ID_TO_SUBNET_IDS = join(
        ",",
        sort(distinct([
          for vpc_subnet in var.subnet_vpc_ids :
          format("%s|%s", vpc_subnet.vpc, vpc_subnet.subnet)
        ]))
      )
      SUBNET_ID_TO_AZ = join(
        ",",
        sort(distinct([
          for subnet_az in var.subnet_azs :
          format("%s|%s", subnet_az.subnet, subnet_az.az)
        ]))
      )
    }
  }

  vpc_config {
    security_group_ids = concat(
      var.lambda_security_group_ids,
      [var.runners_security_group_ids[0]]
    )
    subnet_ids = var.lambda_subnet_ids
  }
}

resource "aws_cloudwatch_log_group" "scale_up_chron" {
  count             = var.retry_scale_up_chron_hud_query_url != "" ? 1 : 0
  name              = "/aws/lambda/${aws_lambda_function.scale_up_chron[0].function_name}"
  retention_in_days = var.logging_retention_in_days
  tags              = var.tags
}

resource "aws_cloudwatch_event_rule" "scale_up_chron" {
  count             = var.retry_scale_up_chron_hud_query_url != "" ? 1 : 0
  name                = "${var.environment}-scale-up-chron-rule"
  schedule_expression = var.scale_up_chron_schedule_expression
  tags                = var.tags
}

resource "aws_cloudwatch_event_target" "scale_up_chron" {
  count = var.retry_scale_up_chron_hud_query_url != "" ? 1 : 0
  rule  = aws_cloudwatch_event_rule.scale_up_chron[0].name
  arn   = aws_lambda_function.scale_up_chron[0].arn
}

resource "aws_lambda_permission" "scale_up_chron" {
  count         = var.retry_scale_up_chron_hud_query_url != "" ? 1 : 0
  statement_id  = "AllowExecutionFromCloudWatch"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.scale_up_chron[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.scale_up_chron[0].arn
}

resource "aws_iam_role" "scale_up_chron" {
  count                = var.retry_scale_up_chron_hud_query_url != "" ? 1 : 0
  name                 = "${var.environment}-action-scale-up-chron-lambda-role"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume_role_policy.json
  path                 = local.role_path
  permissions_boundary = var.role_permissions_boundary
  tags                 = local.tags
}

resource "aws_iam_role_policy" "scale_up_chron" {
  count  = var.retry_scale_up_chron_hud_query_url != "" ? 1 : 0
  name   = "${var.environment}-lambda-scale-up-chron-policy"
  role   = aws_iam_role.scale_up_chron[0].name
  policy = templatefile("${path.module}/policies/lambda-scale-up-chron.json", {
    arn_runner_instance_role = var.role_runner_arn
  })
}

resource "aws_iam_role_policy" "scale_up_chron_logging" {
  count  = var.retry_scale_up_chron_hud_query_url != "" ? 1 : 0
  name   = "${var.environment}-lambda-logging"
  role   = aws_iam_role.scale_up_chron[0].name
  policy = templatefile("${path.module}/policies/lambda-cloudwatch.json", {
    log_group_arn = aws_cloudwatch_log_group.scale_up_chron[0].arn
  })
}

resource "aws_iam_role_policy_attachment" "scale_up_chron_vpc_execution_role" {
  count      = length(var.lambda_subnet_ids) > 0 ? (var.retry_scale_up_chron_hud_query_url != "" ? 1 : 0) : 0
  role       = aws_iam_role.scale_up_chron[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "scale_up_chron_secretsmanager_access" {
  count = var.secretsmanager_secrets_id != null ? (var.retry_scale_up_chron_hud_query_url != "" ? 1 : 0) : 0
  role  = aws_iam_role.scale_up_chron[0].name
  policy = templatefile("${path.module}/policies/lambda-secretsmanager.json", {
    secretsmanager_arn = data.aws_secretsmanager_secret_version.app_creds.arn
  })
}
