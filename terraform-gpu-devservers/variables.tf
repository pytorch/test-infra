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
  default     = 2  # Start with 2 for testing, scale to 5 for production
  # default     = 5  # Production setup
}

variable "instance_type" {
  description = "EC2 instance type for GPU servers"
  type        = string
  default     = "g4dn.2xlarge"  # Cheap for testing: 1x T4 GPU, ~$0.75/hour
  # default     = "g5.2xlarge"    # Mid-range: 1x A10G GPU, ~$1.21/hour  
  # default     = "p5.48xlarge"   # Production: 8x H100 GPUs, ~$98/hour
  
  validation {
    condition = contains([
      "g4dn.xlarge",     # 1x T4, ~$0.53/hour (cheapest)
      "g4dn.2xlarge",    # 1x T4, ~$0.75/hour
      "g4dn.4xlarge",    # 1x T4, ~$1.20/hour
      "g5.xlarge",       # 1x A10G, ~$1.00/hour
      "g5.2xlarge",      # 1x A10G, ~$1.21/hour
      "g5.4xlarge",      # 1x A10G, ~$1.64/hour
      "g5.8xlarge",      # 1x A10G, ~$2.18/hour
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
  default     = 24
}

variable "queue_visibility_timeout" {
  description = "SQS queue visibility timeout in seconds"
  type        = number
  default     = 300
}

variable "queue_message_retention" {
  description = "SQS message retention period in seconds"
  type        = number
  default     = 1209600  # 14 days
}

