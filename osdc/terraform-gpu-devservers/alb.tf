# Application Load Balancer for HTTPS Jupyter and SSH access
# Provides centralized access with TLS termination using ACM certificates
# Replaces NodePort-based access for better security (only ALB exposed to internet)

# Security group for ALB
resource "aws_security_group" "alb_sg" {
  count       = local.effective_domain_name != "" ? 1 : 0
  name        = "${local.workspace_prefix}-alb-sg"
  description = "Security group for ALB handling SSH and Jupyter traffic"
  vpc_id      = aws_vpc.gpu_dev_vpc.id

  # HTTPS for Jupyter
  ingress {
    description = "HTTPS from anywhere"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTP for Jupyter (redirect to HTTPS)
  ingress {
    description = "HTTP from anywhere (redirects to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }


  # Allow all outbound
  egress {
    description = "Allow all outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "${var.prefix}-alb-sg"
    Environment = local.current_config.environment
  }
}

# NLB removed - SSH now uses HTTP CONNECT proxy through ALB at ssh.devservers.io

# Application Load Balancer for HTTPS Jupyter access
resource "aws_lb" "jupyter_alb" {
  count              = local.effective_domain_name != "" ? 1 : 0
  name               = substr("${var.prefix}-jupyter-alb", 0, 32)
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb_sg[0].id]

  # Use all subnets for high availability
  subnets = concat(
    [aws_subnet.gpu_dev_subnet.id, aws_subnet.gpu_dev_subnet_secondary.id],
    length(aws_subnet.gpu_dev_subnet_tertiary) > 0 ? [aws_subnet.gpu_dev_subnet_tertiary[0].id] : []
  )

  enable_deletion_protection = false
  enable_http2               = true

  tags = {
    Name        = "${var.prefix}-jupyter-alb"
    Environment = local.current_config.environment
  }
}

# Default target group for ALB (returns 404 for unknown hosts)
resource "aws_lb_target_group" "jupyter_default" {
  count       = local.effective_domain_name != "" ? 1 : 0
  name        = substr("${var.prefix}-jupyter-def", 0, 32)
  port        = 8888
  protocol    = "HTTP"
  vpc_id      = aws_vpc.gpu_dev_vpc.id
  target_type = "instance"

  health_check {
    enabled             = true
    path                = "/health"
    port                = "traffic-port"
    healthy_threshold   = 2
    unhealthy_threshold = 2
    timeout             = 5
    interval            = 30
    matcher             = "200,404"  # 404 is ok for default target
  }

  deregistration_delay = 30

  tags = {
    Name        = "${var.prefix}-jupyter-default-tg"
    Environment = local.current_config.environment
  }
}

# HTTPS listener for Jupyter with SNI-based routing
resource "aws_lb_listener" "jupyter_https" {
  count             = local.effective_domain_name != "" ? 1 : 0
  load_balancer_arn = aws_lb.jupyter_alb[0].arn
  port              = "443"
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.wildcard[0].arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.jupyter_default[0].arn
  }

  depends_on = [aws_acm_certificate_validation.wildcard]
}

