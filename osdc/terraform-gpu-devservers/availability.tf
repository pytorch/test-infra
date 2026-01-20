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
    Environment = local.current_config.environment
  }
}

# Lambda function to update GPU availability table
resource "aws_lambda_function" "availability_updater" {
  filename         = "${path.module}/lambda/availability_updater.zip"
  function_name    = "${var.prefix}-availability-updater"
  role             = aws_iam_role.availability_updater_role.arn
  handler          = "index.handler"
  runtime          = "python3.11"
  timeout          = 300
  source_code_hash = null_resource.availability_updater_build.triggers.code_hash

  environment {
    variables = {
      AVAILABILITY_TABLE  = aws_dynamodb_table.gpu_availability.name
      # Filter out nsight variants - they're counted under base types (h200/b200) via GpuType label mapping
      SUPPORTED_GPU_TYPES = jsonencode({
        for k, v in local.current_config.supported_gpu_types : k => v
        if !endswith(k, "-nsight")
      })
      EKS_CLUSTER_NAME    = aws_eks_cluster.gpu_dev_cluster.name
      REGION              = local.current_config.aws_region
    }
  }

  depends_on = [
    aws_iam_role_policy.availability_updater_policy,
    aws_cloudwatch_log_group.availability_updater_logs,
    null_resource.availability_updater_build,
  ]

  tags = {
    Name        = "${var.prefix}-availability-updater"
    Environment = local.current_config.environment
  }
}

# IAM role for availability updater Lambda
resource "aws_iam_role" "availability_updater_role" {
  name = "${local.workspace_prefix}-availability-updater-role"

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
    Environment = local.current_config.environment
  }
}

# IAM policy for availability updater Lambda
resource "aws_iam_role_policy" "availability_updater_policy" {
  name = "${local.workspace_prefix}-availability-updater-policy"
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
        Resource = "arn:aws:logs:${local.current_config.aws_region}:*:*"
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
    source = ["aws.autoscaling"]
    detail-type = [
      "EC2 Instance Launch Successful",
      "EC2 Instance Terminate Successful"
    ]
    detail = {
      AutoScalingGroupName = [for gpu_type in keys(local.current_config.supported_gpu_types) : "${var.prefix}-gpu-nodes-${gpu_type}"]
    }
  })

  tags = {
    Name        = "${var.prefix}-asg-capacity-change"
    Environment = local.current_config.environment
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

# Scheduled trigger to run availability updater every minute
resource "aws_cloudwatch_event_rule" "availability_updater_schedule" {
  name                = "${var.prefix}-availability-updater-schedule"
  description         = "Trigger availability updater every minute to keep GPU availability current"
  schedule_expression = "rate(1 minute)"
  
  tags = {
    Name        = "${var.prefix}-availability-updater-schedule"
    Environment = local.current_config.environment
  }
}

# EventBridge target for scheduled availability updater
resource "aws_cloudwatch_event_target" "availability_updater_schedule_target" {
  rule      = aws_cloudwatch_event_rule.availability_updater_schedule.name
  target_id = "AvailabilityUpdaterScheduleTarget"
  arn       = aws_lambda_function.availability_updater.arn
}

# Permission for scheduled EventBridge to invoke availability updater Lambda
resource "aws_lambda_permission" "allow_eventbridge_availability_schedule" {
  statement_id  = "AllowExecutionFromScheduledEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.availability_updater.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.availability_updater_schedule.arn
}

# CloudWatch log group for availability updater Lambda
resource "aws_cloudwatch_log_group" "availability_updater_logs" {
  name              = "/aws/lambda/${var.prefix}-availability-updater"
  retention_in_days = 14

  tags = {
    Name        = "${var.prefix}-availability-updater-logs"
    Environment = local.current_config.environment
  }
}

# Build availability updater Lambda package with dependencies and create zip in one step
resource "null_resource" "availability_updater_build" {
  triggers = {
    # Rebuild when source files change
    code_hash         = filebase64sha256("${path.module}/lambda/availability_updater/index.py")
    requirements_hash = try(filebase64sha256("${path.module}/lambda/availability_updater/requirements.txt"), "none")
    shared_folder_hash = sha256(join("", [for f in fileset("${path.module}/lambda/shared", "**") : filesha256("${path.module}/lambda/shared/${f}")]))
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

      # Create zip file directly, excluding any existing zip files
      cd package/
      zip -q -r ../availability_updater_new.zip .
      cd ..

      # Replace old zip file and move to parent lambda directory
      mv availability_updater_new.zip ../availability_updater.zip

      # Clean up package folder
      rm -rf package

      echo "Availability updater Lambda zip created and package folder cleaned up"
    EOT
  }
}


# Output the availability table name for CLI configuration
output "gpu_availability_table_name" {
  description = "DynamoDB table name for GPU availability tracking"
  value       = aws_dynamodb_table.gpu_availability.name
}