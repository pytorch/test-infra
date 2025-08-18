# Variables for GPU Developer Servers

variable "aws_region" {
  description = "AWS region for GPU dev servers"
  type        = string
  default     = "us-east-2"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "dev"
}

variable "prefix" {
  description = "Prefix for resource names"
  type        = string
  default     = "pytorch-gpu-dev"
}

variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR block for subnet"
  type        = string
  default     = "10.0.1.0/24"
}

variable "gpu_instance_count" {
  description = "Number of GPU instances to provision"
  type        = number
  default     = 2 # Start with 2 for testing, scale to 5 for production
  # default     = 5  # Production setup
}

variable "use_self_managed_nodes" {
  description = "Use self-managed ASG instead of EKS managed node group (faster for development)"
  type        = bool
  default     = true # false = managed (production), true = self-managed (development)
}

variable "instance_type" {
  description = "EC2 instance type for GPU servers"
  type        = string
  # default     = "g4dn.12xlarge" # Testing multi-GPU: 4x T4 GPU, ~$3.91/hour
  # default     = "g5.2xlarge"    # Mid-range: 1x A10G GPU, ~$1.21/hour  
  default = "p4d.24xlarge" # Production: 8x A100 GPUs, ~$24.77/hour
  # default     = "p5.48xlarge"   # Production: 8x H100 GPUs, ~$55/hour
  # default     = "p6-b200.48xlarge" # Latest: 8x B200 GPUs, ~$114/hour

  validation {
    condition = contains([
      "g4dn.xlarge",     # 1x T4, ~$0.53/hour (cheapest)
      "g4dn.2xlarge",    # 1x T4, ~$0.75/hour
      "g4dn.4xlarge",    # 1x T4, ~$1.20/hour
      "g4dn.8xlarge",    # 1x T4, ~$2.18/hour
      "g4dn.12xlarge",   # 4x T4, ~$3.91/hour
      "g4dn.16xlarge",   # 1x T4, ~$4.35/hour
      "g5.xlarge",       # 1x A10G, ~$1.00/hour
      "g5.2xlarge",      # 1x A10G, ~$1.21/hour
      "g5.4xlarge",      # 1x A10G, ~$1.64/hour
      "g5.8xlarge",      # 1x A10G, ~$2.18/hour
      "g5.12xlarge",     # 4x A10G, ~$5.67/hour
      "p3.2xlarge",      # 1x V100, ~$3.06/hour
      "p3.8xlarge",      # 4x V100, ~$12.24/hour
      "p4d.24xlarge",    # 8x A100, ~$24.77/hour
      "p5.48xlarge",     # 8x H100, ~$55/hour
      "p6-b200.48xlarge" # 8x B200, ~$114/hour
    ], var.instance_type)
    error_message = "Instance type must be a supported GPU instance type."
  }
}

variable "key_pair_name" {
  description = "Name of the EC2 Key Pair for SSH access"
  type        = string
  default     = "pet-instances-skeleton-key-v2"
}

variable "github_org" {
  description = "GitHub organization for auth"
  type        = string
  default     = "pytorch"
}

variable "github_repo" {
  description = "GitHub repository for auth"
  type        = string
  default     = "pytorch"
}

variable "metamates_team" {
  description = "GitHub team name for metamates access"
  type        = string
  default     = "metamates"
}

variable "reservation_timeout_hours" {
  description = "Default reservation timeout in hours"
  type        = number
  default     = 8
}

variable "max_reservation_hours" {
  description = "Maximum allowed reservation time in hours"
  type        = number
  default     = 240
}

variable "supported_gpu_types" {
  description = "Map of supported GPU types to their instance configurations"
  type = map(object({
    instance_type     = string
    instance_types    = optional(list(string)) # Multiple instance types for same GPU type
    instance_count    = number
    gpus_per_instance = number
  }))
  default = {
    "h200" = {
      instance_type     = "p5e.48xlarge"                    # Primary: 8x H200 GPUs
      instance_types    = ["p5e.48xlarge", "p5en.48xlarge"] # Both H200 variants
      instance_count    = 2                                 # Total of 2 instances (mix of p5e/p5en)
      gpus_per_instance = 8
    }
    "h100" = {
      instance_type     = "p5.48xlarge" # 8x H100 GPUs
      instance_count    = 2
      gpus_per_instance = 8
    }
    "a100" = {
      instance_type     = "p4d.24xlarge" # 8x A100 GPUs  
      instance_count    = 2
      gpus_per_instance = 8
    }
    "t4" = {
      instance_type     = "g4dn.12xlarge" # 4x T4 GPUs
      instance_count    = 2
      gpus_per_instance = 4
    }
  }
}

variable "queue_message_retention" {
  description = "SQS message retention period in seconds"
  type        = number
  default     = 1209600 # 14 days
}

