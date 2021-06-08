provider "aws" {
    region = "us-east-1"
}

variable "key_name" {
  type = string
}

resource "aws_security_group" "monitoring_ports" {
  name = "monitoring.pytorch.org_ports"
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "cluster_machine" {
    count = 1
    ami = "ami-09e67e426f25ce0d7"
    instance_type = "t2.xlarge"
    vpc_security_group_ids = [aws_security_group.monitoring_ports.id]
    key_name = var.key_name

    tags = {
        Name = "monitoring.pytorch.org"
    }

    root_block_device {
      volume_size = "50"
    }
}

output "cluster_names" {
  value = ["${aws_instance.cluster_machine.*.tags.Name}"]
}

output "cluster_dns" {
  value = ["${aws_instance.cluster_machine.*.public_dns}"]
}