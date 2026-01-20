# SSH Domain Name Infrastructure
# Provides domain-based SSH access using Route53 and simplified routing

# DynamoDB table to store domain name -> NodePort mappings
resource "aws_dynamodb_table" "ssh_domain_mappings" {
  name           = "${var.prefix}-ssh-domain-mappings"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "domain_name"

  attribute {
    name = "domain_name"
    type = "S"
  }

  # TTL for automatic cleanup of expired mappings
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  tags = {
    Name        = "${var.prefix}-ssh-domain-mappings"
    Environment = local.current_config.environment
  }
}

# Update Lambda IAM policies to include SSH domain mappings table
resource "aws_iam_role_policy" "reservation_processor_ssh_domain_policy" {
  count = local.effective_domain_name != "" ? 1 : 0
  name  = "${local.workspace_prefix}-reservation-processor-ssh-domain-policy"
  role  = aws_iam_role.reservation_processor_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem"
        ]
        Resource = aws_dynamodb_table.ssh_domain_mappings.arn
      }
    ]
  })
}

resource "aws_iam_role_policy" "reservation_expiry_ssh_domain_policy" {
  count = local.effective_domain_name != "" ? 1 : 0
  name  = "${local.workspace_prefix}-reservation-expiry-ssh-domain-policy"
  role  = aws_iam_role.reservation_expiry_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:DeleteItem"
        ]
        Resource = aws_dynamodb_table.ssh_domain_mappings.arn
      }
    ]
  })
}
