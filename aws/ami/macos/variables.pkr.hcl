variable "skip_create_ami" {
  type    = bool
  default = true
}

variable "macos_version" {
  type        = string
  description = "macOS version prefix used to filter the base AMI (e.g. \"14\", \"14.8\", \"15\")."
}

variable "instance_type" {
  type        = string
  description = "EC2 Mac instance type. mac2.metal (M1) is the cheapest arm64 host; the resulting AMI runs on every Apple Silicon Mac family."
  default     = "mac2.metal"
}

variable "host_id" {
  type        = string
  description = "ID of a pre-allocated EC2 Dedicated Host (h-xxxxxxxx) to launch the builder instance on. Required for Mac instances."
}

variable "availability_zone" {
  type        = string
  description = "AZ to launch the builder instance in. Must match the AZ of the dedicated host."
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "ami_regions" {
  type        = list(string)
  description = "Regions the AMI will be registered in. The build region (var.region) is always implicit; including it here is a no-op. Packer issues CopyImage to each non-build region after registration."
  default     = ["us-east-1", "us-east-2"]
}

variable "root_volume_size_gb" {
  type    = number
  default = 200
}
