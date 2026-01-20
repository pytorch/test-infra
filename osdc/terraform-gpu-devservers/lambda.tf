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
          aws_dynamodb_table.gpu_availability.arn,
          aws_dynamodb_table.disks.arn
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
          "ec2:CreateTags",
          "ec2:DeleteTags"
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
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:DescribeRepositories",
          "ecr:CreateRepository",
          "ecr:GetAuthorizationToken"
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
  memory_size      = 2048 # 2GB memory to prevent out-of-memory crashes
  source_code_hash = null_resource.reservation_processor_build.triggers.code_hash

  environment {
    variables = merge({
      RESERVATIONS_TABLE                 = aws_dynamodb_table.gpu_reservations.name
      AVAILABILITY_TABLE                 = aws_dynamodb_table.gpu_availability.name
      EKS_CLUSTER_NAME                   = aws_eks_cluster.gpu_dev_cluster.name
      REGION                             = local.current_config.aws_region
      MAX_RESERVATION_HOURS              = var.max_reservation_hours
      DEFAULT_TIMEOUT_HOURS              = var.reservation_timeout_hours
      QUEUE_URL                          = aws_sqs_queue.gpu_reservation_queue.url
      AVAILABILITY_UPDATER_FUNCTION_NAME = aws_lambda_function.availability_updater.function_name
      PRIMARY_AVAILABILITY_ZONE          = data.aws_availability_zones.available.names[0]
      GPU_DEV_CONTAINER_IMAGE            = local.latest_image_uri  # Use stable 'latest' tag so pods can restart after OOM
      EFS_SECURITY_GROUP_ID              = aws_security_group.efs_sg.id
      EFS_SUBNET_IDS                     = join(",", concat([aws_subnet.gpu_dev_subnet.id, aws_subnet.gpu_dev_subnet_secondary.id], length(aws_subnet.gpu_dev_subnet_tertiary) > 0 ? [aws_subnet.gpu_dev_subnet_tertiary[0].id] : []))
      CCACHE_SHARED_EFS_ID               = aws_efs_file_system.ccache_shared.id
      ECR_REPOSITORY_URL                 = aws_ecr_repository.gpu_dev_custom_images.repository_url
      ECR_PULL_THROUGH_CACHE_DOCKERHUB   = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${local.current_config.aws_region}.amazonaws.com/dockerhub"
      DOMAIN_NAME                        = local.effective_domain_name
      HOSTED_ZONE_ID                     = local.effective_domain_name != "" ? local.hosted_zone_id : ""
      SSH_DOMAIN_MAPPINGS_TABLE          = local.effective_domain_name != "" ? aws_dynamodb_table.ssh_domain_mappings.name : ""
      SSL_CERTIFICATE_ARN                = local.effective_domain_name != "" ? aws_acm_certificate.wildcard[0].arn : ""
      LAMBDA_VERSION                     = "0.3.5"
      MIN_CLI_VERSION                    = "0.3.5"
      DISK_CONTENTS_BUCKET               = aws_s3_bucket.disk_contents.bucket
    }, local.alb_env_vars)
  }

  depends_on = [
    aws_iam_role_policy.reservation_processor_policy,
    aws_cloudwatch_log_group.reservation_processor_log_group,
    null_resource.reservation_processor_build,
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

# Build Lambda package with dependencies and create zip in one step
resource "null_resource" "reservation_processor_build" {
  triggers = {
    # Rebuild when source files change
    code_hash         = filebase64sha256("${path.module}/lambda/reservation_processor/index.py")
    buildkit_hash     = filebase64sha256("${path.module}/lambda/reservation_processor/buildkit_job.py")
    requirements_hash = filebase64sha256("${path.module}/lambda/reservation_processor/requirements.txt")
    # Exclude Python cache files from hash to avoid spurious rebuilds
    shared_folder_hash = sha256(join("", [for f in fileset("${path.module}/lambda/shared", "**") : filesha256("${path.module}/lambda/shared/${f}") if !can(regex("__pycache__|[.]pyc$", f))]))
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
      cp buildkit_job.py package/
      cp -r ../shared package/

      # Remove shared module's __pycache__ if it exists
      rm -rf package/shared/__pycache__

      echo "Lambda package built successfully"
      ls -la package/

      # Create zip file directly, excluding any existing zip files
      cd package/
      zip -q -r ../reservation_processor_new.zip .
      cd ..

      # Replace old zip file and move to parent lambda directory
      mv reservation_processor_new.zip ../reservation_processor.zip

      # Clean up package folder
      rm -rf package

      echo "Lambda zip created and package folder cleaned up"
    EOT
  }
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