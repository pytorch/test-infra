output "sns_topic_arn" {
  value       = aws_sns_topic.alerts.arn
  description = "SNS topic ARN"
}

output "sqs_queue_url" {
  value       = aws_sqs_queue.alerts.id
  description = "SQS queue URL"
}

output "collector_name" {
  value       = aws_lambda_function.collector.function_name
  description = "Collector Lambda function name"
}


output "status_table_name" {
  value       = aws_dynamodb_table.alerting_status.name
  description = "DynamoDB status table name"
}
