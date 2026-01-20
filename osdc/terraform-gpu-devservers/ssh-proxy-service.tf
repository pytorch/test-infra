# SSH HTTP CONNECT Proxy Service
# Runs behind ALB and forwards SSH connections to pod NodePorts

# ECR repository for SSH proxy image
resource "aws_ecr_repository" "ssh_proxy" {
  count = local.effective_domain_name != "" ? 1 : 0
  name  = "${var.prefix}-ssh-proxy"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name        = "${var.prefix}-ssh-proxy"
    Environment = local.current_config.environment
  }
}

# Build and push SSH proxy Docker image
resource "null_resource" "ssh_proxy_build" {
  count = local.effective_domain_name != "" ? 1 : 0

  triggers = {
    proxy_code  = filebase64sha256("${path.module}/ssh-proxy/proxy.py")
    dockerfile  = filebase64sha256("${path.module}/ssh-proxy/Dockerfile")
    requirements = filebase64sha256("${path.module}/ssh-proxy/requirements.txt")
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -e
      cd ${path.module}/ssh-proxy

      # Login to ECR
      aws ecr get-login-password --region ${local.current_config.aws_region} | \
        docker login --username AWS --password-stdin ${data.aws_caller_identity.current.account_id}.dkr.ecr.${local.current_config.aws_region}.amazonaws.com

      # Build image for linux/amd64 (required for ECS Fargate)
      TIMESTAMP=$(date +%Y%m%d-%H%M%S)
      docker build --platform linux/amd64 \
        -t ${aws_ecr_repository.ssh_proxy[0].repository_url}:latest \
        -t ${aws_ecr_repository.ssh_proxy[0].repository_url}:$TIMESTAMP .

      # Push both tags
      docker push ${aws_ecr_repository.ssh_proxy[0].repository_url}:latest
      docker push ${aws_ecr_repository.ssh_proxy[0].repository_url}:$TIMESTAMP

      echo "SSH proxy image built and pushed with tag: $TIMESTAMP"

      echo "SSH proxy image built and pushed successfully"
    EOT
  }

  depends_on = [aws_ecr_repository.ssh_proxy]
}

# ECS cluster for running the SSH proxy
resource "aws_ecs_cluster" "ssh_proxy" {
  count = local.effective_domain_name != "" ? 1 : 0
  name  = "${var.prefix}-ssh-proxy"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Name        = "${var.prefix}-ssh-proxy"
    Environment = local.current_config.environment
  }
}

# CloudWatch log group for SSH proxy
resource "aws_cloudwatch_log_group" "ssh_proxy" {
  count             = local.effective_domain_name != "" ? 1 : 0
  name              = "/ecs/${var.prefix}-ssh-proxy"
  retention_in_days = 7

  tags = {
    Name        = "${var.prefix}-ssh-proxy"
    Environment = local.current_config.environment
  }
}

# ECS task definition
resource "aws_ecs_task_definition" "ssh_proxy" {
  count                    = local.effective_domain_name != "" ? 1 : 0
  family                   = "${var.prefix}-ssh-proxy"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ssh_proxy_execution[0].arn
  task_role_arn            = aws_iam_role.ssh_proxy_task[0].arn

  container_definitions = jsonencode([
    {
      name      = "ssh-proxy"
      image     = "${aws_ecr_repository.ssh_proxy[0].repository_url}:latest"
      essential = true

      portMappings = [
        {
          containerPort = 8080
          protocol      = "tcp"
        },
        {
          containerPort = 8081
          protocol      = "tcp"
        }
      ]

      environment = [
        {
          name  = "SSH_DOMAIN_MAPPINGS_TABLE"
          value = aws_dynamodb_table.ssh_domain_mappings.name
        },
        {
          name  = "PORT"
          value = "8080"
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ssh_proxy[0].name
          "awslogs-region"        = local.current_config.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "python -c 'import urllib.request; urllib.request.urlopen(\"http://localhost:8080/health\")' || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 10
      }
    }
  ])

  tags = {
    Name        = "${var.prefix}-ssh-proxy"
    Environment = local.current_config.environment
  }

  depends_on = [null_resource.ssh_proxy_build]
}

# Security group for SSH proxy ECS tasks
resource "aws_security_group" "ssh_proxy" {
  count       = local.effective_domain_name != "" ? 1 : 0
  name        = "${local.workspace_prefix}-ssh-proxy-sg"
  description = "Security group for SSH proxy ECS tasks"
  vpc_id      = aws_vpc.gpu_dev_vpc.id

  # Allow inbound from ALB (health check on 8080, WebSocket on 8081)
  ingress {
    description     = "HTTP/WebSocket from ALB"
    from_port       = 8080
    to_port         = 8081
    protocol        = "tcp"
    security_groups = [aws_security_group.alb_sg[0].id]
  }

  # Allow outbound to NodePort range (for SSH to pods)
  egress {
    description = "To pod NodePorts"
    from_port   = 30000
    to_port     = 32767
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.gpu_dev_vpc.cidr_block]
  }

  # Allow outbound HTTPS for AWS APIs
  egress {
    description = "HTTPS for AWS APIs"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "${var.prefix}-ssh-proxy-sg"
    Environment = local.current_config.environment
  }
}

