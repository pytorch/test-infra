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
  default = "t2.micro"
}

variable "name" {
  type = string
}

variable "size" {
  type = number
  default = 20
}

variable "num" {
  type = number
  default = 1
}

resource "aws_security_group" "ec2_security_group" {
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

resource "aws_instance" "ec2_instances" {
  count = var.num
  ami = var.ami
  instance_type = var.type
  vpc_security_group_ids = [aws_security_group.ec2_security_group.id]
  key_name = var.key_name

  tags = {
    Name = "${var.name}-${count.index}"
  }

  root_block_device {
    volume_size = var.size
  }
}

output "cluster_names" {
  value = ["${aws_instance.ec2_instances.*.tags.Name}"]
}

output "cluster_dns" {
  value = ["${aws_instance.ec2_instances.*.public_dns}"]
}
