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

resource "aws_sqs_queue_policy" "allow_sns" {
  queue_url = aws_sqs_queue.alerts.id
  policy    = jsonencode({
    Version   = "2012-10-17",
    Statement = [
      {
        Effect    = "Allow",
        Principal = "*",
        Action    = "sqs:SendMessage",
        Resource  = aws_sqs_queue.alerts.arn,
        Condition = {
          ArnEquals = {
            "aws:SourceArn" = aws_sns_topic.alerts.arn
          }
        }
      }
    ]
  })
}