# ECS service
resource "aws_ecs_service" "ssh_proxy" {
  count           = local.effective_domain_name != "" ? 1 : 0
  name            = "${var.prefix}-ssh-proxy"
  cluster         = aws_ecs_cluster.ssh_proxy[0].id
  task_definition = aws_ecs_task_definition.ssh_proxy[0].arn
  desired_count   = 2  # Run 2 instances for HA
  launch_type     = "FARGATE"

  network_configuration {
    subnets = concat(
      [aws_subnet.gpu_dev_subnet.id, aws_subnet.gpu_dev_subnet_secondary.id],
      length(aws_subnet.gpu_dev_subnet_tertiary) > 0 ? [aws_subnet.gpu_dev_subnet_tertiary[0].id] : []
    )
    security_groups  = [aws_security_group.ssh_proxy[0].id]
    assign_public_ip = true  # Required for Fargate tasks to reach ECR without NAT
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.ssh_proxy_ws[0].arn
    container_name   = "ssh-proxy"
    container_port   = 8081
  }

  depends_on = [
    aws_lb_listener.jupyter_https,
    null_resource.ssh_proxy_build
  ]

  tags = {
    Name        = "${var.prefix}-ssh-proxy"
    Environment = local.current_config.environment
  }
}

# Target group for SSH proxy
resource "aws_lb_target_group" "ssh_proxy" {
  count       = local.effective_domain_name != "" ? 1 : 0
  name        = substr("${var.prefix}-ssh-proxy", 0, 32)
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = aws_vpc.gpu_dev_vpc.id
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "/health"
    port                = "traffic-port"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher             = "200"
  }

  deregistration_delay = 30

  tags = {
    Name        = "${var.prefix}-ssh-proxy-tg"
    Environment = local.current_config.environment
  }
}

# Target group for SSH proxy WebSocket (port 8081)
resource "aws_lb_target_group" "ssh_proxy_ws" {
  count       = local.effective_domain_name != "" ? 1 : 0
  name        = substr("${var.prefix}-ssh-proxy-ws", 0, 32)
  port        = 8081
  protocol    = "HTTP"
  vpc_id      = aws_vpc.gpu_dev_vpc.id
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "/health"
    port                = "8080"  # Health check on port 8080
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher             = "200"
  }

  deregistration_delay = 30

  tags = {
    Name        = "${var.prefix}-ssh-proxy-ws-tg"
    Environment = local.current_config.environment
  }
}

# ALB listener rule for ssh.devservers.io (WebSocket traffic)
resource "aws_lb_listener_rule" "ssh_proxy" {
  count        = local.effective_domain_name != "" ? 1 : 0
  listener_arn = aws_lb_listener.jupyter_https[0].arn
  priority     = 1  # High priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ssh_proxy_ws[0].arn
  }

  condition {
    host_header {
      values = ["ssh.${local.effective_domain_name}"]
    }
  }

  tags = {
    Name        = "${var.prefix}-ssh-proxy-rule"
    Environment = local.current_config.environment
  }
}

# IAM roles for ECS tasks
resource "aws_iam_role" "ssh_proxy_execution" {
  count = local.effective_domain_name != "" ? 1 : 0
  name  = substr("${local.workspace_prefix}-ssh-proxy-execution", 0, 64)

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name        = "${var.prefix}-ssh-proxy-execution"
    Environment = local.current_config.environment
  }
}

resource "aws_iam_role_policy_attachment" "ssh_proxy_execution" {
  count      = local.effective_domain_name != "" ? 1 : 0
  role       = aws_iam_role.ssh_proxy_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "ssh_proxy_task" {
  count = local.effective_domain_name != "" ? 1 : 0
  name  = substr("${local.workspace_prefix}-ssh-proxy-task", 0, 64)

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name        = "${var.prefix}-ssh-proxy-task"
    Environment = local.current_config.environment
  }
}

# DynamoDB read permission for SSH proxy
resource "aws_iam_role_policy" "ssh_proxy_dynamodb" {
  count = local.effective_domain_name != "" ? 1 : 0
  name  = "dynamodb-access"
  role  = aws_iam_role.ssh_proxy_task[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:Query"
        ]
        Resource = aws_dynamodb_table.ssh_domain_mappings.arn
      }
    ]
  })
}

# Output SSH proxy service info
output "ssh_proxy_service_name" {
  description = "Name of the SSH proxy ECS service"
  value       = local.effective_domain_name != "" ? aws_ecs_service.ssh_proxy[0].name : null
}
