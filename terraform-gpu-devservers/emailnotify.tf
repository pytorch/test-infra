# Email notifications for ASG instance launches
# This file can be easily deleted to remove email notifications

# SNS Topic for ASG notifications
resource "aws_sns_topic" "asg_notifications" {
  name = "${var.prefix}-asg-notifications"

  tags = {
    Name        = "${var.prefix}-asg-notifications"
    Environment = var.environment
  }
}

# SNS Topic Policy to allow EventBridge to publish
resource "aws_sns_topic_policy" "asg_notifications_policy" {
  arn = aws_sns_topic.asg_notifications.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowEventBridgeToPublish"
        Effect = "Allow"
        Principal = {
          Service = "events.amazonaws.com"
        }
        Action   = "sns:Publish"
        Resource = aws_sns_topic.asg_notifications.arn
      }
    ]
  })
}

# EventBridge rule for ASG instance launches
resource "aws_cloudwatch_event_rule" "asg_instance_launch" {
  name        = "${var.prefix}-asg-instance-launch"
  description = "Trigger when ASG instances launch successfully"

  event_pattern = jsonencode({
    source      = ["aws.autoscaling"]
    detail-type = ["EC2 Instance Launch Successful"]
    detail = {
      AutoScalingGroupName = [for gpu_type in keys(var.supported_gpu_types) : "${var.prefix}-gpu-nodes-self-managed-${gpu_type}"]
    }
  })

  tags = {
    Name        = "${var.prefix}-asg-instance-launch"
    Environment = var.environment
  }
}

# EventBridge rule for ASG instance terminations (optional)
resource "aws_cloudwatch_event_rule" "asg_instance_terminate" {
  name        = "${var.prefix}-asg-instance-terminate"
  description = "Trigger when ASG instances terminate"

  event_pattern = jsonencode({
    source      = ["aws.autoscaling"]
    detail-type = ["EC2 Instance Terminate Successful"]
    detail = {
      AutoScalingGroupName = [for gpu_type in keys(var.supported_gpu_types) : "${var.prefix}-gpu-nodes-self-managed-${gpu_type}"]
    }
  })

  tags = {
    Name        = "${var.prefix}-asg-instance-terminate"
    Environment = var.environment
  }
}

# EventBridge target to send launch events to SNS
resource "aws_cloudwatch_event_target" "asg_launch_sns_target" {
  rule      = aws_cloudwatch_event_rule.asg_instance_launch.name
  target_id = "ASGLaunchSNSTarget"
  arn       = aws_sns_topic.asg_notifications.arn

  input_transformer {
    input_paths = {
      asg_name    = "$.detail.AutoScalingGroupName"
      instance_id = "$.detail.EC2InstanceId"
      region      = "$.region"
      time        = "$.time"
    }
    input_template = "\"GPU Node Launched!\\n\\nASG: <asg_name>\\nInstance ID: <instance_id>\\nRegion: <region>\\nTime: <time>\\n\\nYour GPU capacity is now available for reservations!\""
  }
}

# EventBridge target to send terminate events to SNS
resource "aws_cloudwatch_event_target" "asg_terminate_sns_target" {
  rule      = aws_cloudwatch_event_rule.asg_instance_terminate.name
  target_id = "ASGTerminateSNSTarget"
  arn       = aws_sns_topic.asg_notifications.arn

  input_transformer {
    input_paths = {
      asg_name    = "$.detail.AutoScalingGroupName"
      instance_id = "$.detail.EC2InstanceId"
      region      = "$.region"
      time        = "$.time"
    }
    input_template = "\"GPU Node Terminated\\n\\nASG: <asg_name>\\nInstance ID: <instance_id>\\nRegion: <region>\\nTime: <time>\\n\\nGPU capacity has been reduced.\""
  }
}

# Output the SNS topic ARN so you can subscribe to it
output "asg_notifications_topic_arn" {
  description = "SNS Topic ARN for ASG notifications - subscribe your email to this"
  value       = aws_sns_topic.asg_notifications.arn
}

output "asg_notifications_subscribe_command" {
  description = "AWS CLI command to subscribe your email to ASG notifications"
  value       = "aws sns subscribe --topic-arn ${aws_sns_topic.asg_notifications.arn} --protocol email --notification-endpoint YOUR_EMAIL@example.com"
}