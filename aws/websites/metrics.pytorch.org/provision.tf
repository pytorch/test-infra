provider "aws" {
  region = "us-east-1"
}

variable "key_name" {
  type = string
}

variable "ami" {
  type = string
  default = "ami-09e67e426f25ce0d7"
}

variable "type" {
  type = string
}

variable "name" {
  type = string
}

variable "size" {
  type = number
  default = 20
}

resource "aws_vpc" "gh_ci" {
  # imported from AWS
  cidr_block = "10.0.0.0/16"

  tags = {
    Name = "gh-ci-vpc"
  }
}

resource "aws_security_group" "metrics" {
  vpc_id = aws_vpc.gh_ci.id
  name = "${var.name}_ports"
  egress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "metrics_ec2_instances" {
  count = 1
  ami = var.ami
  instance_type = var.type
  subnet_id = "${aws_vpc.gh_ci.subnets[0]}"
  vpc_security_group_ids = [aws_security_group.metrics.id]
  key_name = var.key_name
  associate_public_ip_address = true

  tags = {
    Name = "${var.name}"
  }

  root_block_device {
    volume_size = var.size
  }
}

output "cluster_names" {
  value = ["${aws_instance.metrics_ec2_instances.*.tags.Name}"]
}

output "cluster_dns" {
  value = ["${aws_instance.metrics_ec2_instances.*.public_dns}"]
}