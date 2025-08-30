# ECR Repository for custom GPU dev server image
resource "aws_ecr_repository" "gpu_dev_image" {
  name         = "${var.prefix}-gpu-dev-image"
  force_delete = true

  image_tag_mutability = "MUTABLE"

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name        = "${var.prefix}-gpu-dev-image"
    Environment = local.current_config.environment
  }
}

# ECR Repository Policy to allow EKS nodes to pull
resource "aws_ecr_repository_policy" "gpu_dev_image_policy" {
  repository = aws_ecr_repository.gpu_dev_image.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowEKSNodesPull"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_role.eks_node_role.arn
        }
        Action = [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:BatchCheckLayerAvailability"
        ]
      }
    ]
  })
}

# ECR Lifecycle Policy to clean up old images
resource "aws_ecr_lifecycle_policy" "gpu_dev_image_lifecycle" {
  repository = aws_ecr_repository.gpu_dev_image.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 5 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 5
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# Local to determine if we need to build and push
locals {
  # Get all files in docker directory and create a hash
  docker_files = fileset("${path.module}/docker", "**/*")
  # Create hash from all file contents
  docker_context_hash = md5(join("", [
    for file in local.docker_files : filemd5("${path.module}/docker/${file}")
  ]))

  ecr_repository_url  = aws_ecr_repository.gpu_dev_image.repository_url
  image_tag          = "latest-${substr(local.docker_context_hash, 0, 8)}"
  full_image_uri     = "${local.ecr_repository_url}:${local.image_tag}"
}

# Docker build and push using null_resource with proper architecture handling
resource "null_resource" "docker_build_and_push" {
  # Trigger rebuild when Docker context changes
  triggers = {
    docker_context_hash = local.docker_context_hash
    ecr_repository_url  = local.ecr_repository_url
  }

  # Local provisioner to build and push Docker image
  provisioner "local-exec" {
    command = <<-EOF
      set -e

      echo "Building and pushing Docker image..."

      # Get current architecture
      ARCH=$(uname -m)
      echo "Detected architecture: $ARCH"

      # Set platform for Docker build
      if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
        PLATFORM="linux/amd64"
        echo "Building for linux/amd64 platform (cross-compilation from $ARCH)"
      else
        PLATFORM="linux/amd64" 
        echo "Building for linux/amd64 platform"
      fi

      # Change to docker directory
      cd ${path.module}/docker

      # Login to ECR
      echo "Logging into ECR..."
      aws ecr get-login-password --region ${local.current_config.aws_region} | docker login --username AWS --password-stdin ${local.ecr_repository_url}

      # Build image with correct platform
      echo "Building Docker image for platform: $PLATFORM"
      docker build --platform=$PLATFORM -t ${local.full_image_uri} .

      # Also tag as latest
      docker tag ${local.full_image_uri} ${local.ecr_repository_url}:latest

      # Push both tags
      echo "Pushing Docker image..."
      docker push ${local.full_image_uri}
      docker push ${local.ecr_repository_url}:latest

      echo "Docker image successfully built and pushed!"
      echo "Image URI: ${local.full_image_uri}"
    EOF

    working_dir = path.module
  }

  # Ensure ECR repository exists before building
  depends_on = [
    aws_ecr_repository.gpu_dev_image,
    aws_ecr_repository_policy.gpu_dev_image_policy
  ]
}

# Output the image URI for use in other resources
output "gpu_dev_image_uri" {
  value       = local.full_image_uri
  description = "URI of the custom GPU dev server Docker image"
  depends_on  = [null_resource.docker_build_and_push]
}