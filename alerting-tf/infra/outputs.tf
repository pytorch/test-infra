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
  value       = aws_dynamodb_table.alerts_state.name
  description = "DynamoDB alerts state table name"
}

output "github_app_secret_id" {
  value       = "${local.name_prefix}-alerting-app-secrets"
  description = "Expected AWS Secrets Manager secret id for the GitHub App credentials"
}
