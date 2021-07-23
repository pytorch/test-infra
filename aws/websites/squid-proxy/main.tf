provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile
}

data "aws_subnet_ids" "dev" {
  vpc_id = var.vpc_id
}

resource "aws_security_group" "sg" {
  name   = "${var.environment_name}_sg"
  vpc_id = var.vpc_id

  # Squid proxy port
  ingress {
    from_port   = var.squid_port
    to_port     = var.squid_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.environment_name}_sg"
  }
}

module "squid" {
  source                = "./squid"
  environment_name      = var.environment_name
  aws_key_name          = var.aws_key_name
  aws_region            = var.aws_region
  aws_profile           = var.aws_profile
  aws_security_group_id = aws_security_group.sg.id
  aws_subnet_ids        = [tolist(data.aws_subnet_ids.dev.ids)[0]]
  aws_ami               = lookup(var.aws_amis, var.aws_region)
  aws_public_vpc_cidr   = var.aws_public_vpc_cidr
  squid_port            = var.squid_port
}
