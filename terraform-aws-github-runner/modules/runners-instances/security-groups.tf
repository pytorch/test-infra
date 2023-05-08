locals {
    name_sg = var.overrides["name_sg"] == "" ? local.tags["Name"] : var.overrides["name_sg"]
}

resource "aws_security_group" "runners_sg" {
  count       = length(var.vpc_ids)
  name_prefix = "${var.environment}-github-actions-runner-sg-${count.index}"
  description = "Github Actions Runner security group"
  vpc_id      = element(var.vpc_ids, count.index).vpc

  egress {
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
  tags = merge(
    local.tags,
    {
      "Name" = format("%s", local.name_sg)
    },
  )
}