# HTTP listener (redirect to HTTPS)
resource "aws_lb_listener" "jupyter_http" {
  count             = local.effective_domain_name != "" ? 1 : 0
  load_balancer_arn = aws_lb.jupyter_alb[0].arn
  port              = "80"
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# SSH target groups and listeners removed - using HTTP CONNECT proxy instead

# DynamoDB table to track target groups (one per reservation)
resource "aws_dynamodb_table" "alb_target_groups" {
  count          = local.effective_domain_name != "" ? 1 : 0
  name           = "${var.prefix}-alb-target-groups"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "reservation_id"

  attribute {
    name = "reservation_id"
    type = "S"
  }

  attribute {
    name = "domain_name"
    type = "S"
  }

  global_secondary_index {
    name            = "domain_name-index"
    hash_key        = "domain_name"
    projection_type = "ALL"
  }

  # TTL for automatic cleanup
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  tags = {
    Name        = "${var.prefix}-alb-target-groups"
    Environment = local.current_config.environment
  }
}

# Update Lambda IAM to manage target groups and listeners
resource "aws_iam_role_policy" "reservation_processor_alb_policy" {
  count = local.effective_domain_name != "" ? 1 : 0
  name  = substr("${var.prefix}-rsvp-alb-policy", 0, 64)
  role  = aws_iam_role.reservation_processor_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "elasticloadbalancing:CreateTargetGroup",
          "elasticloadbalancing:DeleteTargetGroup",
          "elasticloadbalancing:RegisterTargets",
          "elasticloadbalancing:DeregisterTargets",
          "elasticloadbalancing:DescribeTargetGroups",
          "elasticloadbalancing:DescribeTargetHealth",
          "elasticloadbalancing:ModifyTargetGroup",
          "elasticloadbalancing:ModifyTargetGroupAttributes",
          "elasticloadbalancing:CreateRule",
          "elasticloadbalancing:DeleteRule",
          "elasticloadbalancing:DescribeRules",
          "elasticloadbalancing:ModifyRule",
          "elasticloadbalancing:DescribeListeners",
          "elasticloadbalancing:AddTags"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query"
        ]
        Resource = [
          aws_dynamodb_table.alb_target_groups[0].arn,
          "${aws_dynamodb_table.alb_target_groups[0].arn}/index/*"
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy" "reservation_expiry_alb_policy" {
  count = local.effective_domain_name != "" ? 1 : 0
  name  = substr("${var.prefix}-expiry-alb-policy", 0, 64)
  role  = aws_iam_role.reservation_expiry_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "elasticloadbalancing:DeleteTargetGroup",
          "elasticloadbalancing:DeregisterTargets",
          "elasticloadbalancing:DescribeTargetGroups",
          "elasticloadbalancing:DeleteRule",
          "elasticloadbalancing:DescribeRules"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query"
        ]
        Resource = [
          aws_dynamodb_table.alb_target_groups[0].arn,
          "${aws_dynamodb_table.alb_target_groups[0].arn}/index/*"
        ]
      }
    ]
  })
}

# DNS record for SSH proxy endpoint (ssh.devservers.io)
resource "aws_route53_record" "ssh_proxy" {
  count   = local.effective_domain_name != "" ? 1 : 0
  zone_id = local.hosted_zone_id
  name    = "ssh.${local.effective_domain_name}"
  type    = "A"

  alias {
    name                   = aws_lb.jupyter_alb[0].dns_name
    zone_id                = aws_lb.jupyter_alb[0].zone_id
    evaluate_target_health = true
  }
}

# Pass ALB information to Lambda functions
locals {
  alb_env_vars = local.effective_domain_name != "" ? {
    JUPYTER_ALB_ARN            = aws_lb.jupyter_alb[0].arn
    JUPYTER_ALB_LISTENER_ARN   = aws_lb_listener.jupyter_https[0].arn
    ALB_TARGET_GROUPS_TABLE    = aws_dynamodb_table.alb_target_groups[0].name
    ALB_VPC_ID                 = aws_vpc.gpu_dev_vpc.id
    JUPYTER_ALB_DNS            = aws_lb.jupyter_alb[0].dns_name
    SSH_PROXY_ENDPOINT         = "ssh.${local.effective_domain_name}"
  } : {}
}

# Outputs
output "jupyter_alb_dns" {
  description = "DNS name of the Jupyter ALB"
  value       = local.effective_domain_name != "" ? aws_lb.jupyter_alb[0].dns_name : null
}

output "ssh_proxy_endpoint" {
  description = "SSH proxy endpoint for HTTP CONNECT tunneling"
  value       = local.effective_domain_name != "" ? "ssh.${local.effective_domain_name}" : null
}

output "jupyter_access_url" {
  description = "HTTPS URL for accessing Jupyter notebooks"
  value       = local.effective_domain_name != "" ? "https://<subdomain>.${local.effective_domain_name}" : null
}

output "ssh_access_command" {
  description = "SSH command template for accessing servers (with ProxyCommand)"
  value       = local.effective_domain_name != "" ? "ssh -o ProxyCommand='gpu-dev-ssh-proxy %h %p' dev@<subdomain>.${local.effective_domain_name}" : null
}
