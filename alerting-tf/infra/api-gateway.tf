resource "aws_apigatewayv2_api" "external_alerts_webhook" {
  name          = "${local.name_prefix}-external-alerts-webhook-api"
  protocol_type = "HTTP"
  tags          = var.tags
}

resource "aws_apigatewayv2_integration" "external_alerts_webhook" {
  api_id                 = aws_apigatewayv2_api.external_alerts_webhook.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.external_alerts_webhook.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "external_alerts_webhook" {
  api_id    = aws_apigatewayv2_api.external_alerts_webhook.id
  route_key = "POST /external-alerts-webhook"
  target    = "integrations/${aws_apigatewayv2_integration.external_alerts_webhook.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.external_alerts_webhook.id
  name        = "$default"
  auto_deploy = true
  tags        = var.tags
}

resource "aws_lambda_permission" "allow_apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.external_alerts_webhook.arn
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.external_alerts_webhook.execution_arn}/*/*"
}

output "external_alerts_webhook_url" {
  value       = "${aws_apigatewayv2_api.external_alerts_webhook.api_endpoint}/external-alerts-webhook"
  description = "Public HTTPS URL for external alerts webhook"
}
