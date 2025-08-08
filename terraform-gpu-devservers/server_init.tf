# Initialize GPU servers table with current EKS nodes
# This populates the servers table when Terraform runs

# Lambda function to initialize server state
resource "aws_lambda_function" "server_initializer" {
  filename         = "${path.module}/lambda/server_initializer.zip"
  function_name    = "${var.prefix}-server-initializer"
  role            = aws_iam_role.server_initializer_role.arn
  handler         = "index.handler"
  runtime         = "python3.13"
  timeout         = 60
  source_code_hash = data.archive_file.server_initializer_zip.output_base64sha256

  environment {
    variables = {
      SERVERS_TABLE    = aws_dynamodb_table.gpu_servers.name
      EKS_CLUSTER_NAME = aws_eks_cluster.gpu_dev_cluster.name
      REGION          = var.aws_region
    }
  }

  depends_on = [
    aws_iam_role_policy.server_initializer_policy,
    data.archive_file.server_initializer_zip,
  ]

  tags = {
    Name        = "${var.prefix}-server-initializer"
    Environment = var.environment
  }
}

# IAM role for server initializer
resource "aws_iam_role" "server_initializer_role" {
  name = "${var.prefix}-server-initializer-role"

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
    Name        = "${var.prefix}-server-initializer-role"
    Environment = var.environment
  }
}

# IAM policy for server initializer
resource "aws_iam_role_policy" "server_initializer_policy" {
  name = "${var.prefix}-server-initializer-policy"
  role = aws_iam_role.server_initializer_role.id

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
          "dynamodb:Scan"
        ]
        Resource = [
          aws_dynamodb_table.gpu_servers.arn,
          "${aws_dynamodb_table.gpu_servers.arn}/index/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "eks:DescribeCluster",
          "eks:DescribeNodegroup",
          "eks:ListNodegroups"
        ]
        Resource = [
          aws_eks_cluster.gpu_dev_cluster.arn,
          "arn:aws:eks:${var.aws_region}:${data.aws_caller_identity.current.account_id}:nodegroup/${aws_eks_cluster.gpu_dev_cluster.name}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "ec2:DescribeInstances",
          "ec2:DescribeLaunchTemplates",
          "ec2:DescribeLaunchTemplateVersions"
        ]
        Resource = "*"
      }
    ]
  })
}

# Create zip file for server initializer
data "archive_file" "server_initializer_zip" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/server_initializer"
  output_path = "${path.module}/lambda/server_initializer.zip"
  excludes    = []
}

# Invoke the lambda after EKS cluster is ready
resource "aws_lambda_invocation" "initialize_servers" {
  function_name = aws_lambda_function.server_initializer.function_name

  input = jsonencode({
    action = "initialize"
  })

  depends_on = [
    aws_eks_cluster.gpu_dev_cluster,
    aws_eks_node_group.gpu_dev_nodes,
    aws_dynamodb_table.gpu_servers
  ]

  # This ensures the lambda runs whenever the cluster or nodes change
  triggers = {
    cluster_version    = aws_eks_cluster.gpu_dev_cluster.version
    cluster_endpoint   = aws_eks_cluster.gpu_dev_cluster.endpoint
    node_group_version = aws_eks_node_group.gpu_dev_nodes.version
    node_group_status  = aws_eks_node_group.gpu_dev_nodes.status
    scaling_config     = jsonencode(aws_eks_node_group.gpu_dev_nodes.scaling_config)
    timestamp         = timestamp()
  }
}