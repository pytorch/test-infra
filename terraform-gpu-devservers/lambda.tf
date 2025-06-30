# Lambda function for processing GPU reservation requests

# IAM role for Lambda function
resource "aws_iam_role" "reservation_processor_role" {
  name = "${var.prefix}-reservation-processor-role"

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
    Environment = var.environment
  }
}

# IAM policy for Lambda function
resource "aws_iam_role_policy" "reservation_processor_policy" {
  name = "${var.prefix}-reservation-processor-policy"
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
          aws_dynamodb_table.gpu_servers.arn,
          "${aws_dynamodb_table.gpu_reservations.arn}/index/*",
          "${aws_dynamodb_table.gpu_servers.arn}/index/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "eks:DescribeCluster",
          "eks:ListClusters"
        ]
        Resource = aws_eks_cluster.gpu_dev_cluster.arn
      },
      {
        Effect = "Allow"
        Action = [
          "ec2:DescribeInstances",
          "ec2:DescribeInstanceStatus"
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
  role            = aws_iam_role.reservation_processor_role.arn
  handler         = "index.handler"
  runtime         = "python3.11"
  timeout         = 60

  environment {
    variables = {
      RESERVATIONS_TABLE = aws_dynamodb_table.gpu_reservations.name
      SERVERS_TABLE      = aws_dynamodb_table.gpu_servers.name
      EKS_CLUSTER_NAME   = aws_eks_cluster.gpu_dev_cluster.name
      REGION             = var.aws_region
      MAX_RESERVATION_HOURS = var.max_reservation_hours
      DEFAULT_TIMEOUT_HOURS = var.reservation_timeout_hours
    }
  }

  depends_on = [
    aws_iam_role_policy.reservation_processor_policy,
    aws_cloudwatch_log_group.reservation_processor_log_group,
    data.archive_file.reservation_processor_zip,
  ]

  tags = {
    Name        = "${var.prefix}-reservation-processor"
    Environment = var.environment
  }
}

# CloudWatch Log Group for Lambda
resource "aws_cloudwatch_log_group" "reservation_processor_log_group" {
  name              = "/aws/lambda/${var.prefix}-reservation-processor"
  retention_in_days = 14

  tags = {
    Name        = "${var.prefix}-reservation-processor-logs"
    Environment = var.environment
  }
}

# Create zip file for Lambda deployment
data "archive_file" "reservation_processor_zip" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/reservation_processor"
  output_path = "${path.module}/lambda/reservation_processor.zip"
}

# Lambda event source mapping for SQS
resource "aws_lambda_event_source_mapping" "sqs_trigger" {
  event_source_arn = aws_sqs_queue.gpu_reservation_queue.arn
  function_name    = aws_lambda_function.reservation_processor.arn
  batch_size       = 1
}