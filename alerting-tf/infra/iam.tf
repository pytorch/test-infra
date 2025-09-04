resource "aws_iam_role" "lambda_exec" {
  name = "${local.name_prefix}-alerts-lambda-role"
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

resource "aws_iam_role_policy_attachment" "basic_logs" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy" "sqs_consume" {
  name   = "${local.name_prefix}-alerts-sqs-consume"
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

resource "aws_iam_role_policy_attachment" "attach_sqs_consume" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = aws_iam_policy.sqs_consume.arn
}
