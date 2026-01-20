# Docker Build Infrastructure
# ECR repository for storing built images
# IAM roles for BuildKit jobs

# ECR repository for custom images
resource "aws_ecr_repository" "gpu_dev_custom_images" {
  name                 = "gpu-dev-custom-images"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name        = "GPU Dev Custom Images"
    Environment = local.current_config.environment
  }
}

# ECR lifecycle policy to cleanup old images
resource "aws_ecr_lifecycle_policy" "gpu_dev_custom_images" {
  repository = aws_ecr_repository.gpu_dev_custom_images.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# Data source for existing Docker Hub secret
data "aws_secretsmanager_secret" "dockerhub_credentials" {
  name = "ecr-pullthroughcache/docker-hub"
}

# ECR Pull-Through Cache for Docker Hub (with authentication)
resource "aws_ecr_pull_through_cache_rule" "dockerhub" {
  ecr_repository_prefix = "dockerhub"
  upstream_registry_url = "registry-1.docker.io"
  credential_arn        = data.aws_secretsmanager_secret.dockerhub_credentials.arn
}

# Data source for EKS cluster OIDC issuer
data "tls_certificate" "eks_oidc" {
  url = aws_eks_cluster.gpu_dev_cluster.identity[0].oidc[0].issuer
}

# OIDC Identity Provider for EKS
resource "aws_iam_openid_connect_provider" "eks" {
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks_oidc.certificates[0].sha1_fingerprint]
  url             = aws_eks_cluster.gpu_dev_cluster.identity[0].oidc[0].issuer

  tags = {
    Name        = "EKS OIDC Provider"
    Environment = local.current_config.environment
  }
}

# IAM role for BuildKit jobs (IRSA)
resource "aws_iam_role" "buildkit_job_role" {
  name = "gpu-dev-buildkit-job-role-${local.current_config.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.eks.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "${replace(aws_iam_openid_connect_provider.eks.url, "https://", "")}:sub" = "system:serviceaccount:gpu-dev:buildkit-service-account"
            "${replace(aws_iam_openid_connect_provider.eks.url, "https://", "")}:aud" = "sts.amazonaws.com"
          }
        }
      }
    ]
  })

  tags = {
    Name        = "GPU Dev BuildKit Job Role"
    Environment = local.current_config.environment
  }
}

# IAM policy for BuildKit jobs
resource "aws_iam_role_policy" "buildkit_job_policy" {
  name = "gpu-dev-buildkit-job-policy"
  role = aws_iam_role.buildkit_job_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:GetAuthorizationToken",
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload"
        ]
        Resource = "*"
      }
    ]
  })
}

# Service account for BuildKit jobs
resource "kubernetes_service_account" "buildkit" {
  metadata {
    name      = "buildkit-service-account"
    namespace = kubernetes_namespace.gpu_dev.metadata[0].name
    annotations = {
      "eks.amazonaws.com/role-arn" = aws_iam_role.buildkit_job_role.arn
    }
  }

  depends_on = [aws_autoscaling_group.cpu_nodes]
}

# Output values for Lambda environment variables
output "ecr_repository_url" {
  description = "ECR repository URL for custom images"
  value       = aws_ecr_repository.gpu_dev_custom_images.repository_url
}

output "ecr_pull_through_cache_urls" {
  description = "ECR pull-through cache registry URLs"
  value = {
    dockerhub = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${local.current_config.aws_region}.amazonaws.com/dockerhub"
  }
}