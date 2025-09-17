resource "aws_iam_role" "collector_lambda_role" {
  name = "${local.name_prefix}-collector-lambda-role"
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

resource "aws_iam_role_policy_attachment" "collector_basic_logs" {
  role       = aws_iam_role.collector_lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy" "collector_sqs_consume" {
  name   = "${local.name_prefix}-collector-sqs-consume"
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:ChangeMessageVisibility"
        ],
        Resource = aws_sqs_queue.alerts.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "collector_attach_sqs_consume" {
  role       = aws_iam_role.collector_lambda_role.name
  policy_arn = aws_iam_policy.collector_sqs_consume.arn
}

resource "aws_iam_policy" "collector_dynamodb_write" {
  name   = "${local.name_prefix}-collector-dynamodb-write"
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect   = "Allow",
        Action   = [
          "dynamodb:PutItem",
          "dynamodb:GetItem",
          "dynamodb:UpdateItem"
        ],
        Resource = aws_dynamodb_table.alerts_state.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "collector_attach_dynamodb_write" {
  role       = aws_iam_role.collector_lambda_role.name
  policy_arn = aws_iam_policy.collector_dynamodb_write.arn
}

data "aws_secretsmanager_secret" "github_app_secret" {
  name = "${local.name_prefix}-alerting-app-secrets"
}

resource "aws_iam_policy" "collector_secretsmanager_read" {
  name   = "${local.name_prefix}-collector-secretsmanager-read"
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Action = [
          "secretsmanager:GetSecretValue"
        ],
        Resource = data.aws_secretsmanager_secret.github_app_secret.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "collector_attach_secretsmanager_read" {
  role       = aws_iam_role.collector_lambda_role.name
  policy_arn = aws_iam_policy.collector_secretsmanager_read.arn
}
