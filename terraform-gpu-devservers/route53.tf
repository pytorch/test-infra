# Route53 configuration for domain-based SSH access
# Handles both prod (devservers.io) and test (test.devservers.io) domains

locals {
  # Use workspace config for domain_name if variable is not set, fallback to empty string
  effective_domain_name = var.domain_name != null ? var.domain_name : try(local.current_config.domain_name, "")

  # Determine if we need to create a subdomain hosted zone or use existing
  is_subdomain = local.effective_domain_name != "" && length(split(".", local.effective_domain_name)) > 2
  parent_domain = local.is_subdomain ? join(".", slice(split(".", local.effective_domain_name), 1, length(split(".", local.effective_domain_name)))) : local.effective_domain_name
}

# Data source for existing parent hosted zone (devservers.io)
data "aws_route53_zone" "parent" {
  count        = local.effective_domain_name != "" ? 1 : 0
  name         = local.parent_domain
  private_zone = false
}

# Create subdomain hosted zone if needed (e.g., test.devservers.io)
resource "aws_route53_zone" "subdomain" {
  count = local.is_subdomain ? 1 : 0
  name  = local.effective_domain_name

  tags = {
    Name        = "${var.prefix}-${local.effective_domain_name}-zone"
    Environment = local.current_config.environment
  }
}

# Optional NS delegation for subdomain (can be enabled in prod terraform)
variable "subdomain_ns_records" {
  description = "Name servers for subdomain delegation (e.g., from test environment output)"
  type        = list(string)
  default     = []
}

variable "subdomain_to_delegate" {
  description = "Subdomain to create NS delegation for (e.g., test.devservers.io)"
  type        = string
  default     = ""
}

# Create NS delegation record if provided (typically used in prod to delegate to test)
resource "aws_route53_record" "manual_subdomain_delegation" {
  count   = var.subdomain_to_delegate != "" && length(var.subdomain_ns_records) > 0 && !local.is_subdomain ? 1 : 0
  zone_id = data.aws_route53_zone.parent[0].zone_id
  name    = var.subdomain_to_delegate
  type    = "NS"
  ttl     = 300
  records = var.subdomain_ns_records
}

# Use appropriate hosted zone (subdomain if created, otherwise parent)
locals {
  hosted_zone_id = local.is_subdomain ? aws_route53_zone.subdomain[0].zone_id : (local.effective_domain_name != "" ? data.aws_route53_zone.parent[0].zone_id : "")
  name_servers = local.is_subdomain ? aws_route53_zone.subdomain[0].name_servers : (local.effective_domain_name != "" ? data.aws_route53_zone.parent[0].name_servers : [])
}

# IAM policy for Lambda functions to manage Route53 records
data "aws_iam_policy_document" "route53_policy" {
  count = local.effective_domain_name != "" ? 1 : 0

  statement {
    effect = "Allow"
    actions = [
      "route53:ChangeResourceRecordSets",
      "route53:GetChange",
      "route53:ListResourceRecordSets"
    ]
    resources = [
      local.is_subdomain ? aws_route53_zone.subdomain[0].arn : data.aws_route53_zone.parent[0].arn,
      "arn:aws:route53:::change/*"
    ]
  }
}

resource "aws_iam_policy" "route53_policy" {
  count       = local.effective_domain_name != "" ? 1 : 0
  name        = "${local.workspace_prefix}-route53-policy"
  description = "Policy for Lambda functions to manage Route53 DNS records"
  policy      = data.aws_iam_policy_document.route53_policy[0].json
}

# Attach Route53 policy to existing Lambda execution roles
resource "aws_iam_role_policy_attachment" "reservation_processor_route53" {
  count      = local.effective_domain_name != "" ? 1 : 0
  role       = aws_iam_role.reservation_processor_role.name
  policy_arn = aws_iam_policy.route53_policy[0].arn
}

resource "aws_iam_role_policy_attachment" "reservation_expiry_route53" {
  count      = local.effective_domain_name != "" ? 1 : 0
  role       = aws_iam_role.reservation_expiry_role.name
  policy_arn = aws_iam_policy.route53_policy[0].arn
}

# Output the hosted zone ID and NS records for external DNS setup (only when domain is configured)
output "devservers_hosted_zone_id" {
  description = "The hosted zone ID for the domain"
  value       = local.effective_domain_name != "" ? local.hosted_zone_id : null
}

output "devservers_name_servers" {
  description = "Name servers for the domain zone"
  value       = local.effective_domain_name != "" ? local.name_servers : null
}

output "domain_name" {
  description = "The configured domain name for SSH access"
  value       = local.effective_domain_name != "" ? local.effective_domain_name : "Domain not configured"
}

output "is_subdomain" {
  description = "Whether a subdomain hosted zone was created"
  value       = local.is_subdomain
}

# Enhanced outputs for manual NS delegation
output "subdomain_delegation_instructions" {
  description = "Instructions for setting up subdomain delegation"
  value = local.is_subdomain ? {
    subdomain = local.effective_domain_name
    parent_domain = local.parent_domain
    name_servers = aws_route53_zone.subdomain[0].name_servers
    instructions = "To complete subdomain delegation, add these NS records to your prod terraform:\n\nsubdomain_to_delegate = \"${local.effective_domain_name}\"\nsubdomain_ns_records = ${jsonencode(aws_route53_zone.subdomain[0].name_servers)}"
  } : null
}

# Convenient terraform code output
output "prod_terraform_config" {
  description = "Terraform configuration to add to prod for NS delegation"
  value = local.is_subdomain ? format(<<-EOF
# Add to prod terraform.tfvars:
subdomain_to_delegate = "%s"
subdomain_ns_records = %s
EOF
, local.effective_domain_name, jsonencode(aws_route53_zone.subdomain[0].name_servers)) : null
}

# SSL Certificates for HTTPS services (Jupyter, etc.)
# Creates wildcard certificates with automatic DNS validation

resource "aws_acm_certificate" "wildcard" {
  count             = local.effective_domain_name != "" ? 1 : 0
  domain_name       = "*.${local.effective_domain_name}"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name        = "${var.prefix}-wildcard-cert"
    Environment = local.current_config.environment
    Domain      = local.effective_domain_name
  }
}

# Automatic DNS validation records
resource "aws_route53_record" "cert_validation" {
  for_each = local.effective_domain_name != "" ? {
    for dvo in aws_acm_certificate.wildcard[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = local.hosted_zone_id
}

# Certificate validation waiter
resource "aws_acm_certificate_validation" "wildcard" {
  count           = local.effective_domain_name != "" ? 1 : 0
  certificate_arn = aws_acm_certificate.wildcard[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]

  timeouts {
    create = "10m"
  }
}

# Output certificate information
output "ssl_certificate_arn" {
  description = "ARN of the wildcard SSL certificate"
  value       = local.effective_domain_name != "" ? aws_acm_certificate.wildcard[0].arn : null
}

output "ssl_certificate_domain" {
  description = "Domain covered by the SSL certificate"
  value       = local.effective_domain_name != "" ? "*.${local.effective_domain_name}" : null
}

output "ssl_certificate_status" {
  description = "Status of the SSL certificate"
  value       = local.effective_domain_name != "" ? aws_acm_certificate.wildcard[0].status : null
}