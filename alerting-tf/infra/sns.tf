resource "aws_sns_topic" "alerts" {
  name = "${local.name_prefix}-alerts"

  tags = var.tags
}

resource "aws_sns_topic_subscription" "alerts_to_sqs" {
  topic_arn                        = aws_sns_topic.alerts.arn
  protocol                         = "sqs"
  endpoint                         = aws_sqs_queue.alerts.arn
  raw_message_delivery             = true
  confirmation_timeout_in_minutes  = 1
}
