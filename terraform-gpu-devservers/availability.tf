# GPU Availability Tracking
# Real-time GPU availability table updated by EventBridge events

# DynamoDB table for tracking GPU availability by type
resource "aws_dynamodb_table" "gpu_availability" {
  name         = "${var.prefix}-gpu-availability"
  billing_mode = "PAY_PER_REQUEST"
  
  hash_key = "gpu_type"

  attribute {
    name = "gpu_type"
    type = "S"
  }

  tags = {
    Name        = "${var.prefix}-gpu-availability"
    Environment = var.environment
  }
}

# Lambda function to update GPU availability table
resource "aws_lambda_function" "availability_updater" {
  filename         = "${path.module}/lambda/availability_updater.zip"
  function_name    = "${var.prefix}-availability-updater"
  role            = aws_iam_role.availability_updater_role.arn
  handler         = "index.handler"
  runtime         = "python3.11"
  timeout         = 60
  source_code_hash = data.archive_file.availability_updater_zip.output_base64sha256

  environment {
    variables = {
      AVAILABILITY_TABLE = aws_dynamodb_table.gpu_availability.name
      SUPPORTED_GPU_TYPES = jsonencode(var.supported_gpu_types)
      EKS_CLUSTER_NAME = aws_eks_cluster.gpu_dev_cluster.name
      REGION = var.aws_region
    }
  }

  depends_on = [
    aws_iam_role_policy.availability_updater_policy,
    aws_cloudwatch_log_group.availability_updater_logs,
    data.archive_file.availability_updater_zip,
  ]

  tags = {
    Name        = "${var.prefix}-availability-updater"
    Environment = var.environment
  }
}

# IAM role for availability updater Lambda
resource "aws_iam_role" "availability_updater_role" {
  name = "${var.prefix}-availability-updater-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name        = "${var.prefix}-availability-updater-role"
    Environment = var.environment
  }
}

# IAM policy for availability updater Lambda
resource "aws_iam_role_policy" "availability_updater_policy" {
  name = "${var.prefix}-availability-updater-policy"
  role = aws_iam_role.availability_updater_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${var.aws_region}:*:*"
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:GetItem"
        ]
        Resource = aws_dynamodb_table.gpu_availability.arn
      },
      {
        Effect = "Allow"
        Action = [
          "autoscaling:DescribeAutoScalingGroups"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "eks:DescribeCluster",
          "eks:ListClusters", 
          "eks:AccessKubernetesApi"
        ]
        Resource = aws_eks_cluster.gpu_dev_cluster.arn
      },
      {
        Effect = "Allow"
        Action = [
          "sts:AssumeRole"
        ]
        Resource = aws_iam_role.eks_cluster_role.arn
      }
    ]
  })
}

# EventBridge rule for ASG capacity changes (launch/terminate)
resource "aws_cloudwatch_event_rule" "asg_capacity_change" {
  name        = "${var.prefix}-asg-capacity-change"
  description = "Trigger when ASG instances launch or terminate to update availability"

  event_pattern = jsonencode({
    source      = ["aws.autoscaling"]
    detail-type = [
      "EC2 Instance Launch Successful",
      "EC2 Instance Terminate Successful"
    ]
    detail = {
      AutoScalingGroupName = [for gpu_type in keys(var.supported_gpu_types) : "${var.prefix}-gpu-nodes-self-managed-${gpu_type}"]
    }
  })

  tags = {
    Name        = "${var.prefix}-asg-capacity-change"
    Environment = var.environment
  }
}

# EventBridge target to trigger availability updater Lambda
resource "aws_cloudwatch_event_target" "availability_updater_target" {
  rule      = aws_cloudwatch_event_rule.asg_capacity_change.name
  target_id = "AvailabilityUpdaterTarget"
  arn       = aws_lambda_function.availability_updater.arn
}

# Permission for EventBridge to invoke availability updater Lambda
resource "aws_lambda_permission" "allow_eventbridge_availability" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.availability_updater.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.asg_capacity_change.arn
}

# CloudWatch log group for availability updater Lambda
resource "aws_cloudwatch_log_group" "availability_updater_logs" {
  name              = "/aws/lambda/${var.prefix}-availability-updater"
  retention_in_days = 14

  tags = {
    Name        = "${var.prefix}-availability-updater-logs"
    Environment = var.environment
  }
}

# Build availability updater Lambda package with dependencies
resource "null_resource" "availability_updater_build" {
  triggers = {
    # Rebuild when source files change
    code_hash = filebase64sha256("${path.module}/lambda/availability_updater/index.py")
    requirements_hash = try(filebase64sha256("${path.module}/lambda/availability_updater/requirements.txt"), "none")
    shared_code_hash = filebase64sha256("${path.module}/lambda/shared/k8s_client.py")
    shared_tracker_hash = filebase64sha256("${path.module}/lambda/shared/k8s_resource_tracker.py")
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -e
      cd ${path.module}/lambda/availability_updater
      echo "Building availability updater Lambda package..."
      rm -rf package *.zip
      mkdir -p package
      
      # Install dependencies if requirements.txt exists
      if [ -f requirements.txt ]; then
        python3 -m pip install --upgrade pip
        python3 -m pip install -r requirements.txt --target package/ --force-reinstall
      fi
      
      # Copy source code and shared modules
      cp index.py package/
      cp -r ../shared package/
      
      # Remove shared module's __pycache__ if it exists
      rm -rf package/shared/__pycache__
      
      echo "Availability updater Lambda package built successfully"
      ls -la package/
    EOT
  }
}

# Archive file for availability updater Lambda deployment
data "archive_file" "availability_updater_zip" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/availability_updater/"
  output_path = "${path.module}/lambda/availability_updater.zip"
  
  depends_on = [null_resource.availability_updater_build]
}

# Output the availability table name for CLI configuration
output "gpu_availability_table_name" {
  description = "DynamoDB table name for GPU availability tracking"
  value       = aws_dynamodb_table.gpu_availability.name
}