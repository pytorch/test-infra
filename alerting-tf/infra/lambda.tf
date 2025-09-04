resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.name_prefix}-alerts-handler"
  retention_in_days = 180
  tags              = var.tags
}

data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/dist"
  output_path = "${path.module}/lambda.zip"
}

resource "aws_lambda_function" "alerts_handler" {
  function_name = "${local.name_prefix}-alerts-handler"
  role          = aws_iam_role.lambda_exec.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  filename      = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256

  environment {
    variables = {
      NODE_OPTIONS      = "--enable-source-maps"
      STATUS_TABLE_NAME = aws_dynamodb_table.alerting_status.name
    }
  }

  tags = var.tags
}

// Use the queue to trigger this lambda
resource "aws_lambda_event_source_mapping" "from_sqs" {
  event_source_arn = aws_sqs_queue.alerts.arn
  function_name    = aws_lambda_function.alerts_handler.arn
  batch_size       = 10
  maximum_batching_window_in_seconds = 1
}
