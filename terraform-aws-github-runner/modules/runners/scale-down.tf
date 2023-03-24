resource "aws_kms_grant" "scale_down" {
  count             = var.encryption.encrypt ? 1 : 0
  name              = "${var.environment}-scale-down"
  key_id            = var.encryption.kms_key_id
  grantee_principal = aws_iam_role.scale_down.arn
  operations        = ["Decrypt"]

  constraints {
    encryption_context_equals = {
      Environment = var.environment
    }
  }
}

resource "aws_lambda_function" "scale_down" {
  s3_bucket         = var.lambda_s3_bucket != null ? var.lambda_s3_bucket : null
  s3_key            = var.runners_lambda_s3_key != null ? var.runners_lambda_s3_key : null
  s3_object_version = var.runners_lambda_s3_object_version != null ? var.runners_lambda_s3_object_version : null
  filename          = var.lambda_s3_bucket == null ? local.lambda_zip : null
  source_code_hash  = var.lambda_s3_bucket == null ? filebase64sha256(local.lambda_zip) : null
  function_name     = "${var.environment}-scale-down"
  role              = aws_iam_role.scale_down.arn
  handler           = "index.scaleDown"
  runtime           = "nodejs14.x"
  timeout           = var.lambda_timeout_scale_down
  tags              = local.tags
  memory_size       = 2048

  environment {
    variables = {
      AWS_REGION_INSTANCES            = join(",", var.aws_region_instances)
      DATETIME_DEPLOY                 = local.datetime_deploy
      ENABLE_ORGANIZATION_RUNNERS     = var.enable_organization_runners
      ENVIRONMENT                     = var.environment
      GHES_URL                        = var.ghes_url
      GITHUB_APP_CLIENT_ID            = var.github_app.client_id
      GITHUB_APP_CLIENT_SECRET        = local.github_app_client_secret
      GITHUB_APP_ID                   = var.github_app.id
      GITHUB_APP_KEY_BASE64           = local.github_app_key_base64
      KMS_KEY_ID                      = var.encryption.kms_key_id
      LAMBDA_TIMEOUT                  = var.lambda_timeout_scale_down
      MINIMUM_RUNNING_TIME_IN_MINUTES = var.minimum_running_time_in_minutes
      REDIS_ENDPOINT                  = var.redis_endpoint
      REDIS_LOGIN                     = var.redis_login
      SCALE_DOWN_CONFIG               = jsonencode(var.idle_config)
      SECRETSMANAGER_SECRETS_ID       = var.secretsmanager_secrets_id

    }
  }

  vpc_config {
    security_group_ids = concat(
      var.lambda_security_group_ids,
      [aws_security_group.runners_sg[0].id]
    )
    subnet_ids         = var.lambda_subnet_ids
  }
}

resource "aws_cloudwatch_log_group" "scale_down" {
  name              = "/aws/lambda/${aws_lambda_function.scale_down.function_name}"
  retention_in_days = var.logging_retention_in_days
  tags              = var.tags
}

resource "aws_cloudwatch_event_rule" "scale_down" {
  name                = "${var.environment}-scale-down-rule"
  schedule_expression = var.scale_down_schedule_expression
  tags                = var.tags
}

resource "aws_cloudwatch_event_target" "scale_down" {
  rule = aws_cloudwatch_event_rule.scale_down.name
  arn  = aws_lambda_function.scale_down.arn
}

resource "aws_lambda_permission" "scale_down" {
  statement_id  = "AllowExecutionFromCloudWatch"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.scale_down.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.scale_down.arn
}

resource "aws_iam_role" "scale_down" {
  name                 = "${var.environment}-action-scale-down-lambda-role"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume_role_policy.json
  path                 = local.role_path
  permissions_boundary = var.role_permissions_boundary
  tags                 = local.tags
}

resource "aws_iam_role_policy" "scale_down" {
  name   = "${var.environment}-lambda-scale-down-policy"
  role   = aws_iam_role.scale_down.name
  policy = templatefile("${path.module}/policies/lambda-scale-down.json", {
    arn_ssm_parameters = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/${var.environment}-*"
  })
}

resource "aws_iam_role_policy" "scale_down_logging" {
  name = "${var.environment}-lambda-logging"
  role = aws_iam_role.scale_down.name
  policy = templatefile("${path.module}/policies/lambda-cloudwatch.json", {
    log_group_arn = aws_cloudwatch_log_group.scale_down.arn
  })
}

resource "aws_iam_role_policy_attachment" "scale_down_vpc_execution_role" {
  count      = length(var.lambda_subnet_ids) > 0 ? 1 : 0
  role       = aws_iam_role.scale_down.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "scale_down_secretsmanager_access" {
  count = var.secretsmanager_secrets_id != null ? 1 : 0
  role  = aws_iam_role.scale_down.name
  policy = templatefile("${path.module}/policies/lambda-secretsmanager.json", {
    secretsmanager_arn = data.aws_secretsmanager_secret_version.app_creds.arn
  })
}
