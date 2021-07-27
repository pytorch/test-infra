variable "environment_name" {
  description = "The name of the environment"
}

variable "aws_region" {
  description = "AWS region to create the VPC and services"
}

variable "aws_profile" {
  description = "AWS profile to use other than the default"
  default     = "default"
}

variable "aws_key_name" {
  description = "AWS key name to use, it must exist in the specified region"
}

variable "aws_security_group_id" {
  description = "AWS security group ID that the instances will be bound to"
}

variable "aws_subnet_ids" {
  description = "AWS subnet IDs that the launch configuration will use"
  type        = list
}

variable "aws_ami" {
  description = "AWS AMI to use for the squid proxy hosts"
}

variable "aws_instance_type" {
  description = "The EC2 instance type"
  default     = "t3.medium"
}

variable "aws_asg_min_size" {
  description = "Auto scale group minimum size"
  default     = 1
}

variable "aws_asg_max_size" {
  description = "Auto scale group maximum size"
  default     = 3
}

variable "aws_private_vpc_cidr" {
  description = "VPC CIDR block range for the private VPC"
}

variable "squid_port" {
  description = "Squid proxies ELB port"
}

variable "disk_size" {
  description = "disk size of the instances in MB, also the same as the squid cache size"
  default = 150000
}

variable "maximum_object_size" {
  description = "maximum_object_size cache object size in MB"
  default = 20000
}
