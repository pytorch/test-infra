# SQS Queue and EventBridge setup for reservation system

# SQS Queue for reservation requests (single queue handles all GPU types)
resource "aws_sqs_queue" "gpu_reservation_queue" {
  name                       = "${var.prefix}-reservation-queue"
  visibility_timeout_seconds = 1000
  message_retention_seconds  = var.queue_message_retention
  receive_wait_time_seconds  = 20 # Long polling

  # Configure DLQ - messages will be moved to DLQ after 3 failed attempts
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.gpu_reservation_dlq.arn
    maxReceiveCount     = 3
  })

  tags = {
    Name        = "${var.prefix}-reservation-queue"
    Environment = local.current_config.environment
  }
}

# Dead Letter Queue for failed messages
resource "aws_sqs_queue" "gpu_reservation_dlq" {
  name                      = "${var.prefix}-reservation-dlq"
  message_retention_seconds = var.queue_message_retention

  tags = {
    Name        = "${var.prefix}-reservation-dlq"
    Environment = local.current_config.environment
  }
}

# Queue policy for Lambda access
resource "aws_sqs_queue_policy" "gpu_reservation_queue_policy" {
  queue_url = aws_sqs_queue.gpu_reservation_queue.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowLambdaAccess"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_role.reservation_processor_role.arn
        }
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = aws_sqs_queue.gpu_reservation_queue.arn
      }
    ]
  })
}

// Removed EventBridge SQS trigger to avoid duplicate Lambda invocations.

# DynamoDB table for state management
resource "aws_dynamodb_table" "gpu_reservations" {
  name         = "${var.prefix}-reservations"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "reservation_id"

  attribute {
    name = "reservation_id"
    type = "S"
  }

  attribute {
    name = "user_id"
    type = "S"
  }

  attribute {
    name = "status"
    type = "S"
  }

  attribute {
    name = "gpu_type"
    type = "S"
  }

  global_secondary_index {
    name            = "UserIndex"
    hash_key        = "user_id"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "StatusIndex"
    hash_key        = "status"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "StatusGpuTypeIndex"
    hash_key        = "status"
    range_key       = "gpu_type"
    projection_type = "ALL"
  }


  tags = {
    Name        = "${var.prefix}-reservations"
    Environment = local.current_config.environment
  }
}

# Note: Removed gpu_servers table - now using K8s API for real-time GPU tracking
