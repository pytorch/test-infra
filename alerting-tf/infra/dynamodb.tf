resource "aws_dynamodb_table" "alerting_status" {
  name         = "${local.name_prefix}-alerting-status"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  tags = var.tags
}

