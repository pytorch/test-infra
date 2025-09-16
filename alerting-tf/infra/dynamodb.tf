resource "aws_dynamodb_table" "alerts_state" {
  name         = "${local.name_prefix}-alerts-state"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "fingerprint"

  attribute {
    name = "fingerprint"
    type = "S"
  }

  # Add attributes for future GSI (even if not creating GSI yet)
  attribute {
    name = "team"
    type = "S"
  }

  attribute {
    name = "last_seen_at"
    type = "S"
  }

  ttl {
    attribute_name = "ttl_expires_at"
    enabled        = true
  }

  tags = var.tags
}