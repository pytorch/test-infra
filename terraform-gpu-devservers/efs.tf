# EFS for shared storage between user pods
# Each user gets their own EFS that's mounted at /shared-personal

# EFS file system - one per user, created dynamically by Lambda when first needed
# This is a placeholder to define the security group and mount targets
# Actual EFS filesystems are created by the Lambda function as needed

# Security group for EFS
resource "aws_security_group" "efs_sg" {
  name        = "${var.prefix}-efs-sg"
  description = "Security group for EFS shared storage"
  vpc_id      = aws_vpc.gpu_dev_vpc.id

  # NFS traffic from pods
  ingress {
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.gpu_dev_sg.id]
    description     = "NFS access from GPU dev pods"
  }

  # All outbound traffic
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "${var.prefix}-efs-sg"
    Environment = local.current_config.environment
  }
}

# IAM role for Lambda to manage EFS
resource "aws_iam_role_policy" "lambda_efs_policy" {
  name = "${local.workspace_prefix}-lambda-efs-policy"
  role = aws_iam_role.reservation_processor_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "elasticfilesystem:CreateFileSystem",
          "elasticfilesystem:DeleteFileSystem",
          "elasticfilesystem:DescribeFileSystems",
          "elasticfilesystem:CreateMountTarget",
          "elasticfilesystem:DescribeMountTargets",
          "elasticfilesystem:DeleteMountTarget",
          "elasticfilesystem:CreateTags",
          "elasticfilesystem:DescribeTags",
          "elasticfilesystem:PutFileSystemPolicy",
          "elasticfilesystem:PutLifecycleConfiguration",
          "elasticfilesystem:DescribeLifecycleConfiguration"
        ]
        Resource = "*"
      }
    ]
  })
}

# Output EFS security group ID for Lambda to use
output "efs_security_group_id" {
  description = "Security group ID for EFS"
  value       = aws_security_group.efs_sg.id
}

# Output subnet ID for Lambda to create mount targets
output "efs_subnet_id" {
  description = "Primary subnet ID for EFS mount targets"
  value       = aws_subnet.gpu_dev_subnet.id
}