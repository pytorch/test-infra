# GPU Developer Servers Infrastructure
# Region: us-east-2
# Target: 5x p5.48xlarge instances with EKS + queue system

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
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
    Name        = "${var.prefix}-gpu-dev-subnet"
    Environment = var.environment
  }
}

# Secondary subnet for EKS control plane (different AZ)
resource "aws_subnet" "gpu_dev_subnet_secondary" {
  vpc_id                  = aws_vpc.gpu_dev_vpc.id
  cidr_block              = "10.0.2.0/24"
  availability_zone       = data.aws_availability_zones.available.names[1]
  map_public_ip_on_launch = true

  tags = {
    Name        = "${var.prefix}-gpu-dev-subnet-secondary"
    Environment = var.environment
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