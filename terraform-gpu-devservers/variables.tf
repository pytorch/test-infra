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
  default     = 5
}

variable "instance_type" {
  description = "EC2 instance type for GPU servers"
  type        = string
  default     = "p5.48xlarge"
}

variable "key_pair_name" {
  description = "Name of the EC2 Key Pair for SSH access"
  type        = string
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