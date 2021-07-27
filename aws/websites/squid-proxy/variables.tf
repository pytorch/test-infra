variable "environment_name" {
  description = "The name of the environment"
  default     = "squid_dev"
}

variable "aws_region" {
  description = "AWS region to create the VPC and services"
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "AWS profile to use other than the default"
  default     = "default"
}

variable "vpc_id" {
  description = "vpc id to be used"
}

# NOTE: The key should be available via your SSH agent, use ssh-add to add this key
variable "aws_key_name" {
  description = "AWS key name to use, it must exist in the specified region"
}

variable "aws_private_vpc_cidr" {
  description = "VPC CIDR block range for the public VPC"
  default     = "10.0.0.0/16"
}

variable "squid_port" {
  description = "Squid proxies ELB port"
  default     = 3128
}

# Latest official amazon Linux (x64) ami with
variable "aws_amis" {
  type = map(any)
  default = {
    us-east-1 = "ami-0ff8a91507f77f867"
  }
}
