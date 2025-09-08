# GPU Developer Servers Infrastructure
# Default: us-west-1 with 2x T4 instances (test environment)
# Production: Use -var-file="prod.tfvars" for us-east-2 with A100 instances

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
  region = local.current_config.aws_region
}

# Configure Kubernetes provider to use the EKS cluster (back to original approach for now)
provider "kubernetes" {
  host                   = aws_eks_cluster.gpu_dev_cluster.endpoint
  cluster_ca_certificate = base64decode(aws_eks_cluster.gpu_dev_cluster.certificate_authority[0].data)
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", aws_eks_cluster.gpu_dev_cluster.name, "--region", local.current_config.aws_region]
  }
}

# Data sources
data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

# Create workspace-specific prefix for global resources (IAM roles, etc.)
locals {
  workspace_prefix = "${var.prefix}-${terraform.workspace}"

  # Workspace-specific configurations
  workspace_configs = {
    default = {
      aws_region = "us-west-1"
      environment = "test"
      gpu_instance_count = 2
      use_self_managed_nodes = true
      instance_type = "g4dn.12xlarge"
      supported_gpu_types = {
        "h100" = {
          instance_type       = "p5.48xlarge"
          instance_types      = null
          instance_count      = 2
          gpus_per_instance   = 8
          use_placement_group = true
        }
        "t4" = {
          instance_type       = "g4dn.12xlarge"
          instance_types      = null
          instance_count      = 2
          gpus_per_instance   = 4
          use_placement_group = true
        }
        "t4-small" = {
          instance_type       = "g4dn.2xlarge"
          instance_types      = null
          instance_count      = 1
          gpus_per_instance   = 1
          use_placement_group = false
        }
      }
    }
    prod = {
      aws_region = "us-east-2"
      environment = "prod"
      gpu_instance_count = 2
      use_self_managed_nodes = true
      instance_type = "p4d.24xlarge"
      supported_gpu_types = {
        "b200" = {
          instance_type       = "p6-b200.48xlarge"
          instance_types      = null
          instance_count      = 2
          gpus_per_instance   = 8
          use_placement_group = false
        }
        "h200" = {
          instance_type       = "p5e.48xlarge"
          instance_types      = ["p5e.48xlarge", "p5en.48xlarge"]
          instance_count      = 2
          gpus_per_instance   = 8
          use_placement_group = false
        }
        "h100" = {
          instance_type       = "p5.48xlarge"
          instance_types      = null
          instance_count      = 2
          gpus_per_instance   = 8
          use_placement_group = false
        }
        "a100" = {
          instance_type       = "p4d.24xlarge"
          instance_types      = null
          instance_count      = 2
          gpus_per_instance   = 8
          use_placement_group = false
        }
        "t4" = {
          instance_type       = "g4dn.12xlarge"
          instance_types      = null
          instance_count      = 2
          gpus_per_instance   = 4
          use_placement_group = true
        }
        "l4" = {
          instance_type       = "g6.12xlarge"
          instance_types      = null
          instance_count      = 2
          gpus_per_instance   = 4  # 4x L4 GPUs
          use_placement_group = false
        }
      }
    }
  }

  # Current workspace configuration
  current_config = local.workspace_configs[terraform.workspace]

  # Workspace-specific capacity reservations
  capacity_reservations = {
    default = {
      # Test environment capacity reservations - 2x H100 in us-west-1c
      h100 = "cr-09f598e08ec509a0f"
    }
    prod = {
      # Production environment capacity reservations
      h100 = "cr-003773252aa2ea59a"
      b200 = "cr-0e2d0247fafbd380a"
    }
  }

  # Workspace-specific GPU type to subnet mappings
  gpu_subnet_assignments = {
    default = {
      # Test environment - H100 in us-west-1c (secondary subnet)
      h100 = "secondary"
      t4 = "primary"
      "t4-small" = "secondary"
    }
    prod = {
      # Production environment subnet assignments
      b200 = "secondary"
      h200 = "primary"
      h100 = "primary"
      a100 = "primary"
      t4 = "primary"
      l4 = "secondary"
    }
  }
}


# VPC Configuration
resource "aws_vpc" "gpu_dev_vpc" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "${var.prefix}-gpu-dev-vpc"
    Environment = local.current_config.environment
  }
}

# Internet Gateway
resource "aws_internet_gateway" "gpu_dev_igw" {
  vpc_id = aws_vpc.gpu_dev_vpc.id

  tags = {
    Name        = "${var.prefix}-gpu-dev-igw"
    Environment = local.current_config.environment
  }
}

# Primary subnet for EFA requirements (GPU nodes)
resource "aws_subnet" "gpu_dev_subnet" {
  vpc_id                  = aws_vpc.gpu_dev_vpc.id
  cidr_block              = var.subnet_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = {
    Name                                          = "${var.prefix}-gpu-dev-subnet"
    Environment                                   = local.current_config.environment
    "kubernetes.io/cluster/${var.prefix}-cluster" = "shared"
    "kubernetes.io/role/elb"                      = "1"
  }
}

# Secondary subnet for EKS control plane (different AZ)
resource "aws_subnet" "gpu_dev_subnet_secondary" {
  vpc_id                  = aws_vpc.gpu_dev_vpc.id
  cidr_block              = "10.0.4.0/24"
  availability_zone       = data.aws_availability_zones.available.names[1] # us-east-2b for control plane diversity
  map_public_ip_on_launch = true

  tags = {
    Name                                          = "${var.prefix}-gpu-dev-subnet-secondary"
    Environment                                   = local.current_config.environment
    "kubernetes.io/cluster/${var.prefix}-cluster" = "shared"
    "kubernetes.io/role/elb"                      = "1"
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
    Environment = local.current_config.environment
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
    Environment = local.current_config.environment
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
    Environment = local.current_config.environment
  }
}

# Cluster Placement Groups - one per GPU type that needs placement groups
resource "aws_placement_group" "gpu_dev_pg" {
  for_each = {
    for gpu_type, config in local.current_config.supported_gpu_types : gpu_type => config
    if config.use_placement_group
  }

  name     = "${local.workspace_prefix}-gpu-${each.key}-cluster"
  strategy = "cluster"
  
  # Note: Placement group AZ will be determined by first instance launched

  tags = {
    Name        = "${local.workspace_prefix}-gpu-${each.key}-cluster"
    Environment = local.current_config.environment
    GpuType     = each.key
  }
}
