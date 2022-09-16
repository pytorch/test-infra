output "gateway" {
  value = aws_apigatewayv2_api.webhook
}

output "lambda" {
  value = aws_lambda_function.webhook
}

output "role" {
  value = aws_iam_role.webhook_lambda
}

output "endpoint_relative_path" {
  value = local.webhook_endpoint
}
