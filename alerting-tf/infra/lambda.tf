resource "aws_cloudwatch_log_group" "collector" {
  name              = "/aws/lambda/${local.name_prefix}-collector"
  retention_in_days = 180
  tags              = var.tags
}

data "archive_file" "collector_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambdas/collector/dist"
  output_path = "${path.module}/collector.zip"
}

resource "aws_lambda_function" "collector" {
  function_name = "${local.name_prefix}-collector"
  role          = aws_iam_role.collector_lambda_role.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  filename      = data.archive_file.collector_zip.output_path
  source_code_hash = data.archive_file.collector_zip.output_base64sha256

  environment {
    variables = {
      NODE_OPTIONS      = "--enable-source-maps"
      STATUS_TABLE_NAME = aws_dynamodb_table.alerting_status.name
    }
  }

  tags = var.tags
}

// Use the queue to trigger the collector lambda
resource "aws_lambda_event_source_mapping" "from_sqs" {
  event_source_arn = aws_sqs_queue.alerts.arn
  function_name    = aws_lambda_function.collector.arn
  batch_size       = 10
  maximum_batching_window_in_seconds = 1
  function_response_types = ["ReportBatchItemFailures"]
}

#########################
# Webhook Lambda (Grafana -> SNS)
#########################

resource "aws_cloudwatch_log_group" "webhook_lambda" {
  name              = "/aws/lambda/${local.name_prefix}-external-alerts-webhook"
  retention_in_days = 180
  tags              = var.tags
}

data "archive_file" "webhook_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambdas/external-alerts-webhook/dist"
  output_path = "${path.module}/external-alerts-webhook.zip"
}

resource "aws_iam_role" "webhook_lambda_role" {
  name = "${local.name_prefix}-external-alerts-webhook-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Principal = { Service = "lambda.amazonaws.com" },
        Action   = "sts:AssumeRole"
      }
    ]
  })
  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "webhook_basic_logs" {
  role       = aws_iam_role.webhook_lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy" "webhook_publish_sns" {
  name   = "${local.name_prefix}-external-alerts-webhook-publish-sns"
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Action = ["sns:Publish"],
        Resource = aws_sns_topic.alerts.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "webhook_attach_publish" {
  role       = aws_iam_role.webhook_lambda_role.name
  policy_arn = aws_iam_policy.webhook_publish_sns.arn
}

resource "aws_lambda_function" "external_alerts_webhook" {
  function_name = "${local.name_prefix}-external-alerts-webhook"
  role          = aws_iam_role.webhook_lambda_role.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  filename      = data.archive_file.webhook_zip.output_path
  source_code_hash = data.archive_file.webhook_zip.output_base64sha256

  environment {
    variables = {
      TOPIC_ARN    = aws_sns_topic.alerts.arn
      SHARED_TOKEN = var.webhook_grafana_token
    }
  }

  tags = var.tags
}
