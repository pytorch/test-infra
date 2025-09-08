resource "aws_sqs_queue" "dlq" {
  name = "${local.name_prefix}-alerts-dlq"

  tags = var.tags
}

resource "aws_sqs_queue" "alerts" {
  name = "${local.name_prefix}-alerts"

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 5
  })

  tags = var.tags
}

data "aws_caller_identity" "current" {}

resource "aws_sqs_queue_policy" "allow_sns" {
  queue_url = aws_sqs_queue.alerts.id
  policy    = jsonencode({
    Version   = "2012-10-17",
    Statement = [
      {
        Effect    = "Allow",
        Principal = { Service = "sns.amazonaws.com" },
        Action    = "sqs:SendMessage",
        Resource  = aws_sqs_queue.alerts.arn,
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          },
          ArnEquals = {
            "aws:SourceArn" = aws_sns_topic.alerts.arn
          }
        }
      }
    ]
  })
}
