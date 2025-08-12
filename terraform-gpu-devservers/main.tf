# GPU Developer Servers Infrastructure
# Region: us-east-2
# Target: 5x p5.48xlarge instances with EKS + queue system

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.23"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# Configure Kubernetes provider to use the EKS cluster
provider "kubernetes" {
  host                   = aws_eks_cluster.gpu_dev_cluster.endpoint
  cluster_ca_certificate = base64decode(aws_eks_cluster.gpu_dev_cluster.certificate_authority[0].data)
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", aws_eks_cluster.gpu_dev_cluster.name, "--region", var.aws_region]
  }
}

# Data sources
data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

# VPC Configuration
resource "aws_vpc" "gpu_dev_vpc" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "${var.prefix}-gpu-dev-vpc"
    Environment = var.environment
  }
}

# Internet Gateway
resource "aws_internet_gateway" "gpu_dev_igw" {
  vpc_id = aws_vpc.gpu_dev_vpc.id

  tags = {
    Name        = "${var.prefix}-gpu-dev-igw"
    Environment = var.environment
  }
}

# Primary subnet for EFA requirements (GPU nodes)
resource "aws_subnet" "gpu_dev_subnet" {
  vpc_id                  = aws_vpc.gpu_dev_vpc.id
  cidr_block              = var.subnet_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = {
    Name                                        = "${var.prefix}-gpu-dev-subnet"
    Environment                                 = var.environment
    "kubernetes.io/cluster/${var.prefix}-cluster" = "shared"
    "kubernetes.io/role/elb"                    = "1"
  }
}

# Secondary subnet for EKS control plane (different AZ)
resource "aws_subnet" "gpu_dev_subnet_secondary" {
  vpc_id                  = aws_vpc.gpu_dev_vpc.id
  cidr_block              = "10.0.2.0/24"
  availability_zone       = data.aws_availability_zones.available.names[1]
  map_public_ip_on_launch = true

  tags = {
    Name                                        = "${var.prefix}-gpu-dev-subnet-secondary"
    Environment                                 = var.environment
    "kubernetes.io/cluster/${var.prefix}-cluster" = "shared"
    "kubernetes.io/role/elb"                    = "1"
  }
}

# Route table
resource "aws_route_table" "gpu_dev_rt" {
  vpc_id = aws_vpc.gpu_dev_vpc.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.gpu_dev_igw.id
  }

  tags = {
    Name        = "${var.prefix}-gpu-dev-rt"
    Environment = var.environment
  }
}

resource "aws_route_table_association" "gpu_dev_rta" {
  subnet_id      = aws_subnet.gpu_dev_subnet.id
  route_table_id = aws_route_table.gpu_dev_rt.id
}

resource "aws_route_table_association" "gpu_dev_rta_secondary" {
  subnet_id      = aws_subnet.gpu_dev_subnet_secondary.id
  route_table_id = aws_route_table.gpu_dev_rt.id
}

# Security Groups

# Control plane security group
resource "aws_security_group" "eks_control_plane_sg" {
  name        = "${var.prefix}-eks-control-plane-sg"
  description = "Security group for EKS control plane"
  vpc_id      = aws_vpc.gpu_dev_vpc.id

  # Allow inbound HTTPS from worker nodes (VPC CIDR)
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.gpu_dev_vpc.cidr_block]
    description = "HTTPS from worker nodes"
  }

  # Allow all outbound traffic
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "${var.prefix}-eks-control-plane-sg"
    Environment = var.environment
  }
}

resource "aws_security_group" "gpu_dev_sg" {
  name        = "${var.prefix}-gpu-dev-sg"
  description = "Security group for GPU development servers"
  vpc_id      = aws_vpc.gpu_dev_vpc.id

  # SSH access
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # NodePort range for SSH services to pods
  ingress {
    from_port   = 30000
    to_port     = 32767
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Kubernetes NodePort range for pod SSH access"
  }

  # Kubelet API for logs/exec/port-forward
  ingress {
    from_port   = 10250
    to_port     = 10250
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.gpu_dev_vpc.cidr_block]
    description = "Kubelet API access from EKS control plane"
  }

  # HTTPS outbound to EKS control plane for CoreDNS and other system pods
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.gpu_dev_vpc.cidr_block]
    description = "HTTPS access to EKS control plane"
  }

  # DNS resolution for pods
  ingress {
    from_port   = 53
    to_port     = 53
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.gpu_dev_vpc.cidr_block]
    description = "DNS TCP access within VPC"
  }

  ingress {
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = [aws_vpc.gpu_dev_vpc.cidr_block]
    description = "DNS UDP access within VPC"
  }

  # All traffic within VPC for EFA
  ingress {
    from_port = 0
    to_port   = 65535
    protocol  = "tcp"
    self      = true
  }

  # All outbound traffic
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "${var.prefix}-gpu-dev-sg"
    Environment = var.environment
  }
}

# Cluster Placement Group for optimal networking
resource "aws_placement_group" "gpu_dev_pg" {
  name     = "${var.prefix}-gpu-dev-cluster"
  strategy = "cluster"

  tags = {
    Name        = "${var.prefix}-gpu-dev-cluster"
    Environment = var.environment
  }
}