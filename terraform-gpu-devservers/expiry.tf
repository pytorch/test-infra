# Reservation expiry system
# Handles warning users and cleaning up expired reservations

# Lambda function for expiry management
resource "aws_lambda_function" "reservation_expiry" {
  filename         = "${path.module}/lambda/reservation_expiry.zip"
  function_name    = "${var.prefix}-reservation-expiry"
  role             = aws_iam_role.reservation_expiry_role.arn
  handler          = "index.handler"
  runtime          = "python3.13"
  timeout          = 900 # 15 minutes for K8s operations
  source_code_hash = data.archive_file.reservation_expiry_zip.output_base64sha256

  environment {
    variables = {
      RESERVATIONS_TABLE                 = aws_dynamodb_table.gpu_reservations.name
      EKS_CLUSTER_NAME                   = aws_eks_cluster.gpu_dev_cluster.name
      REGION                             = local.current_config.aws_region
      WARNING_MINUTES                    = "30"  # Warn 30 minutes before expiry
      GRACE_PERIOD_SECONDS               = "120" # 2 minutes grace period after expiry
      AVAILABILITY_UPDATER_FUNCTION_NAME = aws_lambda_function.availability_updater.function_name
    }
  }

  depends_on = [
    aws_iam_role_policy.reservation_expiry_policy,
    data.archive_file.reservation_expiry_zip,
  ]

  tags = {
    Name        = "${var.prefix}-reservation-expiry"
    Environment = local.current_config.environment
  }
}

# IAM role for expiry lambda
resource "aws_iam_role" "reservation_expiry_role" {
  name = "${local.workspace_prefix}-reservation-expiry-role"

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
    Name        = "${var.prefix}-reservation-expiry-role"
    Environment = local.current_config.environment
  }
}

# IAM policy for expiry lambda
resource "aws_iam_role_policy" "reservation_expiry_policy" {
  name = "${local.workspace_prefix}-reservation-expiry-policy"
  role = aws_iam_role.reservation_expiry_role.id

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
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan"
        ]
        Resource = [
          aws_dynamodb_table.gpu_reservations.arn,
          "${aws_dynamodb_table.gpu_reservations.arn}/index/*"
        ]
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
          "ec2:DescribeInstances",
          "ec2:DescribeInstanceStatus",
          "ec2:DescribeVolumes",
          "ec2:CreateSnapshot",
          "ec2:DescribeSnapshots",
          "ec2:DeleteSnapshot"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "sts:AssumeRole"
        ]
        Resource = aws_iam_role.eks_cluster_role.arn
      },
      {
        Effect = "Allow"
        Action = [
          "sns:Publish"
        ]
        Resource = "*" # Could be restricted to specific topic ARN if needed
      },
      {
        Effect = "Allow"
        Action = [
          "lambda:InvokeFunction"
        ]
        Resource = aws_lambda_function.availability_updater.arn
      }
    ]
  })
}

# Build expiry Lambda package with dependencies
resource "null_resource" "reservation_expiry_build" {
  triggers = {
    # Rebuild when source files change
    code_hash           = filebase64sha256("${path.module}/lambda/reservation_expiry/index.py")
    requirements_hash   = filebase64sha256("${path.module}/lambda/reservation_expiry/requirements.txt")
    shared_code_hash    = filebase64sha256("${path.module}/lambda/shared/k8s_client.py")
    shared_tracker_hash = filebase64sha256("${path.module}/lambda/shared/k8s_resource_tracker.py")
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -e
      cd ${path.module}/lambda/reservation_expiry
      echo "Building expiry Lambda package..."
      rm -rf package *.zip
      mkdir -p package
      
      # Install dependencies with specific Python version
      python3 -m pip install --upgrade pip
      python3 -m pip install -r requirements.txt --target package/ --force-reinstall
      
      # Copy source code and shared modules
      cp index.py package/
      cp -r ../shared package/
      
      # Remove shared module's __pycache__ if it exists
      rm -rf package/shared/__pycache__
      
      echo "Expiry Lambda package built successfully"
      ls -la package/
    EOT
  }
}

# Create zip file for expiry lambda with dependencies
data "archive_file" "reservation_expiry_zip" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/reservation_expiry/package"
  output_path = "${path.module}/lambda/reservation_expiry.zip"

  depends_on = [null_resource.reservation_expiry_build]
}

# CloudWatch Event Rule to trigger expiry check every 1 minute
resource "aws_cloudwatch_event_rule" "reservation_expiry_schedule" {
  name                = "${var.prefix}-reservation-expiry-schedule"
  description         = "Trigger reservation expiry check every 1 minute"
  schedule_expression = "rate(1 minute)"

  tags = {
    Name        = "${var.prefix}-reservation-expiry-schedule"
    Environment = local.current_config.environment
  }
}

# CloudWatch Event Target
resource "aws_cloudwatch_event_target" "reservation_expiry_target" {
  rule      = aws_cloudwatch_event_rule.reservation_expiry_schedule.name
  target_id = "ReservationExpiryLambdaTarget"
  arn       = aws_lambda_function.reservation_expiry.arn
}

# Permission for CloudWatch Events to invoke Lambda
resource "aws_lambda_permission" "allow_cloudwatch_expiry" {
  statement_id  = "AllowExecutionFromCloudWatchExpiry"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.reservation_expiry.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.reservation_expiry_schedule.arn
}