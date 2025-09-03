# Lambda function for processing GPU reservation requests

# IAM role for Lambda function
resource "aws_iam_role" "reservation_processor_role" {
  name = "${local.workspace_prefix}-reservation-processor-role"

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
    Name        = "${var.prefix}-reservation-processor-role"
    Environment = local.current_config.environment
  }
}

# IAM policy for Lambda function
resource "aws_iam_role_policy" "reservation_processor_policy" {
  name = "${local.workspace_prefix}-reservation-processor-policy"
  role = aws_iam_role.reservation_processor_role.id

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
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:SendMessage"
        ]
        Resource = [
          aws_sqs_queue.gpu_reservation_queue.arn,
          aws_sqs_queue.gpu_reservation_dlq.arn
        ]
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
          "${aws_dynamodb_table.gpu_reservations.arn}/index/*",
          aws_dynamodb_table.gpu_availability.arn
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
          "ec2:CreateVolume",
          "ec2:AttachVolume",
          "ec2:DetachVolume",
          "ec2:DeleteVolume",
          "ec2:CreateSnapshot",
          "ec2:DescribeSnapshots",
          "ec2:DeleteSnapshot",
          "ec2:CreateTags"
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
          "lambda:InvokeFunction"
        ]
        Resource = aws_lambda_function.availability_updater.arn
      },
      {
        Effect = "Allow"
        Action = [
          "elasticfilesystem:CreateFileSystem",
          "elasticfilesystem:DeleteFileSystem",
          "elasticfilesystem:DescribeFileSystems",
          "elasticfilesystem:DescribeFileSystemPolicy",
          "elasticfilesystem:DescribeMountTargets",
          "elasticfilesystem:CreateMountTarget",
          "elasticfilesystem:DeleteMountTarget",
          "elasticfilesystem:DescribeMountTargetSecurityGroups",
          "elasticfilesystem:ModifyMountTargetSecurityGroups",
          "elasticfilesystem:TagResource",
          "elasticfilesystem:UntagResource",
          "elasticfilesystem:ListTagsForResource",
          "ec2:DescribeNetworkInterfaces",
          "ec2:CreateNetworkInterface",
          "ec2:DeleteNetworkInterface",
          "ec2:DescribeSubnets",
          "ec2:DescribeSecurityGroups"
        ]
        Resource = "*"
      }
    ]
  })
}

# Lambda function
resource "aws_lambda_function" "reservation_processor" {
  filename         = "${path.module}/lambda/reservation_processor.zip"
  function_name    = "${var.prefix}-reservation-processor"
  role             = aws_iam_role.reservation_processor_role.arn
  handler          = "index.handler"
  runtime          = "python3.13"
  timeout          = 900 # 15 minutes for K8s operations
  source_code_hash = data.archive_file.reservation_processor_zip.output_base64sha256

  environment {
    variables = {
      RESERVATIONS_TABLE                 = aws_dynamodb_table.gpu_reservations.name
      AVAILABILITY_TABLE                 = aws_dynamodb_table.gpu_availability.name
      EKS_CLUSTER_NAME                   = aws_eks_cluster.gpu_dev_cluster.name
      REGION                             = local.current_config.aws_region
      MAX_RESERVATION_HOURS              = var.max_reservation_hours
      DEFAULT_TIMEOUT_HOURS              = var.reservation_timeout_hours
      QUEUE_URL                          = aws_sqs_queue.gpu_reservation_queue.url
      AVAILABILITY_UPDATER_FUNCTION_NAME = aws_lambda_function.availability_updater.function_name
      PRIMARY_AVAILABILITY_ZONE          = data.aws_availability_zones.available.names[0]
      GPU_DEV_CONTAINER_IMAGE            = local.full_image_uri
      EFS_SECURITY_GROUP_ID              = aws_security_group.efs_sg.id
      EFS_SUBNET_ID                      = aws_subnet.gpu_dev_subnet.id
    }
  }

  depends_on = [
    aws_iam_role_policy.reservation_processor_policy,
    aws_cloudwatch_log_group.reservation_processor_log_group,
    data.archive_file.reservation_processor_zip,
    null_resource.docker_build_and_push,
  ]

  tags = {
    Name        = "${var.prefix}-reservation-processor"
    Environment = local.current_config.environment
  }
}

# CloudWatch Log Group for Lambda
resource "aws_cloudwatch_log_group" "reservation_processor_log_group" {
  name              = "/aws/lambda/${var.prefix}-reservation-processor"
  retention_in_days = 14

  tags = {
    Name        = "${var.prefix}-reservation-processor-logs"
    Environment = local.current_config.environment
  }
}

# Build Lambda package with dependencies
resource "null_resource" "reservation_processor_build" {
  triggers = {
    # Rebuild when source files change
    code_hash           = filebase64sha256("${path.module}/lambda/reservation_processor/index.py")
    requirements_hash   = filebase64sha256("${path.module}/lambda/reservation_processor/requirements.txt")
    shared_code_hash    = filebase64sha256("${path.module}/lambda/shared/k8s_client.py")
    shared_tracker_hash = filebase64sha256("${path.module}/lambda/shared/k8s_resource_tracker.py")
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -e
      cd ${path.module}/lambda/reservation_processor
      echo "Building Lambda package..."
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

      echo "Lambda package built successfully"
      ls -la package/
    EOT
  }
}

# Create zip file for Lambda deployment with dependencies
data "archive_file" "reservation_processor_zip" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/reservation_processor/package"
  output_path = "${path.module}/lambda/reservation_processor.zip"

  depends_on = [null_resource.reservation_processor_build]
}

# Lambda event source mapping for SQS
resource "aws_lambda_event_source_mapping" "sqs_trigger" {
  event_source_arn = aws_sqs_queue.gpu_reservation_queue.arn
  function_name    = aws_lambda_function.reservation_processor.arn
  batch_size       = 1
}

# CloudWatch Event Rule to trigger processor every minute for queue management
resource "aws_cloudwatch_event_rule" "reservation_processor_schedule" {
  name                = "${var.prefix}-reservation-processor-schedule"
  description         = "Trigger reservation processor every minute for queue management and ETA updates"
  schedule_expression = "rate(1 minute)"

  tags = {
    Name        = "${var.prefix}-reservation-processor-schedule"
    Environment = local.current_config.environment
  }
}

# CloudWatch Event Target for processor
resource "aws_cloudwatch_event_target" "reservation_processor_target" {
  rule      = aws_cloudwatch_event_rule.reservation_processor_schedule.name
  target_id = "ReservationProcessorScheduleTarget"
  arn       = aws_lambda_function.reservation_processor.arn
  input = jsonencode({
    source = "cloudwatch.schedule"
    action = "process_queue"
  })
}

# Permission for CloudWatch Events to invoke processor Lambda
resource "aws_lambda_permission" "allow_cloudwatch_processor" {
  statement_id  = "AllowExecutionFromCloudWatchProcessor"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.reservation_processor.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.reservation_processor_schedule.arn
}